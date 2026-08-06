/**
 * Planetary hours — PURE Chaldean-order logic (TASK C3).
 *
 * This module contains the entire traditional planetary-hours rule set with NO
 * dependency on Swiss Ephemeris, time zones, or I/O — so it is fully unit-
 * testable on its own. The sweph-dependent part (computing sunrise/sunset/next
 * sunrise) lives in `planetaryHours.ts`, which feeds the three instants into the
 * builder here.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT PLANETARY HOURS ARE (and how this models them)
 * ──────────────────────────────────────────────────────────────────────────
 * Traditional planetary hours are SEASONAL / UNEQUAL hours:
 *   - The DAY span (sunrise → sunset) is split into 12 equal "day hours".
 *   - The NIGHT span (sunset → next sunrise) is split into 12 equal "night
 *     hours".
 *   - Day-hours and night-hours differ in length except near the equinoxes
 *     (when day ≈ night, all 24 hours are ≈ equal).
 *
 * Each hour is ruled by a planet following the CHALDEAN ORDER (slowest →
 * fastest mean apparent motion): Saturn, Jupiter, Mars, Sun, Venus, Mercury,
 * Moon — repeating cyclically.
 *
 * The 1st hour of the DAY is ruled by the planet that rules that WEEKDAY
 * (the "day ruler"): Sun→Sunday, Moon→Monday, Mars→Tuesday, Mercury→Wednesday,
 * Jupiter→Thursday, Venus→Friday, Saturn→Saturday. Each subsequent hour (the 12
 * day hours then the 12 night hours, 24 in all) advances ONE step along the
 * Chaldean order. A neat invariant falls out: the 25th hour — i.e. the NEXT
 * day's sunrise hour — is ruled by the planet that rules the next weekday. We
 * test exactly that.
 *
 * The weekday is taken at the LOCAL date of sunrise (the caller passes that).
 */

/** The seven traditional planets, as ruler names. */
export type ChaldeanRuler = 'Saturn' | 'Jupiter' | 'Mars' | 'Sun' | 'Venus' | 'Mercury' | 'Moon';

/**
 * The Chaldean order, slowest → fastest. Hour rulers step forward through this
 * cycle, one planet per hour.
 */
export const CHALDEAN_ORDER: readonly ChaldeanRuler[] = [
  'Saturn',
  'Jupiter',
  'Mars',
  'Sun',
  'Venus',
  'Mercury',
  'Moon',
] as const;

/**
 * The planet ruling each weekday, indexed by JS `Date.getDay()` /
 * Luxon `weekday % 7` where 0 = Sunday. This planet rules the FIRST hour of the
 * daytime on that weekday.
 */
export const WEEKDAY_RULER: readonly ChaldeanRuler[] = [
  'Sun', // 0 Sunday
  'Moon', // 1 Monday
  'Mars', // 2 Tuesday
  'Mercury', // 3 Wednesday
  'Jupiter', // 4 Thursday
  'Venus', // 5 Friday
  'Saturn', // 6 Saturday
] as const;

/** Human weekday names, indexed the same way (0 = Sunday). */
export const WEEKDAY_NAME: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The ruler of the 1st daytime hour for `weekday` (0 = Sunday … 6 = Saturday).
 * @throws RangeError if `weekday` is out of range.
 */
export function dayRulerForWeekday(weekday: number): ChaldeanRuler {
  const ruler = WEEKDAY_RULER[weekday];
  if (ruler === undefined) {
    throw new RangeError(`weekday must be 0..6 (0 = Sunday); got ${weekday}`);
  }
  return ruler;
}

/** Index of a ruler within the Chaldean cycle. */
export function chaldeanIndexOf(ruler: ChaldeanRuler): number {
  return CHALDEAN_ORDER.indexOf(ruler);
}

/**
 * Build the full 24-ruler chain for a day, starting from the weekday's day
 * ruler at hour 0 (the first daytime hour) and advancing one Chaldean step per
 * hour. Index 0..11 are the day hours, 12..23 the night hours.
 */
export function chaldeanChain(weekday: number): ChaldeanRuler[] {
  const start = chaldeanIndexOf(dayRulerForWeekday(weekday));
  const chain: ChaldeanRuler[] = [];
  for (let i = 0; i < 24; i++) {
    chain.push(CHALDEAN_ORDER[(start + i) % CHALDEAN_ORDER.length]!);
  }
  return chain;
}

/** A single planetary hour. */
export interface PlanetaryHour {
  /** 1-based index within its half (1..12). */
  index: number;
  /** Day hour or night hour. */
  period: 'day' | 'night';
  /** The ruling planet. */
  ruler: ChaldeanRuler;
  /** Start instant, ISO 8601 (zoned per the caller). */
  start: string;
  /** End instant, ISO 8601 (zoned per the caller). */
  end: string;
  /** Length of this hour, in minutes (a "seasonal" hour, not 60). */
  lengthMinutes: number;
}

