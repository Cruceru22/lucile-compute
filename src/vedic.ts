/**
 * TASK D5 — Vedic depth: Nakshatras + Vimshottari Dasha.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NAKSHATRAS (lunar mansions)
 * ────────────────────────────────────────────────────────────────────────────
 * The sidereal zodiac (360°) is divided into 27 equal nakshatras of
 *   360° / 27 = 13°20′ = 13.333…° = 800′ each.
 * Ashwini (index 0) begins at 0° SIDEREAL Aries; nakshatras run in zodiacal order
 * from there. A body's nakshatra index is therefore
 *   index = floor(siderealLongitude / 13.3333…°)   (0..26)
 * Each nakshatra is further split into 4 PADAS of 800′/4 = 200′ = 3°20′ each:
 *   pada = floor((siderealLongitude mod 13.3333…°) / 3.3333…°) + 1   (1..4)
 *
 * Longitudes MUST be sidereal (Lahiri ayanamsa here, reusing C6). The MOON's
 * nakshatra is the key placement: it seeds the Vimshottari dasha.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * VIMSHOTTARI DASHA (the 120-year planetary-period system)
 * ────────────────────────────────────────────────────────────────────────────
 * The nine dasha lords cycle in this FIXED canonical sequence with these year
 * lengths (totalling exactly 120 years — "Vimshottari" = 120):
 *   Ketu 7, Venus 20, Sun 6, Moon 10, Mars 7, Rahu 18, Jupiter 16, Saturn 19,
 *   Mercury 17.
 * Each of the 27 nakshatras is "ruled" by one of these nine lords, repeating in
 * the same order three times (27 = 3 × 9): Ashwini→Ketu, Bharani→Venus,
 * Krittika→Sun, … and so the cycle repeats. So
 *   nakshatraLord(index) = DASHA_SEQUENCE[index mod 9].
 *
 * Birth dasha & elapsed fraction:
 *   The birth (first) Maha-dasha lord = the lord of the Moon's nakshatra. The
 *   native is born PART-WAY through that dasha: the elapsed fraction equals how
 *   far the Moon has progressed THROUGH its nakshatra —
 *     fractionElapsed = (moonSidereal mod 13.3333…°) / 13.3333…°   ∈ [0, 1)
 *   So the first Maha-dasha's REMAINING time at birth is
 *     remaining = lordYears × (1 − fractionElapsed)
 *   and its NOTIONAL start (the virtual moment the dasha would have begun) is
 *     start = birth − lordYears × fractionElapsed.
 *   The timeline then runs the sequence forward from that lord, each subsequent
 *   Maha-dasha starting where the previous ended, for the full 120-year cycle
 *   (and we extend across the cycle boundary so ~120y are covered from birth).
 *
 * Antar-dasha (sub-periods / bhukti):
 *   Within a Maha-dasha of lord L the nine Antar-dasha sub-periods run in the
 *   SAME sequence STARTING from L (L's own sub-period first), each proportional
 *   to its lord's share of the 120-year cycle:
 *     antarYears(L, sub) = mahaYears(L) × dashaYears(sub) / 120.
 *   The nine Antar-dashas of a Maha-dasha therefore sum exactly to the
 *   Maha-dasha length (Σ dashaYears(sub) / 120 = 120/120 = 1).
 *
 * Date arithmetic:
 *   The dasha year is the SIDEREAL year (the classical convention is 365.25
 *   days/year; we use the more precise sidereal year 365.25636 days so dates
 *   line up with professional software). Periods are added as day-offsets from
 *   the birth instant and emitted as ISO datetimes.
 *
 * Sources / convention citations:
 *   - Nakshatra division & padas: B.V. Raman, "Hindu Predictive Astrology";
 *     standard 27 × 13°20′ scheme starting Ashwini at 0° sidereal Aries.
 *   - Vimshottari sequence & lord-years (Ketu 7 … Mercury 17 = 120y) and the
 *     nakshatra→lord assignment repeating every 9: classical (Parashara,
 *     "Brihat Parashara Hora Shastra"); matches Astrosage/Astrotalk output.
 *
 * All functions here are PURE (no ephemeris/IO) so they are exhaustively unit
 * tested; the only impure part is reading the Moon's sidereal longitude, done in
 * {@link computeVedic} via the existing C6 sidereal path.
 */
