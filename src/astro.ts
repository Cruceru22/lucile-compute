/**
 * Core astrological primitives: body computation, signs, house assignment,
 * and aspect detection. All angles are in degrees.
 */
import type {
  Aspect,
  AspectType,
  House,
  HouseSystem,
  Planet,
  PlanetName,
  ZodiacSign,
} from '@astroapp/shared';
import { calcFlags, constants, houseFlags, sweph } from './ephemeris.js';

/** Zodiac signs in order; index = floor(absoluteDegree / 30). */
export const SIGNS: readonly ZodiacSign[] = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

/** Map a shared HouseSystem to the single-character sweph house-system code. */
export function houseSystemCode(system: HouseSystem): string {
  switch (system) {
    case 'placidus':
      return 'P';
    case 'koch':
      return 'K';
    case 'equal':
      return 'E';
    case 'whole_sign':
      return 'W';
  }
}

/** Normalise an angle into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Sign for an absolute ecliptic longitude. */
export function signFor(absoluteDegree: number): ZodiacSign {
  const idx = Math.floor(norm360(absoluteDegree) / 30) % 12;
  // SIGNS has exactly 12 entries and idx is in [0,11]; assert for strict index access.
  return SIGNS[idx] as ZodiacSign;
}

/** Degree within the occupied sign, in [0, 30). */
export function degreeInSign(absoluteDegree: number): number {
  return norm360(absoluteDegree) % 30;
}

/**
 * Bodies we place in a chart, mapped to their sweph body id.
 * North Node uses the **mean** node; Lilith uses the **mean** lunar apogee
 * (Black Moon Lilith), matching Astro-Seek's default.
 *
 * The four major asteroids (Ceres `SE_CERES`=17, Pallas `SE_PALLAS`=18,
 * Juno `SE_JUNO`=19, Vesta `SE_VESTA`=20) — like Chiron — need the Swiss
 * `seas_*.se1` asteroid files; under the Moshier backend they fail to compute
 * and are reported via {@link computeAllBodiesWithMisses} as unavailable.
 */
export const BODIES: ReadonlyArray<{ name: PlanetName; id: number }> = [
  { name: 'Sun', id: constants.SE_SUN },
  { name: 'Moon', id: constants.SE_MOON },
  { name: 'Mercury', id: constants.SE_MERCURY },
  { name: 'Venus', id: constants.SE_VENUS },
  { name: 'Mars', id: constants.SE_MARS },
  { name: 'Jupiter', id: constants.SE_JUPITER },
  { name: 'Saturn', id: constants.SE_SATURN },
  { name: 'Uranus', id: constants.SE_URANUS },
  { name: 'Neptune', id: constants.SE_NEPTUNE },
  { name: 'Pluto', id: constants.SE_PLUTO },
  { name: 'Chiron', id: constants.SE_CHIRON },
  { name: 'NorthNode', id: constants.SE_MEAN_NODE },
  { name: 'Lilith', id: constants.SE_MEAN_APOG },
  { name: 'Ceres', id: constants.SE_CERES },
  { name: 'Pallas', id: constants.SE_PALLAS },
  { name: 'Juno', id: constants.SE_JUNO },
  { name: 'Vesta', id: constants.SE_VESTA },
];

/** A raw position result for one body. */
export interface BodyPosition {
  name: PlanetName;
  /** Ecliptic longitude [0, 360). */
  absoluteDegree: number;
  /** Daily motion in longitude, deg/day (negative when retrograde). */
  speed: number;
}

/**
 * Compute a single body's ecliptic longitude + speed at a given Julian Day (UT).
 * Throws if sweph reports an error (e.g. an `.se1` file is missing).
 *
 * `flags` overrides the default tropical calc flags — pass {@link siderealCalcFlags}
 * (with the sid mode already set, e.g. inside {@link withSidereal}) for a
 * sidereal longitude. Omit for the historical tropical behaviour.
 */
