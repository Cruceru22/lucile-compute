/**
 * TASK B6 — pro-depth techniques: harmonics, midpoints, antiscia, fixed stars.
 *
 * Roadmap-v2 / pain #6: serious students & practitioners expect these techniques
 * (VisualAstro and the desktop tools sell them). All four are pure transforms of
 * a chart we ALREADY compute server-side — they add no new astronomy beyond the
 * fixed-star catalogue lookup — so this module REUSES the A3 internals
 * (`astro.ts`, `time.ts`, `natal.ts`) and the B5 midpoint convention
 * (`shorterArcMidpoint`) rather than re-deriving anything.
 *
 * Each technique is honest about precision: under the default Moshier backend
 * planetary longitudes are within ~0.1° for the modern era (more for the Moon),
 * and bodies that need Swiss `.se1` files (Chiron) are simply absent — exactly as
 * A3 reports them. Fixed stars additionally need the `sefstars.txt` catalogue; if
 * it is missing we return the technique as UNAVAILABLE (never fabricated).
 */
import type { Aspect, BirthData, PlanetName } from '@astroapp/shared';
import {
  BODIES,
  computeAllBodiesWithMisses,
  computeAspects,
  degreeInSign,
  norm360,
  signFor,
  type BodyPosition,
} from './astro.js';
import { shorterArcMidpoint } from './relationship.js';
import { resolveBirthInstant } from './time.js';
import { calcFlags, getBackend, sweph, type EphemerisBackend } from './ephemeris.js';
import type { ZodiacSign } from '@astroapp/shared';

/* -------------------------------------------------------------------------- */
/* Shared chart preparation                                                   */
/* -------------------------------------------------------------------------- */

/** A placed point (planet, midpoint, antiscion, …) split into sign + degree. */
export interface PlacedPoint {
  name: PlanetName;
  absoluteDegree: number;
  sign: ZodiacSign;
  /** Degree within the occupied sign, in [0, 30). */
  degree: number;
}

/** Split an absolute ecliptic longitude into a named placed point. */
function place(name: PlanetName, absoluteDegree: number): PlacedPoint {
  const abs = norm360(absoluteDegree);
  return { name, absoluteDegree: abs, sign: signFor(abs), degree: degreeInSign(abs) };
}

/** Resolve a chart's body positions (the common input to every technique). */
function bodiesFor(birth: BirthData): {
  positions: BodyPosition[];
  unavailable: PlanetName[];
  jdUt: number;
} {
  const { resolved } = resolveBirthInstant(birth.date, birth.time, birth.timeKnown, birth.tzIana);
  const { positions, unavailable } = computeAllBodiesWithMisses(resolved.jdUt);
  return { positions, unavailable, jdUt: resolved.jdUt };
}

/* -------------------------------------------------------------------------- */
/* 1. Harmonics                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The harmonic longitude of a body in the Nth harmonic chart.
 *
 * FORMULA:  Hₙ(λ) = (λ · N) mod 360
 *
 * The harmonic chart multiplies every ecliptic longitude by the harmonic number
 * `N` and wraps to [0, 360). It "folds" the zodiac into N copies, so points that
 * are 360/N° apart in the natal chart land conjunct in the harmonic chart —
 * which is exactly how the harmonic surfaces the Nth-harmonic aspect family
 * (H4 = squares/oppositions, H5 = quintiles, H7 = septiles, H9 = noviles).
 *
 * WORKED EXAMPLE: a body at natal 10° (10° Aries) in the 4th harmonic →
 *   (10 · 4) mod 360 = 40°  → 10° Taurus.
 * A body at 100° in H4 → (100 · 4) mod 360 = 400 mod 360 = 40° (wrap demonstrated).
 */
export function harmonicLongitude(naturalLongitude: number, n: number): number {
  return norm360(norm360(naturalLongitude) * n);
}

export interface HarmonicResult {
  technique: 'harmonics';
  harmonic: number;
  /** Each body's harmonic longitude, sign & degree, in canonical body order. */
  points: PlacedPoint[];
  /** Aspects RECOMPUTED on the harmonic longitudes (same orbs as natal). */
  aspects: Aspect[];
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
  /** Documents the transform applied, for transparency. */
  method: { transform: 'longitude-times-n-mod-360' };
}