import type { Ayanamsa, BirthData, PlanetName } from '@astroapp/shared';
import { DateTime } from 'luxon';

import { BODIES, norm360 } from './astro.js';
import {
  ayanamsaDegrees,
  getBackend,
  siderealCalcFlags,
  sweph,
  withSidereal,
} from './ephemeris.js';
import { resolveBirthInstant } from './time.js';

/** Arc span of one nakshatra, in degrees (360 / 27). */
export const NAKSHATRA_DEG = 360 / 27; // 13.3333…
/** Arc span of one pada, in degrees (a quarter of a nakshatra). */
export const PADA_DEG = NAKSHATRA_DEG / 4; // 3.3333…

/**
 * Length of one dasha "year" in days. The classical texts often use 365.25; we
 * use the sidereal year so the emitted calendar dates match professional Vedic
 * software (which seeds the dasha from a sidereal reference).
 */
export const DASHA_YEAR_DAYS = 365.25636;

/** Total years in one Vimshottari cycle (the "120" in Vimshottari). */
export const VIMSHOTTARI_TOTAL_YEARS = 120;

/** A Vimshottari dasha lord (the nine grahas in the cycle). */
export type DashaLord =
  | 'Ketu'
  | 'Venus'
  | 'Sun'
  | 'Moon'
  | 'Mars'
  | 'Rahu'
  | 'Jupiter'
  | 'Saturn'
  | 'Mercury';

/**
 * The Vimshottari lord sequence with each lord's period in years, in canonical
 * order. The order AND the year values are fixed by tradition; do not reorder.
 * The years sum to exactly {@link VIMSHOTTARI_TOTAL_YEARS} (120).
 */
export const DASHA_SEQUENCE: ReadonlyArray<{ lord: DashaLord; years: number }> = [
  { lord: 'Ketu', years: 7 },
  { lord: 'Venus', years: 20 },
  { lord: 'Sun', years: 6 },
  { lord: 'Moon', years: 10 },
  { lord: 'Mars', years: 7 },
  { lord: 'Rahu', years: 18 },
  { lord: 'Jupiter', years: 16 },
  { lord: 'Saturn', years: 19 },
  { lord: 'Mercury', years: 17 },
] as const;

/** The 27 nakshatra names, in zodiacal order starting at 0° sidereal Aries. */
export const NAKSHATRA_NAMES: readonly string[] = [
  'Ashwini',
  'Bharani',
  'Krittika',
  'Rohini',
  'Mrigashira',
  'Ardra',
  'Punarvasu',
  'Pushya',
  'Ashlesha',
  'Magha',
  'Purva Phalguni',
  'Uttara Phalguni',
  'Hasta',
  'Chitra',
  'Swati',
  'Vishakha',
  'Anuradha',
  'Jyeshtha',
  'Mula',
  'Purva Ashadha',
  'Uttara Ashadha',
  'Shravana',
  'Dhanishta',
  'Shatabhisha',
  'Purva Bhadrapada',
  'Uttara Bhadrapada',
  'Revati',
] as const;

/** Number of years a given Vimshottari lord rules. */
export function lordYears(lord: DashaLord): number {
  const entry = DASHA_SEQUENCE.find((d) => d.lord === lord);
  // The union type guarantees a match; assert for total-function clarity.
  return (entry as { lord: DashaLord; years: number }).years;
}

/**
 * Ruling lord of a nakshatra by index (0..26). The nine lords repeat every nine
 * nakshatras (27 = 3 × 9), starting with Ketu at Ashwini.
 */
export function nakshatraLord(index: number): DashaLord {
  const i = ((index % 27) + 27) % 27;
  return (DASHA_SEQUENCE[i % 9] as { lord: DashaLord }).lord;
}

/** The position of `lord` within the canonical 9-lord sequence (0..8). */
export function lordSequenceIndex(lord: DashaLord): number {
  return DASHA_SEQUENCE.findIndex((d) => d.lord === lord);
}