export function computeBody(
  jdUt: number,
  id: number,
  name: PlanetName,
  flags: number = calcFlags(),
): BodyPosition {
  const res = sweph.calc_ut(jdUt, id, flags);
  if (res.flag < 0) {
    throw new Error(`sweph.calc_ut failed for ${name}: ${res.error}`);
  }
  const lon = res.data[0];
  const speed = res.data[3];
  return { name, absoluteDegree: norm360(lon), speed };
}

/**
 * Compute all chart bodies at a Julian Day (UT).
 *
 * Under the built-in Moshier backend, Chiron (and other asteroids) are NOT
 * available — Moshier only covers Sun..Pluto + the lunar nodes/apogee. Asteroid
 * positions need the Swiss `seas_*.se1` files. To keep the service usable
 * without ephemeris files, bodies that fail to compute are omitted here and
 * reported via {@link computeAllBodiesWithMisses}; full Swiss files restore them.
 */
export function computeAllBodies(jdUt: number, flags: number = calcFlags()): BodyPosition[] {
  return computeAllBodiesWithMisses(jdUt, flags).positions;
}

export interface BodiesResult {
  positions: BodyPosition[];
  /** Bodies that could not be computed with the active backend (e.g. Chiron under Moshier). */
  unavailable: PlanetName[];
}

/**
 * Compute all bodies, tolerating bodies unavailable under the active backend.
 * `flags` overrides the calc flags (pass {@link siderealCalcFlags} for sidereal).
 */
export function computeAllBodiesWithMisses(
  jdUt: number,
  flags: number = calcFlags(),
): BodiesResult {
  const positions: BodyPosition[] = [];
  const unavailable: PlanetName[] = [];
  for (const b of BODIES) {
    try {
      positions.push(computeBody(jdUt, b.id, b.name, flags));
    } catch {
      unavailable.push(b.name);
    }
  }
  return { positions, unavailable };
}

/** House cusps + angles for a moment and location. */
export interface HouseResult {
  /** 12 cusp longitudes, index 0 = house 1. */
  cusps: number[];
  ascendant: number;
  midheaven: number;
  /**
   * True when the requested time-based house system (Placidus/Koch) is
   * mathematically degenerate at this latitude — beyond the polar circles
   * `swe_houses_ex` reports a negative flag but still returns a usable Asc/MC
   * and a fallback cusp division. We surface this rather than throwing away an
   * otherwise-valid chart. See ACCURACY/QA reports.
   */
  degraded: boolean;
}

/**
 * Compute house cusps and the Ascendant/MC using `swe_houses_ex`.
 * `data.houses` are the 12 cusps; `data.points[0]` = Asc, `[1]` = MC.
 *
 * High-latitude handling: for time-based systems (Placidus, Koch) above the
 * polar circle the division is undefined and `houses_ex` returns a negative
 * flag — BUT it still fills in a valid Ascendant, MC and a fallback cusp set
 * (Porphyry-like). We accept those (marking the result `degraded`) as long as
 * the angles are finite, matching how professional software degrades instead of
 * failing. We only throw if the output is genuinely unusable (non-finite Asc/MC
 * or fewer than 12 cusps), which would indicate a real error.
 */
export function computeHouses(
  jdUt: number,
  lat: number,
  lon: number,
  system: HouseSystem,
  flags: number = houseFlags(),
): HouseResult {
  const res = sweph.houses_ex(jdUt, flags, lat, lon, houseSystemCode(system));
  const rawAsc = res.data.points[0] as number;
  const rawMc = res.data.points[1] as number;
  const cuspsRaw = res.data.houses as number[];

  const usable =
    Number.isFinite(rawAsc) &&
    Number.isFinite(rawMc) &&
    Array.isArray(cuspsRaw) &&
    cuspsRaw.length >= 12 &&
    cuspsRaw.slice(0, 12).every((c) => Number.isFinite(c));

  if (!usable) {
    throw new Error('sweph.houses_ex failed (no usable Ascendant/MC or cusps)');
  }

  const cusps = cuspsRaw.slice(0, 12).map(norm360);
  return {
    cusps,
    ascendant: norm360(rawAsc),
    midheaven: norm360(rawMc),
    degraded: res.flag < 0,
  };
}

