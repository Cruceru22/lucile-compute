/**
 * Relationship charts: composite (midpoint) and Davison (time-space midpoint).
 *
 * Both reduce TWO people's birth data to a SINGLE chart, but with different
 * methods, so they answer different questions:
 *
 *  - A **composite** chart is a mathematical abstraction: it has no moment or
 *    place in the real world. For each body we take the MIDPOINT of the two
 *    people's longitudes for that body. It describes the relationship as an
 *    emergent "third entity" built from the two psyches.
 *
 *  - A **Davison** chart is a REAL chart for a REAL moment and place: the
 *    temporal midpoint of the two birth instants, computed at the geographic
 *    midpoint of the two birthplaces. Because it is an actual natal computation,
 *    it has genuine, internally-consistent houses and planetary speeds.
 *
 * Everything here REUSES the existing A3 compute internals (`astro.ts`,
 * `time.ts`, `natal.ts`) — we add no new astronomy, only the two reductions.
 */
import type { Aspect, BirthData, House, NatalChart, Planet, PlanetName } from '@astroapp/shared';
import { DateTime } from 'luxon';
import {
  BODIES,
  computeAllBodiesWithMisses,
  computeAspects,
  norm360,
  signFor,
  degreeInSign,
  toHouses,
  type BodyPosition,
} from './astro.js';
import { computeNatal, type NatalChartResponse } from './natal.js';
import { julianDayToIso, resolveBirthInstant } from './time.js';
import { getBackend, type EphemerisBackend } from './ephemeris.js';

/* -------------------------------------------------------------------------- */
/* Midpoint maths (the only new astrology here)                               */
/* -------------------------------------------------------------------------- */

/**
 * The midpoint of two longitudes ALONG THE SHORTER ARC, in [0, 360).
 *
 * Convention (documented + tested): we walk the SHORTER of the two arcs joining
 * `a` and `b` on the circle and return its centre. Concretely we take the signed
 * delta `b - a` reduced into (-180, 180] and add half of it to `a`. This yields:
 *   - 10° & 50°  → 30°
 *   - 350° & 10° → 0°   (crosses 0° along the 20° short arc, NOT 180°)
 *
 * ANTIPODAL AMBIGUITY: when the two longitudes are exactly 180° apart the two
 * arcs are equal and the midpoint is genuinely ambiguous (either of two
 * diametrically-opposite points). We resolve it DETERMINISTICALLY by treating
 * the delta as +180° (i.e. stepping forward/CCW from `a`), so the result is
 * `a + 90°`. This is a stable, reproducible choice; it is flagged to the caller
 * via {@link CompositeBody.antipodal} so the UI can note the ambiguity.
 */
export function shorterArcMidpoint(a: number, b: number): { midpoint: number; antipodal: boolean } {
  const an = norm360(a);
  const bn = norm360(b);
  // Signed delta in (-180, 180]; +180 chosen for the exactly-antipodal case.
  let delta = norm360(bn - an);
  const antipodal = delta === 180;
  if (delta > 180) delta -= 360;
  return { midpoint: norm360(an + delta / 2), antipodal };
}

/** A composite body: the midpoint longitude of the two people's same-named body. */
export interface CompositeBody {
  name: PlanetName;
  midpoint: number;
  /** The two source longitudes, for transparency. */
  lonA: number;
  lonB: number;
  /** True when the two were exactly antipodal (180°) — midpoint disambiguated. */
  antipodal: boolean;
}