/** A body placed into its nakshatra. */
export interface NakshatraPlacement {
  /** Sidereal ecliptic longitude used, in [0, 360). */
  siderealLongitude: number;
  /** Nakshatra index 0..26 (0 = Ashwini). */
  index: number;
  /** Nakshatra name. */
  name: string;
  /** Pada within the nakshatra, 1..4. */
  pada: number;
  /** Ruling Vimshottari lord of this nakshatra. */
  lord: DashaLord;
  /** Fraction [0,1) of the way THROUGH this nakshatra (drives the dasha seed). */
  fractionTraversed: number;
}

/**
 * Map a sidereal longitude to its nakshatra (index, name, pada, lord) and the
 * fraction traversed through the nakshatra. PURE — wraps at 360°.
 */
export function nakshatraOf(siderealLongitude: number): NakshatraPlacement {
  const lon = norm360(siderealLongitude);
  // A mansion/pada boundary belongs to the HIGHER mansion (Vedic convention:
  // 13°20′ is the start of Bharani, not the end of Ashwini). Floating-point
  // representation of n×(360/27) can land an ulp BELOW the true boundary
  // (e.g. 13.333…314 instead of 13.333…334), which would mis-bucket an exact
  // boundary into the lower mansion. EPS snaps a value within an ulp of a
  // boundary up to it before flooring. Real ephemeris longitudes never sit
  // exactly on a boundary, so this only affects synthetic exact-boundary inputs.
  const EPS = 1e-9;
  const index = Math.floor((lon + EPS) / NAKSHATRA_DEG) % 27;
  const within = Math.max(0, lon - index * NAKSHATRA_DEG); // [0, NAKSHATRA_DEG)
  const pada = Math.floor((within + EPS) / PADA_DEG) + 1; // 1..4
  return {
    siderealLongitude: lon,
    index,
    name: NAKSHATRA_NAMES[index] as string,
    pada: Math.min(4, Math.max(1, pada)),
    lord: nakshatraLord(index),
    fractionTraversed: within / NAKSHATRA_DEG,
  };
}

/** One Maha-dasha (major period) on the timeline. */
export interface MahaDasha {
  lord: DashaLord;
  /** Full nominal length of this dasha, in years. */
  years: number;
  /** Start instant (ISO UTC). For the first dasha this is the NOTIONAL start. */
  start: string;
  /** End instant (ISO UTC). */
  end: string;
}

/** One Antar-dasha (sub-period / bhukti) within a Maha-dasha. */
export interface AntarDasha {
  /** The Maha-dasha lord this sub-period belongs to. */
  maha: DashaLord;
  /** The sub-period lord. */
  lord: DashaLord;
  years: number;
  start: string;
  end: string;
}

/** The full Vimshottari dasha result. */
export interface VimshottariResult {
  /** The Moon's nakshatra (the seed of the whole system). */
  moonNakshatra: NakshatraPlacement;
  /** Birth Maha-dasha lord (= the Moon-nakshatra lord). */
  birthLord: DashaLord;
  /** Fraction [0,1) of the first Maha-dasha already elapsed at birth. */
  firstDashaElapsedFraction: number;
  /** Remaining years of the first Maha-dasha at birth. */
  firstDashaRemainingYears: number;
  /** Maha-dasha timeline from the notional first-dasha start, covering ~120y. */
  mahaDashas: MahaDasha[];
  /** Index into `mahaDashas` of the dasha active "now" (when supplied), else -1. */
  currentMahaIndex: number;
  /** Antar-dasha breakdown of the CURRENT Maha-dasha (or the first, if no `now`). */
  currentAntarDashas: AntarDasha[];
  /** Index into `currentAntarDashas` of the active sub-period, or -1. */
  currentAntarIndex: number;
  /** Conventions used (transparency for the client). */
  method: {
    ayanamsa: Ayanamsa;
    yearDays: number;
    totalYears: number;
  };
}

/** Add `years` dasha-years (in days) to an ISO instant, returning ISO UTC. */
function addDashaYears(startIso: string, years: number): string {
  const dt = DateTime.fromISO(startIso, { zone: 'utc' });
  return (
    dt
      .plus({ days: years * DASHA_YEAR_DAYS })
      .toUTC()
      .toISO({ suppressMilliseconds: true }) ?? startIso
  );
}