/**
 * Split a time interval `[startMs, endMs)` (epoch milliseconds) into 12 equal
 * sub-intervals, mapping each onto a {@link PlanetaryHour} using `rulers[i]`,
 * `period`, and the `toIso` formatter (which zones the instant).
 *
 * Exported for direct testing of the 12-split + length invariants.
 *
 * @param startMs  Interval start (epoch ms).
 * @param endMs    Interval end (epoch ms); must be > startMs.
 * @param rulers   Exactly 12 rulers, one per resulting hour.
 * @param period   'day' or 'night' (stamped on every hour).
 * @param toIso    Maps an epoch-ms instant to a zoned ISO string.
 */
export function splitIntoTwelve(
  startMs: number,
  endMs: number,
  rulers: readonly ChaldeanRuler[],
  period: 'day' | 'night',
  toIso: (epochMs: number) => string,
): PlanetaryHour[] {
  if (!(endMs > startMs)) {
    throw new RangeError(`interval end (${endMs}) must be after start (${startMs})`);
  }
  if (rulers.length !== 12) {
    throw new RangeError(`splitIntoTwelve needs exactly 12 rulers; got ${rulers.length}`);
  }
  const span = endMs - startMs;
  const step = span / 12;
  const hours: PlanetaryHour[] = [];
  for (let i = 0; i < 12; i++) {
    // Compute boundaries from the fraction to avoid drift; the last hour ends
    // exactly on `endMs`.
    const hStart = i === 0 ? startMs : startMs + step * i;
    const hEnd = i === 11 ? endMs : startMs + step * (i + 1);
    hours.push({
      index: i + 1,
      period,
      ruler: rulers[i]!,
      start: toIso(hStart),
      end: toIso(hEnd),
      lengthMinutes: (hEnd - hStart) / 60000,
    });
  }
  return hours;
}

/** The fully-built planetary-hours table for one day. */
export interface PlanetaryHoursTable {
  /** Weekday index of the sunrise date (0 = Sunday). */
  weekday: number;
  /** Weekday name of the sunrise date. */
  weekdayName: string;
  /** Planet ruling the whole day (= ruler of the 1st daytime hour). */
  dayRuler: ChaldeanRuler;
  /** The 24-ruler Chaldean chain (day hours then night hours). */
  rulerSequence: ChaldeanRuler[];
  /** The 12 day hours (sunrise → sunset). */
  dayHours: PlanetaryHour[];
  /** The 12 night hours (sunset → next sunrise). */
  nightHours: PlanetaryHour[];
  /** Seasonal day-hour length (minutes); day/night differ off the equinoxes. */
  dayHourLengthMinutes: number;
  /** Seasonal night-hour length (minutes). */
  nightHourLengthMinutes: number;
}

/**
 * Build the complete planetary-hours table from the three instants. This is the
 * heart of the feature and is PURE — the sweph layer supplies the instants and
 * the ISO formatter.
 *
 * @param sunriseMs       Sunrise on the date (epoch ms).
 * @param sunsetMs        Sunset on the date (epoch ms); must be after sunrise.
 * @param nextSunriseMs   Next day's sunrise (epoch ms); must be after sunset.
 * @param weekday         Weekday index at the LOCAL sunrise date (0 = Sunday).
 * @param toIso           Maps an epoch-ms instant to a zoned ISO string.
 */
export function buildPlanetaryHours(
  sunriseMs: number,
  sunsetMs: number,
  nextSunriseMs: number,
  weekday: number,
  toIso: (epochMs: number) => string,
): PlanetaryHoursTable {
  if (!(sunsetMs > sunriseMs)) {
    throw new RangeError('sunset must be after sunrise');
  }
  if (!(nextSunriseMs > sunsetMs)) {
    throw new RangeError('next sunrise must be after sunset');
  }
  const chain = chaldeanChain(weekday);
  const dayRulers = chain.slice(0, 12);
  const nightRulers = chain.slice(12, 24);

  const dayHours = splitIntoTwelve(sunriseMs, sunsetMs, dayRulers, 'day', toIso);
  const nightHours = splitIntoTwelve(sunsetMs, nextSunriseMs, nightRulers, 'night', toIso);

  return {
    weekday,
    weekdayName: WEEKDAY_NAME[weekday] ?? 'Unknown',
    dayRuler: dayRulers[0]!,
    rulerSequence: chain,
    dayHours,
    nightHours,
    dayHourLengthMinutes: (sunsetMs - sunriseMs) / 12 / 60000,
    nightHourLengthMinutes: (nextSunriseMs - sunsetMs) / 12 / 60000,
  };
}

/**
 * Find which planetary hour contains `nowMs`, returning its `{ period, index }`
 * (1-based index within the period), or `null` when `now` is outside the
 * sunrise → next-sunrise window the table covers. Pure.
 */
export function currentHour(
  table: PlanetaryHoursTable,
  nowMs: number,
  parseIso: (iso: string) => number,
): { period: 'day' | 'night'; index: number; ruler: ChaldeanRuler } | null {
  const all = [...table.dayHours, ...table.nightHours];
  for (const h of all) {
    const s = parseIso(h.start);
    const e = parseIso(h.end);
    if (nowMs >= s && nowMs < e) {
      return { period: h.period, index: h.index, ruler: h.ruler };
    }
  }
  return null;
}
