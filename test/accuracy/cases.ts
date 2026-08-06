/**
 * Accuracy harness test corpus (TASK A10).
 *
 * ~20 test births chosen to STRESS the compute engine across the dimensions the
 * QA task calls out: several pre-1970 births, an unknown birth time, the
 * southern hemisphere, near-equator and high-latitude locations, odd/half-hour
 * timezones (India +05:30, Nepal +05:45, Iran +03:30), historical DST oddities,
 * and a date right on a sign cusp.
 *
 * HONESTY MODEL — two kinds of case:
 *
 *  1. `reference` cases carry CITED reference values from a published
 *     professional source (Astrotheme / Astro-Seek / a standard ephemeris
 *     fixture). Each `expect` entry is an external ground-truth longitude we
 *     compare the engine against, within an honest Moshier tolerance. The
 *     `source` field cites where the numbers came from. We DO NOT invent
 *     reference numbers — every value below was read from the cited source.
 *
 *  2. `consistency` cases have NO external reference (we could not obtain a
 *     trustworthy Rodden-rated reference for that exact birth). For these we
 *     assert ENGINE-INTERNAL invariants only — determinism, sign/degree
 *     coherence, retrograde ⇔ negative-speed, house placement bounds, the
 *     unknown-time contract, etc. They prove the engine is self-consistent and
 *     handles the hard inputs without crashing; they are NOT accuracy proofs.
 *
 * Moshier tolerance rationale (the default backend has no `.se1` files): Moshier
 * vs Swiss differ by well under ~0.1° for the Sun and major planets in the
 * modern era. We use ±0.5° on planet longitudes and require sign matches. The
 * Ascendant/MC additionally depend on the EXACT birth time + timezone; for
 * pre-1970 births the IANA tz-db is unreliable (LMT-vs-zone offset of minutes →
 * up to a degree or two of Asc drift), so reference Asc/MC checks use a wider,
 * documented tolerance and several pre-1970 angles are asserted by SIGN only.
 */
import type { BirthData, PlanetName } from '@astroapp/shared';

/** Tolerances (degrees), documented above. */
export const TOL = {
  /** Sun + major planets, modern era, Moshier. */
  planet: 0.5,
  /** Asc/MC with a known modern (post-1970) exact time. */
  angleModern: 1.5,
  /**
   * Asc/MC for a pre-1970 birth (tz-db / LMT offset uncertainty). The MC tracks
   * local sidereal time, so a few-minute LMT-vs-zone offset can move it a few
   * degrees; ±4° is the honest envelope for the angles of a pre-1970 chart.
   */
  anglePre1970: 4.0,
} as const;

/** One expected longitude for a reference case. */
export interface ExpectedLongitude {
  /** A planet name, or the chart angles. */
  body: PlanetName | 'Ascendant' | 'Midheaven';
  /** Expected absolute ecliptic longitude in degrees [0,360). */
  absoluteDegree: number;
  /** Expected sign (always asserted for planets). */
  sign?: string;
  /** Tolerance bucket to apply to this body's longitude delta. */
  tol: number;
  /** When true, assert the SIGN only (degree too tz-sensitive to pin down). */
  signOnly?: boolean;
}

export interface ReferenceCase {
  kind: 'reference';
  id: string;
  description: string;
  /** Citation for the reference values (URL + system). */
  source: string;
  birth: BirthData;
  expect: ExpectedLongitude[];
  /** Free-text caveat shown in the report (e.g. tz/LMT note). */
  caveat?: string;
}

export interface ConsistencyCase {
  kind: 'consistency';
  id: string;
  description: string;
  /** Why this is consistency-only (no trustworthy external reference). */
  reason: string;
  birth: BirthData;
  /** Optional sanity facts we still know (e.g. the Sun's sign for the date). */
  expectSunSign?: string;
}

export type AccuracyCase = ReferenceCase | ConsistencyCase;

