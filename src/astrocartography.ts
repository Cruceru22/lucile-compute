/**
 * TASK B7 — Astrocartography (ACG).
 *
 * Astrocartography maps WHERE on Earth each natal planet is "angular" — sitting
 * on one of the four chart angles (Midheaven, Imum Coeli, Ascendant, Descendant)
 * — at the exact birth instant. Relocating to (or visiting) places along a
 * planet's line is said to emphasise that planet's themes. The maths is pure
 * spherical astronomy applied to the FIXED birth moment; only the observer's
 * geographic position varies.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Coordinate + sign conventions (documented because they are the easy thing to
 * get subtly wrong):
 *
 *   - Geographic longitude λ: EAST positive, in (−180, +180]. (Matches BirthData
 *     and the equirectangular map: x ∝ λ.)
 *   - Geographic latitude φ: NORTH positive, in [−90, +90].
 *   - Right ascension RA (α) and declination δ (δ): equatorial, from sweph with
 *     `SEFLG_EQUATORIAL`. RA is returned in DEGREES [0, 360).
 *   - GMST: Greenwich (apparent) sidereal time from `swe_sidtime`, returned in
 *     HOURS; we convert to degrees (×15).
 *   - Hour angle H of a body at longitude λ: H = LST − RA, where the Local
 *     Sidereal Time LST = GMST + λ. So H = GMST + λ − RA. H > 0 ⇒ body is WEST
 *     of the meridian (already culminated, descending toward setting); H < 0 ⇒
 *     EAST of the meridian (rising toward culmination). H = 0 ⇒ on the upper
 *     meridian (culminating = MC).
 *
 * MC / IC lines (a body on the local meridian, H = 0):
 *   0 = GMST + λ − RA  ⇒  λ_MC = RA − GMST   (then normalise to (−180,180]).
 *   The IC is the opposite meridian: λ_IC = λ_MC ± 180 (normalised).
 *   Verified: J2000 noon UTC, Sun RA ≈ 281.28°, GMST ≈ 280.46° ⇒ λ_MC ≈ +0.8°,
 *   i.e. the Sun culminates ~at Greenwich at ~12:00 UTC (local apparent noon),
 *   as expected.
 *
 * AC / DC lines (a body on the horizon). On the horizon the body's altitude is
 * 0, so its hour angle H satisfies the standard rising/setting relation
 *   cos H = −tan φ · tan δ.
 * This is solvable only where |−tan φ · tan δ| ≤ 1 — outside that band (the body
 * is circumpolar or never rises at that latitude) there is NO horizon crossing,
 * so we clip those latitudes out of the line (the curve simply does not exist
 * there). For a solvable φ there are two solutions, H = ±H0 with
 * H0 = acos(−tan φ · tan δ) ∈ [0, 180°]:
 *   - H = +H0  ⇒ body is WEST of meridian ⇒ SETTING ⇒ DESCENDANT.
 *   - H = −H0  ⇒ body is EAST of meridian ⇒ RISING  ⇒ ASCENDANT.
 * From H = GMST + λ − RA we get λ = H + RA − GMST, hence:
 *   λ_DC(φ) = (RA − GMST) + H0(φ)     (setting / Descendant)
 *   λ_AC(φ) = (RA − GMST) − H0(φ)     (rising  / Ascendant)
 * i.e. AC and DC are symmetric about the MC meridian λ_MC = RA − GMST by ±H0.
 *
 * These reduce to the meridian lines as φ → equator only in the degenerate
 * δ = 0 case; in general the AC/DC curves bow away from the MC meridian, which
 * is the familiar astrocartography "hourglass" shape.
 *
 * Unknown birth time: ACG depends on GMST, which advances ~15°/hour, so the
 * whole map slides ~15° east per hour of error. With no exact time the lines are
 * meaningless, so we return `available:false` and NO lines (never fabricated),
 * consistent with how A3/natal degrades houses for unknown-time charts.
 */
import type { BirthData, PlanetName } from '@astroapp/shared';
import { BODIES } from './astro.js';
import { calcFlags, constants, getBackend, sweph, type EphemerisBackend } from './ephemeris.js';
import { resolveBirthInstant } from './time.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Normalise a longitude into the half-open interval (−180, +180]. */
export function normLon180(deg: number): number {
  let x = ((deg % 360) + 360) % 360; // [0, 360)
  if (x > 180) x -= 360; // (−180, 180]
  return x;
}

/** A single sampled point on an Asc/Desc curve. EAST-positive longitude. */
export interface AcgPoint {
  lat: number;
  lon: number;
}

/**
 * One planet's four astrocartography lines.
 *
 * `mc`/`ic` are single geographic longitudes (the meridians where the planet
 * culminates / anti-culminates). `asc`/`dsc` are the rising/setting curves,
 * returned as an ARRAY OF SEGMENTS (each segment a continuous polyline) so the
 * renderer can draw each segment without a stray line streaking across the map
 * at an antimeridian (±180°) wrap. Segments are also split where the curve
 * leaves the solvable latitude band.
 */
export interface PlanetAcgLines {
  planet: PlanetName;
  /** Right ascension used (degrees), for transparency / debugging. */
  ra: number;
  /** Declination used (degrees). */
  dec: number;
  /** Longitude of the Midheaven (culmination) meridian, (−180, 180]. */
  mc: number;
  /** Longitude of the Imum Coeli meridian (opposite the MC), (−180, 180]. */
  ic: number;
  /** Ascendant (rising) curve, split into antimeridian-safe segments. */
  asc: AcgPoint[][];
  /** Descendant (setting) curve, split into antimeridian-safe segments. */
  dsc: AcgPoint[][];
}