/** Compute the per-body composite midpoints, intersecting the two body sets. */
export function compositeBodies(aBodies: BodyPosition[], bBodies: BodyPosition[]): CompositeBody[] {
  const aByName = new Map<PlanetName, BodyPosition>(aBodies.map((p) => [p.name, p]));
  const bByName = new Map<PlanetName, BodyPosition>(bBodies.map((p) => [p.name, p]));
  const out: CompositeBody[] = [];
  // Iterate in canonical BODIES order so output ordering is stable.
  for (const { name } of BODIES) {
    const pa = aByName.get(name);
    const pb = bByName.get(name);
    if (!pa || !pb) continue; // body unavailable in at least one chart (e.g. Chiron under Moshier)
    const { midpoint, antipodal } = shorterArcMidpoint(pa.absoluteDegree, pb.absoluteDegree);
    out.push({ name, midpoint, lonA: pa.absoluteDegree, lonB: pb.absoluteDegree, antipodal });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Composite chart                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A relationship chart. Reuses the {@link NatalChart} shape so the same client
 * renderer/interpreters work, and adds a discriminant `kind` plus method/meta.
 */
export interface RelationshipChart extends NatalChart {
  kind: 'composite' | 'davison';
  housesAvailable: boolean;
  timeKnown: boolean;
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
}

export interface CompositeChart extends RelationshipChart {
  kind: 'composite';
  /** How the composite longitudes were derived (for transparency). */
  method: {
    longitudes: 'shorter-arc-midpoint';
    houses: 'midpoint-of-ascendants-and-mc' | 'omitted-unknown-time';
  };
  /** Bodies whose midpoint was antipodal (180° apart) and thus disambiguated. */
  antipodalBodies: PlanetName[];
}

/**
 * Build a midpoint composite chart from two people's birth data.
 *
 * Houses: when BOTH births have a known time we derive the composite Ascendant
 * and MC as the shorter-arc midpoints of the two Ascendants and the two MCs
 * respectively, then build EQUAL houses from the composite Ascendant. (Equal
 * houses are the honest default for a composite: a composite has no real moment,
 * so a time-based system like Placidus has no physical meaning here — we make
 * the simplest defensible choice and document it.) If EITHER birth time is
 * unknown, houses are omitted entirely, exactly like A3's unknown-time natal.
 */
export function computeComposite(a: BirthData, b: BirthData): CompositeChart {
  const aResolved = resolveBirthInstant(a.date, a.time, a.timeKnown, a.tzIana);
  const bResolved = resolveBirthInstant(b.date, b.time, b.timeKnown, b.tzIana);

  const aResult = computeAllBodiesWithMisses(aResolved.resolved.jdUt);
  const bResult = computeAllBodiesWithMisses(bResolved.resolved.jdUt);
  const unavailable = Array.from(new Set([...aResult.unavailable, ...bResult.unavailable]));

  const bodies = compositeBodies(aResult.positions, bResult.positions);
  const antipodalBodies = bodies.filter((x) => x.antipodal).map((x) => x.name);

  // Houses available only when BOTH times are known.
  const housesAvailable = a.timeKnown && b.timeKnown;

  let cusps: number[] | null = null;
  let ascendant: number | null = null;
  let midheaven: number | null = null;

  if (housesAvailable) {
    const aNatal = computeNatal(a);
    const bNatal = computeNatal(b);
    // computeNatal returns a numeric Asc/MC (0 sentinel only when houses are
    // unavailable); both are available here because both times are known.
    if (
      aNatal.housesAvailable &&
      bNatal.housesAvailable &&
      aNatal.ascendant !== null &&
      bNatal.ascendant !== null &&
      aNatal.midheaven !== null &&
      bNatal.midheaven !== null
    ) {
      const asc = shorterArcMidpoint(aNatal.ascendant, bNatal.ascendant).midpoint;
      ascendant = asc;
      midheaven = shorterArcMidpoint(aNatal.midheaven, bNatal.midheaven).midpoint;
      // Equal houses from the composite Ascendant (30° apart).
      cusps = Array.from({ length: 12 }, (_, i) => norm360(asc + i * 30));
    }
  }

  const planets: Planet[] = bodies.map((cb) => toCompositePlanet(cb, cusps));
  const houses: House[] = cusps ? toHouses(cusps) : [];
  const aspects: Aspect[] = compositeAspects(bodies);

  return {
    kind: 'composite',
    planets,
    houses,
    aspects,
    ascendant,
    midheaven,
    houseSystem: 'equal',
    computedAt: new Date().toISOString(),
    timeKnown: housesAvailable,
    housesAvailable,
    ephemerisBackend: getBackend(),
    unavailableBodies: unavailable,
    method: {
      longitudes: 'shorter-arc-midpoint',
      houses: housesAvailable ? 'midpoint-of-ascendants-and-mc' : 'omitted-unknown-time',
    },
    antipodalBodies,
  };
}

/** Assign a house (or 0 sentinel) to a composite body and split into sign/degree. */
function toCompositePlanet(cb: CompositeBody, cusps: number[] | null): Planet {
  return {
    name: cb.name,
    sign: signFor(cb.midpoint),
    degree: degreeInSign(cb.midpoint),
    absoluteDegree: cb.midpoint,
    house: cusps ? houseFromEqualCusps(cb.midpoint, cusps) : 0,
    // A composite point has no real motion; retrograde is undefined → false.
    retrograde: false,
  };
}

/** House (1..12) for an equal-house cusp set. */
function houseFromEqualCusps(lon: number, cusps: number[]): number {
  const target = norm360(lon);
  for (let i = 0; i < 12; i++) {
    const start = cusps[i] as number;
    const span = 30; // equal houses
    const offset = norm360(target - start);
    if (offset < span) return i + 1;
  }
  return 12;
}

/**
 * Major aspects between the composite midpoints. We reuse the SAME aspect
 * detector as natal charts by feeding it body positions with zero speed (a
 * composite point has no motion), so `applying` is always false here — which is
 * correct: a static abstraction neither applies nor separates.
 */
function compositeAspects(bodies: CompositeBody[]): Aspect[] {
  const positions: BodyPosition[] = bodies.map((cb) => ({
    name: cb.name,
    absoluteDegree: cb.midpoint,
    speed: 0,
  }));
  return computeAspects(positions);
}

/* -------------------------------------------------------------------------- */
/* Davison chart                                                              */
/* -------------------------------------------------------------------------- */

export interface DavisonChart extends RelationshipChart {
  kind: 'davison';
  /** The derived midpoint instant + place, for transparency. */
  midpoint: {
    /** UTC ISO datetime at the temporal midpoint of the two births. */
    utc: string;
    lat: number;
    lon: number;
  };
  method: {
    time: 'utc-instant-average';
    location: 'spherical-great-circle-midpoint';
  };
}

/**
 * The great-circle (spherical) midpoint of two lat/lon points, in degrees.
 *
 * Standard formula (Movable Type / aviation): convert to radians, take
 *   Bx = cos φ2 · cos Δλ,  By = cos φ2 · sin Δλ
 *   φm = atan2( sin φ1 + sin φ2, √((cos φ1 + Bx)² + By²) )
 *   λm = λ1 + atan2( By, cos φ1 + Bx )
 * This is the true midpoint on the sphere (not a naive average of coordinates),
 * which matters when the two places straddle the antimeridian or are far apart.
 */
export function geographicMidpoint(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): { lat: number; lon: number } {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);

  const Bx = Math.cos(phi2) * Math.cos(dLon);
  const By = Math.cos(phi2) * Math.sin(dLon);

  const phiM = Math.atan2(
    Math.sin(phi1) + Math.sin(phi2),
    Math.sqrt((Math.cos(phi1) + Bx) ** 2 + By ** 2),
  );
  const lamM = toRad(lon1) + Math.atan2(By, Math.cos(phi1) + Bx);

  // Normalise longitude into (-180, 180].
  let lonOut = toDeg(lamM);
  lonOut = ((((lonOut + 180) % 360) + 360) % 360) - 180;
  return { lat: toDeg(phiM), lon: lonOut };
}

/**
 * The temporal midpoint of two birth instants, as a Julian Day (UT).
 *
 * We resolve BOTH births to a real UTC instant via the existing time module
 * (which applies historical DST from the IANA tz database, or a local-noon
 * fallback when the time is unknown), convert each to a Julian Day, and AVERAGE
 * the two Julian Days. JD is a continuous linear time scale, so the arithmetic
 * mean of the two JDs is exactly the instant halfway between the two births.
 */
export function temporalMidpointJd(
  a: BirthData,
  b: BirthData,
): { jdUt: number; usedNoon: boolean } {
  const ra = resolveBirthInstant(a.date, a.time, a.timeKnown, a.tzIana);
  const rb = resolveBirthInstant(b.date, b.time, b.timeKnown, b.tzIana);
  return {
    jdUt: (ra.resolved.jdUt + rb.resolved.jdUt) / 2,
    usedNoon: ra.usedNoonFallback || rb.usedNoonFallback,
  };
}

/**
 * Build a Davison relationship chart: a NORMAL natal chart for the temporal
 * midpoint of the two births at the geographic midpoint of the two birthplaces.
 *
 * We compute the midpoint instant + place, then reuse {@link computeNatal} by
 * synthesising a `BirthData` for that midpoint. The midpoint instant is a real
 * UTC moment; we express it back as a local time in UTC (`tzIana: 'UTC'`) so the
 * existing time pipeline reproduces the SAME instant exactly. Houses follow the
 * normal natal rules: present when BOTH source times are known (so the midpoint
 * instant is meaningful to the minute), omitted otherwise.
 */
export function computeDavison(a: BirthData, b: BirthData): DavisonChart {
  const { jdUt } = temporalMidpointJd(a, b);
  const mid = geographicMidpoint(a.lat, a.lon, b.lat, b.lon);
  const utcIso = julianDayToIso(jdUt);

  // Houses meaningful only when both exact times are known.
  const timeKnown = a.timeKnown && b.timeKnown;

  // Express the midpoint UTC instant as a UTC-local BirthData so computeNatal
  // reproduces exactly this instant. Use the requesting A's house system.
  const dt = DateTime.fromISO(utcIso, { zone: 'utc' });
  const date = dt.toFormat('yyyy-MM-dd');
  const time = dt.toFormat('HH:mm');

  const midpointBirth: BirthData = {
    date,
    time: timeKnown ? time : null,
    timeKnown,
    lat: mid.lat,
    lon: mid.lon,
    tzIana: 'UTC',
    houseSystem: a.houseSystem,
  };

  const natal: NatalChartResponse = computeNatal(midpointBirth);

  return {
    kind: 'davison',
    planets: natal.planets,
    houses: natal.houses,
    aspects: natal.aspects,
    ascendant: natal.housesAvailable ? natal.ascendant : null,
    midheaven: natal.housesAvailable ? natal.midheaven : null,
    houseSystem: natal.houseSystem,
    computedAt: natal.computedAt,
    timeKnown,
    housesAvailable: natal.housesAvailable,
    ephemerisBackend: natal.ephemerisBackend,
    unavailableBodies: natal.unavailableBodies,
    midpoint: { utc: utcIso, lat: mid.lat, lon: mid.lon },
    method: {
      time: 'utc-instant-average',
      location: 'spherical-great-circle-midpoint',
    },
  };
}