export const CASES: AccuracyCase[] = [
  // -------------------------------------------------------------------------
  // REFERENCE-CHECKED CASES
  // -------------------------------------------------------------------------

  // 1) Standard ephemeris fixture: J2000 noon at Greenwich. Tropical, Placidus.
  //    These are textbook positions, independent of any one celebrity source.
  {
    kind: 'reference',
    id: 'j2000-greenwich-noon',
    description: 'J2000.0 noon at Greenwich (standard ephemeris fixture)',
    source:
      'Standard J2000.0 ephemeris (Astronomical Almanac / Astro.com Swiss Ephemeris test vector), tropical, Placidus.',
    birth: {
      date: '2000-01-01',
      time: '12:00',
      timeKnown: true,
      lat: 51.4779,
      lon: -0.0015,
      tzIana: 'Europe/London',
      houseSystem: 'placidus',
    },
    expect: [
      { body: 'Sun', sign: 'Capricorn', absoluteDegree: 280.37, tol: TOL.planet },
      { body: 'Moon', sign: 'Scorpio', absoluteDegree: 223.3, tol: TOL.planet },
      { body: 'Mercury', sign: 'Capricorn', absoluteDegree: 271.89, tol: TOL.planet },
      { body: 'Ascendant', sign: 'Aries', absoluteDegree: 24.3, tol: TOL.angleModern },
    ],
  },

  // 2) Albert Einstein — pre-1970, AA-rated (birth certificate).
  //    14 Mar 1879, 11:30 LMT, Ulm. Reference: Astrotheme (tropical, Placidus).
  {
    kind: 'reference',
    id: 'einstein-1879',
    description: 'Albert Einstein — 14 Mar 1879, 11:30, Ulm (pre-1970, Rodden AA)',
    source:
      'Astrotheme https://www.astrotheme.com/Focus-Astro-celebrity-Albert-Einstein.php (tropical, Placidus). Rodden AA (birth certificate).',
    caveat:
      'Pre-1970: Europe/Berlin in the IANA tz-db approximates 1879 Ulm local mean time; the small LMT-vs-zone offset shifts the Ascendant by up to a degree or two, so Asc/MC are checked at the wider pre-1970 tolerance and Mars is sign-checked only.',
    birth: {
      date: '1879-03-14',
      time: '11:30',
      timeKnown: true,
      lat: 48.4,
      lon: 9.9833,
      tzIana: 'Europe/Berlin',
      houseSystem: 'placidus',
    },
    expect: [
      { body: 'Sun', sign: 'Pisces', absoluteDegree: 353.5, tol: TOL.planet },
      { body: 'Moon', sign: 'Sagittarius', absoluteDegree: 254.53, tol: TOL.planet },
      { body: 'Mercury', sign: 'Aries', absoluteDegree: 3.15, tol: TOL.planet },
      { body: 'Venus', sign: 'Aries', absoluteDegree: 16.98, tol: TOL.planet },
      { body: 'Saturn', sign: 'Aries', absoluteDegree: 4.18, tol: TOL.planet },
      { body: 'Uranus', sign: 'Virgo', absoluteDegree: 151.28, tol: TOL.planet },
      { body: 'Neptune', sign: 'Taurus', absoluteDegree: 37.87, tol: TOL.planet },
      { body: 'Pluto', sign: 'Taurus', absoluteDegree: 54.73, tol: TOL.planet },
      { body: 'Mars', sign: 'Capricorn', absoluteDegree: 296.92, tol: TOL.planet, signOnly: true },
      // 11°38' Cancer = 101.63°. Wider tol for the pre-1970 tz/LMT offset.
      { body: 'Ascendant', sign: 'Cancer', absoluteDegree: 101.63, tol: TOL.anglePre1970 },
      // 12°50' Pisces = 342.83°.
      { body: 'Midheaven', sign: 'Pisces', absoluteDegree: 342.83, tol: TOL.anglePre1970 },
    ],
  },

  // 3) Princess Diana — modern, AA-rated (birth certificate).
  //    1 Jul 1961, 19:45 BST, Sandringham. Reference: Astrotheme (tropical, Placidus).
  {
    kind: 'reference',
    id: 'diana-1961',
    description: 'Princess Diana — 1 Jul 1961, 19:45 BST, Sandringham (Rodden AA)',
    source:
      'Astrotheme https://www.astrotheme.com/astrology/Diana%2C_Princess_of_Wales (tropical, Placidus). Rodden AA (birth certificate). 19:45 BST = 18:45 UT.',
    caveat:
      'Modern exact time with British Summer Time in effect (Europe/London applies BST automatically). Asc/MC checked at the modern angle tolerance.',
    birth: {
      date: '1961-07-01',
      time: '19:45',
      timeKnown: true,
      lat: 52.8309,
      lon: 0.5097,
      tzIana: 'Europe/London',
      houseSystem: 'placidus',
    },
    expect: [
      { body: 'Sun', sign: 'Cancer', absoluteDegree: 99.67, tol: TOL.planet },
      { body: 'Moon', sign: 'Aquarius', absoluteDegree: 325.03, tol: TOL.planet },
      { body: 'Mercury', sign: 'Cancer', absoluteDegree: 93.2, tol: TOL.planet },
      { body: 'Venus', sign: 'Taurus', absoluteDegree: 54.4, tol: TOL.planet },
      { body: 'Mars', sign: 'Virgo', absoluteDegree: 151.65, tol: TOL.planet },
      { body: 'Jupiter', sign: 'Aquarius', absoluteDegree: 305.1, tol: TOL.planet },
      { body: 'Saturn', sign: 'Capricorn', absoluteDegree: 297.82, tol: TOL.planet },
      { body: 'Uranus', sign: 'Leo', absoluteDegree: 143.33, tol: TOL.planet },
      { body: 'Neptune', sign: 'Scorpio', absoluteDegree: 218.63, tol: TOL.planet },
      { body: 'Pluto', sign: 'Virgo', absoluteDegree: 156.15, tol: TOL.planet },
      // 18°24' Sagittarius = 258.40°.
      { body: 'Ascendant', sign: 'Sagittarius', absoluteDegree: 258.4, tol: TOL.angleModern },
      // 23°03' Libra = 203.05°.
      { body: 'Midheaven', sign: 'Libra', absoluteDegree: 203.05, tol: TOL.angleModern },
    ],
  },

  // -------------------------------------------------------------------------
  // CONSISTENCY-ONLY CASES (no trustworthy external reference obtained)
  // Each STRESSES a specific engine dimension.
  // -------------------------------------------------------------------------

  // 4) Unknown birth time — houses must be omitted, planets still present.
  {
    kind: 'consistency',
    id: 'unknown-time-lisbon',
    description: 'Unknown birth time, Lisbon (houses must be unavailable)',
    reason:
      'Unknown-time chart: the houses/Asc/MC are intentionally not computed, so there is nothing external to compare; we assert the unknown-time contract instead.',
    birth: {
      date: '1990-06-15',
      time: null,
      timeKnown: false,
      lat: 38.7223,
      lon: -9.1393,
      tzIana: 'Europe/Lisbon',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Gemini',
  },

  // 5) Southern hemisphere — Sydney.
  {
    kind: 'consistency',
    id: 'southern-sydney',
    description: 'Southern hemisphere — Sydney, Australia',
    reason: 'No Rodden-rated reference; asserts southern-latitude house/angle self-consistency.',
    birth: {
      date: '1988-12-25',
      time: '06:30',
      timeKnown: true,
      lat: -33.8688,
      lon: 151.2093,
      tzIana: 'Australia/Sydney',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Capricorn',
  },

  // 6) Near the equator — Quito, Ecuador (~0° latitude).
  {
    kind: 'consistency',
    id: 'equator-quito',
    description: 'Near-equator — Quito, Ecuador (~0.18°S)',
    reason: 'Equatorial latitude stresses house division; no Rodden-rated reference obtained.',
    birth: {
      date: '1995-03-30',
      time: '14:15',
      timeKnown: true,
      lat: -0.1807,
      lon: -78.4678,
      tzIana: 'America/Guayaquil',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Aries',
  },

  // 7) High latitude — Tromsø, Norway (~69.6°N). Placidus is degenerate this far
  //    north; the engine must still return a usable chart without throwing.
  {
    kind: 'consistency',
    id: 'high-lat-tromso-placidus',
    description: 'High latitude — Tromsø, Norway (~69.6°N), Placidus (degenerate)',
    reason:
      'Above the polar circle Placidus house cusps are mathematically degenerate; there is no single "correct" reference. We assert the engine returns a chart and 12 cusps without crashing.',
    birth: {
      date: '1979-11-20',
      time: '03:00',
      timeKnown: true,
      lat: 69.6492,
      lon: 18.9553,
      tzIana: 'Europe/Oslo',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Scorpio',
  },

  // 8) High latitude with whole-sign houses (well-defined everywhere).
  {
    kind: 'consistency',
    id: 'high-lat-reykjavik-whole-sign',
    description: 'High latitude — Reykjavík (~64.1°N), whole-sign houses',
    reason:
      'Whole-sign houses are defined at any latitude; no Rodden reference, asserts coherence.',
    birth: {
      date: '2001-06-21',
      time: '12:00',
      timeKnown: true,
      lat: 64.1466,
      lon: -21.9426,
      tzIana: 'Atlantic/Reykjavik',
      houseSystem: 'whole_sign',
    },
    // 21 Jun at noon is the solstice cusp: the Sun has just entered Cancer (~0.2°).
    expectSunSign: 'Cancer',
  },

  // 9) Half-hour timezone — India Standard Time (+05:30).
  {
    kind: 'consistency',
    id: 'half-hour-tz-india',
    description: 'Half-hour timezone — Mumbai, India (IST +05:30)',
    reason: 'Stresses the half-hour offset in the time→UT conversion; no Rodden-rated reference.',
    birth: {
      date: '1975-08-15',
      time: '23:45',
      timeKnown: true,
      lat: 19.076,
      lon: 72.8777,
      tzIana: 'Asia/Kolkata',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Leo',
  },

  // 10) Three-quarter-hour timezone — Nepal (+05:45), the oddest common offset.
  {
    kind: 'consistency',
    id: 'quarter-hour-tz-nepal',
    description: 'Quarter-hour timezone — Kathmandu, Nepal (+05:45)',
    reason: 'Nepal +05:45 is the rarest offset; stresses sub-hour UT math. No reference.',
    birth: {
      date: '1992-04-13',
      time: '09:10',
      timeKnown: true,
      lat: 27.7172,
      lon: 85.324,
      tzIana: 'Asia/Kathmandu',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Aries',
  },

  // 11) Half-hour timezone — Iran (+03:30), with its own DST history.
  {
    kind: 'consistency',
    id: 'half-hour-tz-iran',
    description: 'Half-hour timezone — Tehran, Iran (+03:30)',
    reason: 'Iran +03:30 plus historical Iranian DST; no Rodden reference obtained.',
    birth: {
      date: '1983-09-23',
      time: '05:20',
      timeKnown: true,
      lat: 35.6892,
      lon: 51.389,
      tzIana: 'Asia/Tehran',
      houseSystem: 'placidus',
    },
    // 23 Sep is the equinox cusp: the Sun is still at ~29.5° Virgo, entering Libra.
    expectSunSign: 'Virgo',
  },

  // 12) Historical DST oddity — US wartime "War Time", 1943.
  {
    kind: 'consistency',
    id: 'pre1970-us-war-time-1943',
    description: 'Pre-1970 US War Time — New York, Feb 1943 (year-round DST)',
    reason:
      'During WWII the US observed year-round "War Time"; the IANA tz-db encodes this but pre-1970 coverage carries genuine uncertainty. No Rodden-rated reference.',
    birth: {
      date: '1943-02-10',
      time: '04:30',
      timeKnown: true,
      lat: 40.7128,
      lon: -74.006,
      tzIana: 'America/New_York',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Aquarius',
  },

  // 13) Pre-1970 southern hemisphere — Buenos Aires, 1955.
  {
    kind: 'consistency',
    id: 'pre1970-southern-buenos-aires',
    description: 'Pre-1970 southern hemisphere — Buenos Aires, 1955',
    reason:
      'Argentina has a tangled DST/offset history before 1970; no Rodden-rated reference. Stresses pre-tz-db + southern latitude together.',
    birth: {
      date: '1955-07-09',
      time: '21:00',
      timeKnown: true,
      lat: -34.6037,
      lon: -58.3816,
      tzIana: 'America/Argentina/Buenos_Aires',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Cancer',
  },

  // 14) Pre-1970 with half-hour tz — India, 1949.
  {
    kind: 'consistency',
    id: 'pre1970-india-1949',
    description: 'Pre-1970 + half-hour tz — Kolkata, India, 1949',
    reason:
      'Combines pre-1970 uncertainty with the +05:30 offset (and India briefly had +06:30 around then); no Rodden reference.',
    birth: {
      date: '1949-01-26',
      time: '08:00',
      timeKnown: true,
      lat: 22.5726,
      lon: 88.3639,
      tzIana: 'Asia/Kolkata',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Aquarius',
  },

  // 15) Sign cusp — Sun within minutes of the Aries/Taurus boundary.
  //     20 Apr is the classic Aries↔Taurus cusp date.
  {
    kind: 'consistency',
    id: 'sign-cusp-aries-taurus',
    description: 'Sun on the Aries/Taurus cusp — 20 Apr',
    reason:
      'Cusp date: the Sun sign legitimately depends on the exact year/time, so a single fixed reference sign would be misleading. We assert the Sun is within ~1° of the 30° Aries boundary (sign-coherence), not a celebrity reference.',
    birth: {
      date: '1987-04-20',
      time: '12:00',
      timeKnown: true,
      lat: 40.4168,
      lon: -3.7038,
      tzIana: 'Europe/Madrid',
      houseSystem: 'placidus',
    },
    // Sun sign intentionally not asserted (cusp) — handled specially in the test.
  },

  // 16) Date-line / far-east tz — Auckland, NZ (southern + +12/+13 DST).
  {
    kind: 'consistency',
    id: 'dateline-auckland',
    description: 'Far-east timezone — Auckland, NZ (southern, +13 DST)',
    reason:
      'Large positive offset near the date line with southern-hemisphere DST; no Rodden reference.',
    birth: {
      date: '2005-01-05',
      time: '02:30',
      timeKnown: true,
      lat: -36.8485,
      lon: 174.7633,
      tzIana: 'Pacific/Auckland',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Capricorn',
  },

  // 17) Far-west tz — Honolulu (no DST, -10:00).
  {
    kind: 'consistency',
    id: 'honolulu-no-dst',
    description: 'Far-west timezone — Honolulu (-10:00, no DST)',
    reason: 'Large negative offset, no DST; no Rodden reference.',
    birth: {
      date: '1998-11-07',
      time: '18:50',
      timeKnown: true,
      lat: 21.3069,
      lon: -157.8583,
      tzIana: 'Pacific/Honolulu',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Scorpio',
  },

  // 18) Koch houses at mid latitude (exercises a different house algorithm).
  {
    kind: 'consistency',
    id: 'koch-berlin',
    description: 'Koch houses — Berlin, mid latitude',
    reason: 'Exercises the Koch house algorithm path; no Rodden reference.',
    birth: {
      date: '2010-10-10',
      time: '10:10',
      timeKnown: true,
      lat: 52.52,
      lon: 13.405,
      tzIana: 'Europe/Berlin',
      houseSystem: 'koch',
    },
    expectSunSign: 'Libra',
  },

  // 19) Equal houses near the equator — Singapore.
  {
    kind: 'consistency',
    id: 'equal-singapore',
    description: 'Equal houses — Singapore (~1.3°N)',
    reason: 'Equal-house path near the equator; no Rodden reference.',
    birth: {
      date: '2018-02-19',
      time: '00:05',
      timeKnown: true,
      lat: 1.3521,
      lon: 103.8198,
      tzIana: 'Asia/Singapore',
      houseSystem: 'equal',
    },
    // 19 Feb is the Aquarius/Pisces cusp: the Sun is at ~29.9° Aquarius here.
    expectSunSign: 'Aquarius',
  },

  // 20) Leap day birth — 29 Feb, to exercise calendar handling.
  {
    kind: 'consistency',
    id: 'leap-day-2000',
    description: 'Leap-day birth — 29 Feb 2000, Paris',
    reason: 'Calendar edge case (leap day); no Rodden reference.',
    birth: {
      date: '2000-02-29',
      time: '16:45',
      timeKnown: true,
      lat: 48.8566,
      lon: 2.3522,
      tzIana: 'Europe/Paris',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Pisces',
  },

  // 21) Pre-1970 high-precision-ish modern source check — JFK (Rodden AA).
  //     We keep this as consistency-only because we did not fetch exact-degree
  //     reference values for every body from a citable source; it still exercises
  //     a 1917 US Eastern-time birth.
  {
    kind: 'consistency',
    id: 'pre1970-jfk-1917',
    description: 'Pre-1970 — JFK, 29 May 1917, Brookline MA (US Eastern)',
    reason:
      'Pre-1970 US birth; we did not capture citable exact-degree references for all bodies, so this is consistency-only. Stresses 1917 tz handling.',
    birth: {
      date: '1917-05-29',
      time: '15:00',
      timeKnown: true,
      lat: 42.3318,
      lon: -71.1212,
      tzIana: 'America/New_York',
      houseSystem: 'placidus',
    },
    expectSunSign: 'Gemini',
  },
];
