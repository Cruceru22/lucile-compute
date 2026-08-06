/**
 * @astroapp/shared
 *
 * Pure TypeScript type contracts shared between the mobile app and the
 * server-side compute service. No runtime dependencies. All astrological
 * calculations are performed SERVER-SIDE; these types describe the data
 * that flows between the compute service, the app, and (later) the LLM
 * interpretation layer.
 */

/** Supported astrological house systems. */
export type HouseSystem = 'placidus' | 'whole_sign' | 'koch' | 'equal';

/**
 * Zodiac frame used to place bodies into signs.
 * - `tropical` — signs anchored to the equinox (the app default; what most
 *   Western astrology uses).
 * - `sidereal` — signs anchored to the fixed stars, offset from tropical by the
 *   ayanamsa (used by Vedic/Jyotish traditions). Requires an {@link Ayanamsa}.
 *
 * Optional everywhere it appears; absent ⇒ `tropical`, so existing requests and
 * stored data behave exactly as before.
 */
export type Zodiac = 'tropical' | 'sidereal';

/**
 * Sidereal ayanamsa (the tropical→sidereal offset model). `lahiri` is the most
 * common (and the default when sidereal is requested without an explicit value).
 */
export type Ayanamsa = 'lahiri' | 'fagan_bradley' | 'krishnamurti' | 'raman';

/**
 * The twelve zodiac signs, in zodiacal order starting at Aries.
 */
export type ZodiacSign =
  | 'Aries'
  | 'Taurus'
  | 'Gemini'
  | 'Cancer'
  | 'Leo'
  | 'Virgo'
  | 'Libra'
  | 'Scorpio'
  | 'Sagittarius'
  | 'Capricorn'
  | 'Aquarius'
  | 'Pisces';

/**
 * Celestial bodies and points we may place in a chart.
 * The first ten are the classical planets (Sun..Pluto); next come optional
 * points some chart configurations include (Chiron, the lunar North Node, and
 * Black Moon Lilith); the final four are the major asteroids (Ceres, Pallas,
 * Juno, Vesta) surfaced behind the premium `asteroids` feature.
 *
 * Asteroids — like Chiron — require the Swiss `seas_*.se1` ephemeris files; under
 * the built-in Moshier backend they cannot be computed and are reported in
 * {@link NatalChart.unavailableBodies} rather than fabricated.
 */
export type PlanetName =
  | 'Sun'
  | 'Moon'
  | 'Mercury'
  | 'Venus'
  | 'Mars'
  | 'Jupiter'
  | 'Saturn'
  | 'Uranus'
  | 'Neptune'
  | 'Pluto'
  | 'Chiron'
  | 'NorthNode'
  | 'Lilith'
  | 'Ceres'
  | 'Pallas'
  | 'Juno'
  | 'Vesta';

/** The five Ptolemaic (major) aspect types. */
export type AspectType = 'conjunction' | 'sextile' | 'square' | 'trine' | 'opposition';

/**
 * Which ephemeris backend produced a chart. `swiss` uses the full-precision
 * `.se1` data files (arc-second accuracy, requires the Professional license);
 * `moshier` is the built-in analytic fallback (no data files, slightly lower
 * precision, and without asteroid data such as Chiron).
 */
export type EphemerisBackend = 'swiss' | 'moshier';

/**
 * Raw birth input used to compute a natal chart. This is the canonical
 * request shape the app sends to the compute service.
 */
export interface BirthData {
  /** Optional stable identifier (e.g. DB row id) for the stored birth record. */
  id?: string;
  /** Calendar date of birth, ISO `yyyy-mm-dd`. */
  date: string;
  /** Local time of birth, `HH:mm` (24h). `null` when the time is unknown. */
  time: string | null;
  /** Whether a reliable birth time is known. When false, time-sensitive points (houses, Ascendant) are unreliable. */
  timeKnown: boolean;
  /** Geographic latitude in decimal degrees (north positive). */
  lat: number;
  /** Geographic longitude in decimal degrees (east positive). */
  lon: number;
  /** IANA time zone identifier for the birth location, e.g. `Europe/Lisbon`. */
  tzIana: string;
  /** House system to use when computing the chart. */
  houseSystem: HouseSystem;
  /**
   * Zodiac frame to compute the chart in. Optional and additive: omit (or
   * `tropical`) for the historical behaviour. `sidereal` shifts every longitude
   * by the {@link ayanamsa}.
   */
  zodiac?: Zodiac;
  /**
   * Sidereal ayanamsa model. Only meaningful when `zodiac === 'sidereal'`;
   * defaults to `lahiri` when omitted. Ignored for tropical charts.
   */
  ayanamsa?: Ayanamsa;
}