/**
 * Build the Antar-dasha (sub-period) breakdown of a single Maha-dasha. The nine
 * sub-periods run in the canonical sequence STARTING from the Maha lord; each is
 * proportional to its lord's share of 120 years, so they sum exactly to the
 * Maha-dasha length. PURE.
 */
export function antarDashas(maha: DashaLord, mahaStartIso: string): AntarDasha[] {
  const mahaYears = lordYears(maha);
  const startIdx = lordSequenceIndex(maha);
  const out: AntarDasha[] = [];
  let cursor = mahaStartIso;
  for (let i = 0; i < 9; i++) {
    const entry = DASHA_SEQUENCE[(startIdx + i) % 9] as { lord: DashaLord; years: number };
    const years = (mahaYears * entry.years) / VIMSHOTTARI_TOTAL_YEARS;
    const end = addDashaYears(cursor, years);
    out.push({ maha, lord: entry.lord, years, start: cursor, end });
    cursor = end;
  }
  return out;
}

/**
 * Compute the Vimshottari dasha from the Moon's sidereal longitude and the birth
 * instant. PURE — the impure Moon lookup happens in {@link computeVedic}.
 *
 * @param moonSiderealLongitude Moon's sidereal ecliptic longitude (deg).
 * @param birthIso              Birth instant, ISO UTC.
 * @param nowIso                Optional "now" to mark the current Maha/Antar.
 * @param ayanamsa              Ayanamsa label (echoed in `method`).
 */
export function computeVimshottari(
  moonSiderealLongitude: number,
  birthIso: string,
  nowIso: string | undefined,
  ayanamsa: Ayanamsa,
): VimshottariResult {
  const moonNakshatra = nakshatraOf(moonSiderealLongitude);
  const birthLord = moonNakshatra.lord;
  const elapsedFraction = moonNakshatra.fractionTraversed;

  const firstYears = lordYears(birthLord);
  const firstRemaining = firstYears * (1 - elapsedFraction);

  // The notional start of the first Maha-dasha: birth minus the elapsed portion.
  const firstStart = addDashaYears(birthIso, -(firstYears * elapsedFraction));

  // Walk the sequence forward from the birth lord, emitting one whole cycle of 9
  // Maha-dashas from the notional start — that spans 120 years from `firstStart`.
  // Known limitation: the notional start sits before birth, so a `now` lookup for
  // a very old subject (≈ birth + 120y) can fall past the last period; acceptable
  // for realistic ages.
  const startIdx = lordSequenceIndex(birthLord);
  const mahaDashas: MahaDasha[] = [];
  let cursor = firstStart;
  for (let i = 0; i < 9; i++) {
    const entry = DASHA_SEQUENCE[(startIdx + i) % 9] as { lord: DashaLord; years: number };
    const end = addDashaYears(cursor, entry.years);
    mahaDashas.push({ lord: entry.lord, years: entry.years, start: cursor, end });
    cursor = end;
  }

  // Locate the current Maha-dasha (when a `now` is supplied).
  let currentMahaIndex = -1;
  if (nowIso) {
    const now = DateTime.fromISO(nowIso, { zone: 'utc' });
    for (let i = 0; i < mahaDashas.length; i++) {
      const m = mahaDashas[i] as MahaDasha;
      const s = DateTime.fromISO(m.start, { zone: 'utc' });
      const e = DateTime.fromISO(m.end, { zone: 'utc' });
      if (now >= s && now < e) {
        currentMahaIndex = i;
        break;
      }
    }
  }

  // Antar-dasha breakdown of the current Maha-dasha (fallback: the first one so
  // the screen always has a sub-period table to show).
  const focusIndex = currentMahaIndex >= 0 ? currentMahaIndex : 0;
  const focus = mahaDashas[focusIndex] as MahaDasha;
  const currentAntarDashas = antarDashas(focus.lord, focus.start);

  let currentAntarIndex = -1;
  if (nowIso) {
    const now = DateTime.fromISO(nowIso, { zone: 'utc' });
    for (let i = 0; i < currentAntarDashas.length; i++) {
      const a = currentAntarDashas[i] as AntarDasha;
      const s = DateTime.fromISO(a.start, { zone: 'utc' });
      const e = DateTime.fromISO(a.end, { zone: 'utc' });
      if (now >= s && now < e) {
        currentAntarIndex = i;
        break;
      }
    }
  }

  return {
    moonNakshatra,
    birthLord,
    firstDashaElapsedFraction: elapsedFraction,
    firstDashaRemainingYears: firstRemaining,
    mahaDashas,
    currentMahaIndex,
    currentAntarDashas,
    currentAntarIndex,
    method: { ayanamsa, yearDays: DASHA_YEAR_DAYS, totalYears: VIMSHOTTARI_TOTAL_YEARS },
  };
}