/** The full `/astrocartography` response. */
export type AstrocartographyResult =
  | {
      available: true;
      /** GMST at the birth instant, in degrees (transparency). */
      gmst: number;
      /** UTC instant the lines were computed for (ISO). */
      epochUtc: string;
      ephemerisBackend: EphemerisBackend;
      /** Bodies omitted because the active backend lacks them (e.g. Chiron/Moshier). */
      unavailableBodies: PlanetName[];
      lines: PlanetAcgLines[];
    }
  | {
      available: false;
      reason: string;
    };

/** Latitude sampling bounds + step (degrees) for the AC/DC curves. */
export const ACG_LAT_MIN = -75;
export const ACG_LAT_MAX = 75;
export const ACG_LAT_STEP = 1;

/**
 * Equatorial position (RA, Dec) of a body at a Julian Day (UT), in degrees.
 * Reuses the active backend's calc flags + the equatorial flag so RA/Dec come
 * straight from sweph rather than us converting from the ecliptic by hand.
 * Throws (like {@link computeBody}) when the body is unavailable in the backend.
 */
export function equatorialPosition(
  jdUt: number,
  id: number,
  name: PlanetName,
): { ra: number; dec: number } {
  const res = sweph.calc_ut(jdUt, id, calcFlags() | constants.SEFLG_EQUATORIAL);
  if (res.flag < 0) {
    throw new Error(`sweph.calc_ut (equatorial) failed for ${name}: ${res.error}`);
  }
  // With SEFLG_EQUATORIAL: data[0] = RA (deg), data[1] = Dec (deg).
  const ra = ((res.data[0] % 360) + 360) % 360;
  const dec = res.data[1];
  return { ra, dec };
}

/**
 * Split a latitude-ordered polyline into continuous segments wherever
 * consecutive points jump across the antimeridian (a longitude delta > 180°).
 * Each returned segment is safe to draw as one stroke on an equirectangular map.
 */
export function splitAtAntimeridian(points: AcgPoint[]): AcgPoint[][] {
  const segments: AcgPoint[][] = [];
  let current: AcgPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as AcgPoint;
    if (current.length === 0) {
      current.push(p);
      continue;
    }
    const prev = current[current.length - 1] as AcgPoint;
    if (Math.abs(p.lon - prev.lon) > 180) {
      // Wrapped across ±180 — start a new segment.
      segments.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Build the Asc/Desc curves for one body from its (RA, Dec) and the meridian
 * base λ_MC = RA − GMST. Samples latitude from {@link ACG_LAT_MIN} to
 * {@link ACG_LAT_MAX}, skipping latitudes where the horizon equation has no
 * solution (|−tanφ·tanδ| > 1: the body is circumpolar / never rises there).
 * Returns each curve already split into antimeridian-safe segments.
 */
export function horizonCurves(
  ra: number,
  dec: number,
  gmst: number,
): { asc: AcgPoint[][]; dsc: AcgPoint[][] } {
  const lonMc = ra - gmst; // raw (un-normalised) base; we normalise each point
  const tanDec = Math.tan(dec * DEG);
  const ascPts: AcgPoint[] = [];
  const dscPts: AcgPoint[] = [];

  for (let lat = ACG_LAT_MIN; lat <= ACG_LAT_MAX + 1e-9; lat += ACG_LAT_STEP) {
    const cosH = -Math.tan(lat * DEG) * tanDec;
    if (cosH < -1 || cosH > 1) continue; // no horizon crossing at this latitude
    const h0 = Math.acos(cosH) * RAD; // [0, 180]
    // Ascendant (rising, east of meridian): λ = λ_MC − H0.
    ascPts.push({ lat, lon: normLon180(lonMc - h0) });
    // Descendant (setting, west of meridian): λ = λ_MC + H0.
    dscPts.push({ lat, lon: normLon180(lonMc + h0) });
  }

  return {
    asc: splitAtAntimeridian(ascPts),
    dsc: splitAtAntimeridian(dscPts),
  };
}

/** Compute all four ACG lines for one body. */
export function planetLines(
  planet: PlanetName,
  ra: number,
  dec: number,
  gmst: number,
): PlanetAcgLines {
  const mc = normLon180(ra - gmst);
  const ic = normLon180(mc + 180);
  const { asc, dsc } = horizonCurves(ra, dec, gmst);
  return { planet, ra, dec, mc, ic, asc, dsc };
}

/**
 * Compute the full astrocartography map for a birth.
 *
 * Returns `available:false` when the birth time is unknown (ACG is meaningless
 * without an exact time — see the module header). Otherwise returns the four
 * lines per body, degrading bodies the active backend cannot compute (e.g.
 * Chiron under Moshier) exactly like the natal endpoint.
 */
export function computeAstrocartography(birth: BirthData): AstrocartographyResult {
  if (!birth.timeKnown || !birth.time) {
    return {
      available: false,
      reason:
        'Astrocartography needs an exact birth time. The whole map shifts about 15° of longitude per hour, so without a known time the lines would be meaningless.',
    };
  }

  const { resolved } = resolveBirthInstant(birth.date, birth.time, true, birth.tzIana);
  const jdUt = resolved.jdUt;
  // GMST in degrees (swe_sidtime returns hours).
  const gmst = (((sweph.sidtime(jdUt) * 15) % 360) + 360) % 360;

  const lines: PlanetAcgLines[] = [];
  const unavailableBodies: PlanetName[] = [];
  for (const b of BODIES) {
    try {
      const { ra, dec } = equatorialPosition(jdUt, b.id, b.name);
      lines.push(planetLines(b.name, ra, dec, gmst));
    } catch {
      unavailableBodies.push(b.name);
    }
  }

  return {
    available: true,
    gmst,
    epochUtc: resolved.utc,
    ephemerisBackend: getBackend(),
    unavailableBodies,
    lines,
  };
}