/**
 * A single celestial body placed within a computed chart.
 */
export interface Planet {
  name: PlanetName;
  /** Sign occupied by the body. */
  sign: ZodiacSign;
  /** Position within the sign, in degrees `[0, 30)`. */
  degree: number;
  /** Ecliptic longitude in degrees `[0, 360)`. */
  absoluteDegree: number;
  /** House occupied by the body, `1..12`. */
  house: number;
  /** Whether the body is retrograde at the moment of computation. */
  retrograde: boolean;
  /** Optional daily motion in degrees/day; negative when retrograde. */
  speed?: number;
}

/**
 * A house cusp in the computed chart.
 */
export interface House {
  /** House number, `1..12`. */
  number: number;
  /** Ecliptic longitude of the house cusp, in degrees `[0, 360)`. */
  cuspDegree: number;
  /** Sign on the cusp. */
  sign: ZodiacSign;
}

/**
 * A geometric relationship between two bodies in the chart.
 */
export interface Aspect {
  a: PlanetName;
  b: PlanetName;
  type: AspectType;
  /** Deviation from exactness, in degrees. */
  orb: number;
  /** Whether the aspect is applying (tightening) rather than separating. */
  applying: boolean;
}

/**
 * A fully computed natal chart. Produced server-side and consumed by the
 * app and the interpretation layer.
 */
export interface NatalChart {
  planets: Planet[];
  /** House cusps. Empty when the birth time is unknown (`housesAvailable` false). */
  houses: House[];
  aspects: Aspect[];
  /**
   * Ecliptic longitude of the Ascendant, in degrees `[0, 360)`.
   * `null` when the birth time is unknown and houses cannot be computed.
   */
  ascendant: number | null;
  /**
   * Ecliptic longitude of the Midheaven (MC), in degrees `[0, 360)`.
   * `null` when the birth time is unknown and houses cannot be computed.
   */
  midheaven: number | null;
  houseSystem: HouseSystem;
  /** ISO datetime when the chart was computed. */
  computedAt: string;

  // --- Computation metadata (set by the compute service) ---
  /** Whether a reliable birth time was supplied. */
  timeKnown?: boolean;
  /** Whether houses, Ascendant and MC are available (false when the time is unknown). */
  housesAvailable?: boolean;
  /** Whether planetary positions were computed for a noon fallback (unknown time). */
  usedNoonFallback?: boolean;
  /** Whether the birth predates the reliable (post-1970) IANA tz era — accuracy caveat. */
  preTzDatabaseEra?: boolean;
  /** Which ephemeris backend produced this chart. */
  ephemerisBackend?: EphemerisBackend;
  /** Bodies that could not be computed with the active backend (e.g. Chiron under Moshier). */
  unavailableBodies?: PlanetName[];
  /** Zodiac frame this chart was computed in. Absent ⇒ `tropical` (default). */
  zodiac?: Zodiac;
  /** Ayanamsa model used when `zodiac === 'sidereal'`. */
  ayanamsa?: Ayanamsa;
  /** The ayanamsa value in degrees applied to this chart (0 for tropical). */
  ayanamsaDegrees?: number;
}

/**
 * A forecasted transit: a transiting body forming an aspect to a natal body.
 */
export interface TransitEvent {
  transitingPlanet: PlanetName;
  natalPlanet: PlanetName;
  aspect: AspectType;
  /** ISO datetime at which the aspect is exact. */
  exactAt: string;
  /** Orb in degrees at the reference moment. */
  orb: number;
}

/** Directed profections (al-Tabari) — pure timing engine, see ./directedProfections. */
export * from './directedProfections.js';