/** A body's nakshatra entry in the /vedic response. */
export interface BodyNakshatra extends NakshatraPlacement {
  body: PlanetName;
  /** True for the Moon (the key placement). */
  isKey: boolean;
}

/** The full /vedic response. */
export interface VedicResult {
  /** Birth instant the computation used (ISO UTC). */
  birthInstant: string;
  /** True when the birth time was known (planets exact); false → noon fallback. */
  timeKnown: boolean;
  usedNoonFallback: boolean;
  /** Ayanamsa applied (Lahiri by default for Vedic). */
  ayanamsa: Ayanamsa;
  /** Ayanamsa offset in degrees, for transparency. */
  ayanamsaDegrees: number;
  ephemerisBackend: 'swiss' | 'moshier';
  /** Bodies omitted because the active backend lacks them. */
  unavailableBodies: PlanetName[];
  /** Each computed body's nakshatra (Moon flagged `isKey`). */
  nakshatras: BodyNakshatra[];
  /** The Vimshottari dasha timeline + current periods. */
  dasha: VimshottariResult;
}

/**
 * Compute the full Vedic result (nakshatras for all bodies + Vimshottari dasha)
 * for a birth, in the SIDEREAL frame (Lahiri by default — Vedic convention).
 *
 * Reuses the C6 sidereal path: positions are computed inside {@link withSidereal}
 * with {@link siderealCalcFlags}, then the global sid-state is always reset.
 *
 * @param birth  The birth data (sidereal frame; ayanamsa defaults to Lahiri).
 * @param now    Optional "now" ISO to mark the current Maha/Antar dasha. Defaults
 *               to the actual current time when omitted.
 */
export function computeVedic(birth: BirthData, now?: string): VedicResult {
  // Vedic is sidereal by definition; default the ayanamsa to Lahiri.
  const ayanamsa: Ayanamsa = birth.ayanamsa ?? 'lahiri';

  const { resolved, usedNoonFallback } = resolveBirthInstant(
    birth.date,
    birth.time,
    birth.timeKnown,
    birth.tzIana,
  );

  const flags = siderealCalcFlags();
  const computed = withSidereal(ayanamsa, () => {
    const positions: BodyNakshatra[] = [];
    const unavailable: PlanetName[] = [];
    let moonLon = 0;
    for (const b of BODIES) {
      try {
        const res = sweph.calc_ut(resolved.jdUt, b.id, flags);
        if (res.flag < 0) throw new Error(res.error);
        const lon = norm360(res.data[0]);
        const placement = nakshatraOf(lon);
        const isKey = b.name === 'Moon';
        if (isKey) moonLon = lon;
        positions.push({ ...placement, body: b.name, isKey });
      } catch {
        unavailable.push(b.name);
      }
    }
    return { positions, unavailable, moonLon };
  });

  const ayanDeg = ayanamsaDegrees(resolved.jdUt, ayanamsa);
  const nowIso = now ?? DateTime.utc().toISO({ suppressMilliseconds: true }) ?? undefined;
  const dasha = computeVimshottari(computed.moonLon, resolved.utc, nowIso, ayanamsa);

  return {
    birthInstant: resolved.utc,
    timeKnown: birth.timeKnown,
    usedNoonFallback,
    ayanamsa,
    ayanamsaDegrees: ayanDeg,
    ephemerisBackend: getBackend(),
    unavailableBodies: computed.unavailable,
    nakshatras: computed.positions,
    dasha,
  };
}