/** Compute the Nth harmonic chart from birth data. */
export function computeHarmonics(birth: BirthData, n: number): HarmonicResult {
  const { positions, unavailable } = bodiesFor(birth);
  const harmonicPositions: BodyPosition[] = positions.map((p) => ({
    name: p.name,
    absoluteDegree: harmonicLongitude(p.absoluteDegree, n),
    // Harmonic positions are abstractions with no real motion → speed 0
    // (so the recomputed aspects report applying:false, which is correct).
    speed: 0,
  }));
  const points = harmonicPositions.map((p) => place(p.name, p.absoluteDegree));
  const aspects = computeAspects(harmonicPositions);
  return {
    technique: 'harmonics',
    harmonic: n,
    points,
    aspects,
    ephemerisBackend: getBackend(),
    unavailableBodies: unavailable,
    method: { transform: 'longitude-times-n-mod-360' },
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Midpoints                                                               */
/* -------------------------------------------------------------------------- */

/** The midpoint of one ordered pair of bodies. */
export interface MidpointPair {
  a: PlanetName;
  b: PlanetName;
  /** Shorter-arc midpoint longitude, in [0, 360). */
  midpoint: number;
  sign: ZodiacSign;
  degree: number;
  /** True when the two bodies were exactly antipodal (180°) — disambiguated. */
  antipodal: boolean;
}

/** A planet sitting ON a midpoint within orb ("direct midpoint contact"). */
export interface MidpointContact {
  /** The planet making the contact. */
  planet: PlanetName;
  /** The midpoint it sits on, e.g. Sun/Moon. */
  a: PlanetName;
  b: PlanetName;
  /** Deviation from the exact midpoint, in degrees. */
  orb: number;
  /**
   * True when the planet is on the midpoint's OPPOSITE point (180° away).
   * In midpoint work both the direct point and its opposition activate the
   * midpoint, so we flag (but still report) the opposite-point hit.
   */
  opposite: boolean;
}

export interface MidpointsResult {
  technique: 'midpoints';
  /** Every unordered planet PAIR's midpoint, in canonical order. */
  pairs: MidpointPair[];
  /** Planets sitting on a midpoint (or its opposite) within `orb`. */
  contacts: MidpointContact[];
  /** The orb (degrees) used for direct-contact detection. */
  contactOrb: number;
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
  method: { midpoint: 'shorter-arc-midpoint' };
}

/** Default orb for "planet on a midpoint" — tight, as midpoints demand. */
export const DEFAULT_MIDPOINT_ORB = 1.5;

/**
 * Compute every planet-pair midpoint and flag direct midpoint contacts.
 *
 * MIDPOINT CONVENTION (shared with B5 composite): {@link shorterArcMidpoint} —
 * the centre of the SHORTER arc joining the two longitudes, so 350° & 10° →
 * 0° (not 180°). Exactly-antipodal pairs are disambiguated deterministically to
 * `a + 90°` and flagged `antipodal`.
 */
export function computeMidpoints(birth: BirthData, orb = DEFAULT_MIDPOINT_ORB): MidpointsResult {
  const { positions, unavailable } = bodiesFor(birth);

  const pairs: MidpointPair[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const pa = positions[i] as BodyPosition;
      const pb = positions[j] as BodyPosition;
      const { midpoint, antipodal } = shorterArcMidpoint(pa.absoluteDegree, pb.absoluteDegree);
      pairs.push({
        a: pa.name,
        b: pb.name,
        midpoint,
        sign: signFor(midpoint),
        degree: degreeInSign(midpoint),
        antipodal,
      });
    }
  }

  // Direct midpoint contacts: a third planet conjunct (or opposite) a midpoint.
  const contacts: MidpointContact[] = [];
  for (const pair of pairs) {
    for (const p of positions) {
      if (p.name === pair.a || p.name === pair.b) continue;
      const sep = angularSeparation(p.absoluteDegree, pair.midpoint);
      if (sep <= orb) {
        contacts.push({ planet: p.name, a: pair.a, b: pair.b, orb: sep, opposite: false });
      } else if (Math.abs(sep - 180) <= orb) {
        contacts.push({
          planet: p.name,
          a: pair.a,
          b: pair.b,
          orb: Math.abs(sep - 180),
          opposite: true,
        });
      }
    }
  }

  return {
    technique: 'midpoints',
    pairs,
    contacts,
    contactOrb: orb,
    ephemerisBackend: getBackend(),
    unavailableBodies: unavailable,
    method: { midpoint: 'shorter-arc-midpoint' },
  };
}

/** Smallest separation between two longitudes, in [0, 180]. */
function angularSeparation(a: number, b: number): number {
  const diff = Math.abs(norm360(a) - norm360(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/* -------------------------------------------------------------------------- */
/* 3. Antiscia                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The ANTISCION of a longitude: its reflection across the Cancer–Capricorn
 * solstitial axis (the 0° Cancer / 0° Capricorn line, i.e. longitudes 90°/270°).
 *
 * FORMULA:  antiscion(λ) = (180 − λ) mod 360
 *
 * Antiscia are "shadow" or "reflection" points: two degrees that are equidistant
 * from the solstitial axis receive the same amount of daylight, so the ancients
 * treated them as sympathetically linked. A planet's antiscion acts like a hidden
 * conjunction point.
 *
 * WORKED EXAMPLE: 15° Taurus = absolute 45°.
 *   antiscion = (180 − 45) mod 360 = 135° = 15° Leo.   ✓ (Taurus ↔ Leo are
 *   mirror signs about the Cancer/Capricorn axis: Gem↔Can, Tau↔Leo, Ari↔Vir, …)
 */
export function antiscion(longitude: number): number {
  return norm360(180 - norm360(longitude));
}

/**
 * The CONTRA-ANTISCION: reflection across the Aries–Libra equinoctial axis
 * (the 0° Aries / 0° Libra line, longitudes 0°/180°). It is simply the
 * OPPOSITION of the antiscion.
 *
 * FORMULA:  contraAntiscion(λ) = (360 − λ) mod 360 = (−λ) mod 360
 *
 * WORKED EXAMPLE: 15° Taurus = 45°.
 *   contra = (360 − 45) mod 360 = 315° = 15° Aquarius.  (= antiscion + 180°:
 *   135° + 180° = 315°.) ✓
 */
export function contraAntiscion(longitude: number): number {
  return norm360(-norm360(longitude));
}

/** A body's antiscion + contra-antiscion, both placed into sign/degree. */
export interface AntisciaEntry {
  name: PlanetName;
  natal: PlacedPoint;
  antiscion: PlacedPoint;
  contraAntiscion: PlacedPoint;
}

/**
 * A contact between one body's antiscion (or contra-antiscion) and a natal body:
 * the reflection point falls conjunct a real planet within orb, which classical
 * astrology reads as a hidden link between the two bodies.
 */
export interface AntisciaContact {
  /** The body whose reflection makes the contact. */
  from: PlanetName;
  /** Which reflection hit: the antiscion or the contra-antiscion. */
  kind: 'antiscion' | 'contra-antiscion';
  /** The natal body the reflection lands on. */
  to: PlanetName;
  /** Deviation from exact, in degrees. */
  orb: number;
}

export interface AntisciaResult {
  technique: 'antiscia';
  entries: AntisciaEntry[];
  /** Reflection points landing on a natal body within `contactOrb`. */
  contacts: AntisciaContact[];
  contactOrb: number;
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
  method: {
    antiscion: 'reflect-across-cancer-capricorn-axis: (180 - lon)';
    contraAntiscion: 'reflect-across-aries-libra-axis: (360 - lon)';
  };
}

/** Antiscia work uses a tight orb (a degree or so). */
export const DEFAULT_ANTISCIA_ORB = 1.0;

/** Compute antiscia / contra-antiscia for every body + contacts to natal bodies. */
export function computeAntiscia(birth: BirthData, orb = DEFAULT_ANTISCIA_ORB): AntisciaResult {
  const { positions, unavailable } = bodiesFor(birth);

  const entries: AntisciaEntry[] = positions.map((p) => ({
    name: p.name,
    natal: place(p.name, p.absoluteDegree),
    antiscion: place(p.name, antiscion(p.absoluteDegree)),
    contraAntiscion: place(p.name, contraAntiscion(p.absoluteDegree)),
  }));

  // Contacts: does body X's reflection land on a (different) natal body Y?
  const contacts: AntisciaContact[] = [];
  for (const entry of entries) {
    for (const target of positions) {
      if (target.name === entry.name) continue;
      const aSep = angularSeparation(entry.antiscion.absoluteDegree, target.absoluteDegree);
      if (aSep <= orb) {
        contacts.push({ from: entry.name, kind: 'antiscion', to: target.name, orb: aSep });
      }
      const cSep = angularSeparation(entry.contraAntiscion.absoluteDegree, target.absoluteDegree);
      if (cSep <= orb) {
        contacts.push({ from: entry.name, kind: 'contra-antiscion', to: target.name, orb: cSep });
      }
    }
  }

  return {
    technique: 'antiscia',
    entries,
    contacts,
    contactOrb: orb,
    ephemerisBackend: getBackend(),
    unavailableBodies: unavailable,
    method: {
      antiscion: 'reflect-across-cancer-capricorn-axis: (180 - lon)',
      contraAntiscion: 'reflect-across-aries-libra-axis: (360 - lon)',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Fixed stars                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Curated major fixed stars: sweph catalogue name + a short, grounded meaning
 * for the UI. The `name` is the traditional name `swe_fixstar2` accepts; sweph
 * also accepts the Bayer designation, but the traditional names are clearer.
 *
 * Meanings are the conventional traditional/medieval keywords (Robson, Brady) —
 * deliberately brief and non-fabricated; the UI can expand these.
 */
export const MAJOR_FIXED_STARS: ReadonlyArray<{
  name: string;
  meaning: string;
}> = [
  {
    name: 'Regulus',
    meaning: 'The "Royal Star" of leadership, success and the risk of downfall through pride.',
  },
  { name: 'Spica', meaning: 'A fortunate star of brilliance, talent and unexpected gifts.' },
  {
    name: 'Aldebaran',
    meaning:
      'A "Royal Star" (Watcher of the East) of integrity, courage and honour won through effort.',
  },
  {
    name: 'Antares',
    meaning: 'A "Royal Star" (Watcher of the West) of intensity, courage and obsessive drive.',
  },
  {
    name: 'Algol',
    meaning:
      'The most notorious star, raw, concentrated intensity; passion and danger if unchanneled.',
  },
  {
    name: 'Sirius',
    meaning: 'The brightest star: ambition, renown and a drive to rise above the ordinary.',
  },
  {
    name: 'Fomalhaut',
    meaning: 'A "Royal Star" (Watcher of the South) of idealism, vision and lasting reputation.',
  },
  { name: 'Vega', meaning: 'Charisma, artistry and a magnetic, idealistic creativity.' },
  { name: 'Betelgeuse', meaning: 'Martial success, command and durable achievement.' },
  { name: 'Rigel', meaning: 'Teaching, technical skill and the building of lasting structures.' },
  { name: 'Pollux', meaning: 'A combative, competitive edge; skill in contest and craft.' },
  { name: 'Capella', meaning: 'Curiosity, freedom of mind and a questing, inquisitive nature.' },
];

/** Default conjunction orb for fixed stars — very tight, as is traditional. */
export const DEFAULT_FIXED_STAR_ORB = 1.0;

/** A natal body found conjunct a fixed star within orb. */
export interface FixedStarContact {
  /** The natal body (planet or angle) making the conjunction. */
  body: PlanetName | 'Ascendant' | 'Midheaven';
  star: string;
  /** The star's ecliptic longitude at the chart moment, in [0, 360). */
  starLongitude: number;
  sign: ZodiacSign;
  degree: number;
  /** Conjunction orb, in degrees. */
  orb: number;
  meaning: string;
}

export interface FixedStarsResult {
  technique: 'fixed_stars';
  /**
   * True when the `sefstars.txt` catalogue is present and stars were computed.
   * When false, `contacts` is empty and `reason` explains why — the technique is
   * UNAVAILABLE, never fabricated (mirrors how A3 handles Chiron under Moshier).
   */
  available: boolean;
  /** Present only when `available` is false. */
  reason?: string;
  contacts: FixedStarContact[];
  /** The curated catalogue of stars + meanings, always returned for the UI. */
  catalog: ReadonlyArray<{ name: string; meaning: string }>;
  contactOrb: number;
  ephemerisBackend: EphemerisBackend;
}

/**
 * The ecliptic longitude of a fixed star at a Julian Day (UT), or `null` when
 * the star catalogue (`sefstars.txt`) is not installed.
 *
 * `swe_fixstar2_ut` does NOT throw when the catalogue is missing; it returns a
 * negative flag with an error message and zeroed data. We treat ANY negative
 * flag as "catalogue unavailable" and return null so the caller degrades
 * gracefully (it must never present 0° as a real position).
 */
export function fixedStarLongitude(name: string, jdUt: number): number | null {
  const res = sweph.fixstar2_ut(name, jdUt, calcFlags());
  if (res.flag < 0) return null;
  const lon = res.data[0];
  if (!Number.isFinite(lon)) return null;
  return norm360(lon);
}

/**
 * Detect natal conjunctions to the major fixed stars.
 *
 * Requires the `sefstars.txt` catalogue. When it is absent (the default here,
 * like the missing Chiron `.se1`), EVERY star lookup fails and we return
 * `available:false` with a clear reason and an empty contact list — but still
 * return the curated catalogue + meanings so the UI can show what WILL be
 * available once the file is installed.
 *
 * To install: drop the official Swiss Ephemeris `sefstars.txt` (and `seas_*`,
 * `sepl_*` `.se1` files for full precision) into the directory pointed at by
 * `SWEPH_PATH` / `EPHE_PATH`. The file ships with the Swiss Ephemeris download
 * (https://www.astro.com/ftp/swisseph/ephe/) and is free to redistribute.
 */
export function computeFixedStars(
  birth: BirthData,
  angles?: { ascendant: number | null; midheaven: number | null },
  orb = DEFAULT_FIXED_STAR_ORB,
): FixedStarsResult {
  const { positions, jdUt } = bodiesFor(birth);
  const backend = getBackend();

  // Probe the WHOLE catalogue, not a single star. The `sweph` package ships a
  // tiny BUILT-IN fixed-star table (only a couple of entries, e.g. Spica) that
  // `swe_fixstar2_ut` resolves even when `sefstars.txt` is absent. A single-star
  // probe is therefore unreliable: if it happened to hit a bundled star it would
  // report `available:true` and then SILENTLY DROP the 11 stars not in the
  // bundle — a partial, misleading result. We treat the catalogue as available
  // only when EVERY curated star resolves; any miss means the real `sefstars.txt`
  // is not installed and we degrade to the honest unavailable state (never a
  // partial set, never a fabricated 0° position).
  const probes = MAJOR_FIXED_STARS.map((s) => fixedStarLongitude(s.name, jdUt));
  const catalogueAvailable = probes.every((lon) => lon !== null);
  if (!catalogueAvailable) {
    return {
      technique: 'fixed_stars',
      available: false,
      reason:
        'Fixed-star catalogue (sefstars.txt) is not installed. Add it to SWEPH_PATH/EPHE_PATH to enable fixed-star conjunctions.',
      contacts: [],
      catalog: MAJOR_FIXED_STARS,
      contactOrb: orb,
      ephemerisBackend: backend,
    };
  }

  // The list of "natal points" to test against each star: every body + (when
  // available) the Ascendant and Midheaven.
  const points: Array<{ name: FixedStarContact['body']; lon: number }> = positions.map((p) => ({
    name: p.name,
    lon: p.absoluteDegree,
  }));
  if (angles?.ascendant != null) points.push({ name: 'Ascendant', lon: angles.ascendant });
  if (angles?.midheaven != null) points.push({ name: 'Midheaven', lon: angles.midheaven });

  const contacts: FixedStarContact[] = [];
  for (const star of MAJOR_FIXED_STARS) {
    const lon = fixedStarLongitude(star.name, jdUt);
    if (lon === null) continue; // a single star missing from the catalogue
    for (const point of points) {
      const sep = angularSeparation(point.lon, lon);
      if (sep <= orb) {
        contacts.push({
          body: point.name,
          star: star.name,
          starLongitude: lon,
          sign: signFor(lon),
          degree: degreeInSign(lon),
          orb: sep,
          meaning: star.meaning,
        });
      }
    }
  }

  return {
    technique: 'fixed_stars',
    available: true,
    contacts,
    catalog: MAJOR_FIXED_STARS,
    contactOrb: orb,
    ephemerisBackend: backend,
  };
}

/* -------------------------------------------------------------------------- */
/* Canonical body order export (handy for clients that want it)              */
/* -------------------------------------------------------------------------- */

/** The canonical body names this service places, in order. */
export const BODY_ORDER: readonly PlanetName[] = BODIES.map((b) => b.name);