/**
 * Determine which house (1..12) an ecliptic longitude falls into, given the
 * 12 ordered cusps. Works for unequal systems by walking adjacent cusps with
 * wrap-around at 360.
 */
export function houseOf(absoluteDegree: number, cusps: number[]): number {
  const lon = norm360(absoluteDegree);
  for (let i = 0; i < 12; i++) {
    const start = cusps[i] as number;
    const end = cusps[(i + 1) % 12] as number;
    const span = norm360(end - start);
    const offset = norm360(lon - start);
    if (offset < span) return i + 1;
  }
  return 12;
}

/** Build a fully-populated Planet from a body position + house cusps. */
export function toPlanet(pos: BodyPosition, cusps: number[] | null): Planet {
  return {
    name: pos.name,
    sign: signFor(pos.absoluteDegree),
    degree: degreeInSign(pos.absoluteDegree),
    absoluteDegree: pos.absoluteDegree,
    house: cusps ? houseOf(pos.absoluteDegree, cusps) : 0,
    retrograde: pos.speed < 0,
    speed: pos.speed,
  };
}

/** Exact angle (degrees) for each major aspect. */
export const ASPECT_ANGLES: Record<AspectType, number> = {
  conjunction: 0,
  sextile: 60,
  square: 90,
  trine: 120,
  opposition: 180,
};

/**
 * Default maximum orbs (degrees) per aspect. Conjunctions/oppositions get a
 * wider orb than minor majors, matching common professional defaults.
 */
export const DEFAULT_ORBS: Record<AspectType, number> = {
  conjunction: 8,
  opposition: 8,
  trine: 7,
  square: 7,
  sextile: 6,
};

/** Smallest separation between two longitudes, in [0, 180]. */
export function angularSeparation(a: number, b: number): number {
  const diff = Math.abs(norm360(a) - norm360(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Classify the aspect (if any) between two bodies given their longitudes.
 * Returns the matched aspect type and the orb (deviation from exactness), or
 * `null` if no aspect is within orb.
 */
export function matchAspect(
  lonA: number,
  lonB: number,
  orbs: Record<AspectType, number> = DEFAULT_ORBS,
): { type: AspectType; orb: number } | null {
  const sep = angularSeparation(lonA, lonB);
  let best: { type: AspectType; orb: number } | null = null;
  for (const type of Object.keys(ASPECT_ANGLES) as AspectType[]) {
    const orb = Math.abs(sep - ASPECT_ANGLES[type]);
    if (orb <= orbs[type] && (best === null || orb < best.orb)) {
      best = { type, orb };
    }
  }
  return best;
}

/**
 * Is the aspect applying (separation tightening toward exact)?
 * We compare the current angular separation to the separation a small step
 * later using relative speed; if it moves toward the exact angle, it's applying.
 */
export function isApplying(
  lonA: number,
  speedA: number,
  lonB: number,
  speedB: number,
  type: AspectType,
): boolean {
  const exact = ASPECT_ANGLES[type];
  const sepNow = angularSeparation(lonA, lonB);
  const dt = 1 / 24; // one hour
  const sepNext = angularSeparation(lonA + speedA * dt, lonB + speedB * dt);
  const devNow = Math.abs(sepNow - exact);
  const devNext = Math.abs(sepNext - exact);
  return devNext < devNow;
}

/**
 * Major aspects between distinct bodies within one chart.
 * Each unordered pair is reported once.
 */
export function computeAspects(positions: BodyPosition[]): Aspect[] {
  const aspects: Aspect[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i] as BodyPosition;
      const b = positions[j] as BodyPosition;
      const m = matchAspect(a.absoluteDegree, b.absoluteDegree);
      if (!m) continue;
      aspects.push({
        a: a.name,
        b: b.name,
        type: m.type,
        orb: m.orb,
        applying: isApplying(a.absoluteDegree, a.speed, b.absoluteDegree, b.speed, m.type),
      });
    }
  }
  return aspects;
}

/** Build House[] from cusps. */
export function toHouses(cusps: number[]): House[] {
  return cusps.map((cuspDegree, i) => ({
    number: i + 1,
    cuspDegree,
    sign: signFor(cuspDegree),
  }));
}
