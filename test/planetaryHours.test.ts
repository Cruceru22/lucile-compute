/**
 * TASK C3 — planetary hours tests.
 *
 * Two layers:
 *  1. The PURE Chaldean-order core (no sweph): the weekday→day-ruler mapping,
 *     the 24-hour chain (incl. the classic "Sunday 1st hour = Sun; 25th hour =
 *     Monday's Moon" invariant), the 12-split correctness + length sums.
 *  2. The sweph-backed `computePlanetaryHours`: a real date/place sanity check
 *     (sunrise before sunset, day+night = 24h, weekday ruler invariant), an
 *     equinox ≈ equal-hour check, and the polar-day/night unavailable path.
 *
 * The default backend is Moshier (no `.se1` files); rise/set instants carry the
 * usual Moshier error but the structural invariants we assert hold regardless.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  buildPlanetaryHours,
  chaldeanChain,
  CHALDEAN_ORDER,
  dayRulerForWeekday,
  splitIntoTwelve,
  WEEKDAY_RULER,
  type ChaldeanRuler,
} from '../src/planetaryHoursCore.js';
import { computePlanetaryHours, jdUtToEpochMs, epochMsToJdUt } from '../src/planetaryHours.js';

/* -------------------------------------------------------------------------- */
/* Pure Chaldean core                                                         */
/* -------------------------------------------------------------------------- */

describe('Chaldean order + weekday rulers', () => {
  it('uses the canonical Chaldean sequence (slowest→fastest)', () => {
    expect(CHALDEAN_ORDER).toEqual([
      'Saturn',
      'Jupiter',
      'Mars',
      'Sun',
      'Venus',
      'Mercury',
      'Moon',
    ]);
  });

  it('maps each weekday to its traditional ruler', () => {
    expect(dayRulerForWeekday(0)).toBe('Sun'); // Sunday
    expect(dayRulerForWeekday(1)).toBe('Moon'); // Monday
    expect(dayRulerForWeekday(2)).toBe('Mars'); // Tuesday
    expect(dayRulerForWeekday(3)).toBe('Mercury'); // Wednesday
    expect(dayRulerForWeekday(4)).toBe('Jupiter'); // Thursday
    expect(dayRulerForWeekday(5)).toBe('Venus'); // Friday
    expect(dayRulerForWeekday(6)).toBe('Saturn'); // Saturday
    expect(WEEKDAY_RULER).toHaveLength(7);
  });

  it('rejects an out-of-range weekday', () => {
    expect(() => dayRulerForWeekday(7)).toThrow(RangeError);
    expect(() => dayRulerForWeekday(-1)).toThrow(RangeError);
  });
});

describe('24-hour Chaldean chain', () => {
  it('Sunday: 1st day-hour is the Sun, advancing one Chaldean step per hour', () => {
    const chain = chaldeanChain(0); // Sunday
    expect(chain).toHaveLength(24);
    expect(chain[0]).toBe('Sun'); // 1st daytime hour
    // Next steps from Sun: Venus, Mercury, Moon, Saturn, …
    expect(chain.slice(0, 5)).toEqual(['Sun', 'Venus', 'Mercury', 'Moon', 'Saturn']);
  });

  it('classic invariant: the hour AFTER the 24th (next sunrise) rules the next weekday', () => {
    // For every weekday, advancing 24 hours from its day ruler lands on the
    // ruler of the NEXT weekday's day — i.e. the next day's first sunrise hour.
    for (let wd = 0; wd < 7; wd++) {
      const chain = chaldeanChain(wd);
      const next = chaldeanChain((wd + 1) % 7);
      // The 25th hour = first hour of the next chain.
      const idxOf = (r: ChaldeanRuler) => CHALDEAN_ORDER.indexOf(r);
      const twentyFifth = CHALDEAN_ORDER[(idxOf(chain[0]!) + 24) % 7];
      expect(twentyFifth).toBe(next[0]);
    }
  });

  it('specifically: Sunday → next sunrise hour is Monday’s Moon', () => {
    const sunday = chaldeanChain(0);
    const idx = CHALDEAN_ORDER.indexOf(sunday[0]!); // Sun
    const twentyFifth = CHALDEAN_ORDER[(idx + 24) % 7];
    expect(twentyFifth).toBe('Moon'); // Monday's day ruler
    expect(dayRulerForWeekday(1)).toBe('Moon');
  });
});

describe('splitIntoTwelve', () => {
  const toIso = (ms: number) => new Date(ms).toISOString();

  it('produces 12 equal sub-intervals summing to the whole span', () => {
    const start = Date.UTC(2024, 5, 16, 6, 0, 0); // 06:00
    const end = Date.UTC(2024, 5, 16, 18, 0, 0); // 18:00 → 12h day
    const rulers = chaldeanChain(0).slice(0, 12);
    const hours = splitIntoTwelve(start, end, rulers, 'day', toIso);
    expect(hours).toHaveLength(12);
    // Each hour is 60 minutes for an exactly-12h day.
    for (const h of hours) expect(h.lengthMinutes).toBeCloseTo(60, 6);
    // Lengths sum to the full span (720 minutes).
    const total = hours.reduce((s, h) => s + h.lengthMinutes, 0);
    expect(total).toBeCloseTo(720, 6);
    // Contiguous: each hour's end is the next hour's start.
    for (let i = 0; i < 11; i++) expect(hours[i]!.end).toBe(hours[i + 1]!.start);
    // First starts at the span start, last ends at the span end.
    expect(hours[0]!.start).toBe(toIso(start));
    expect(hours[11]!.end).toBe(toIso(end));
    // 1-based indices.
    expect(hours.map((h) => h.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('rejects a non-positive span or wrong ruler count', () => {
    expect(() => splitIntoTwelve(10, 10, chaldeanChain(0).slice(0, 12), 'day', toIso)).toThrow();
    expect(() => splitIntoTwelve(0, 10, ['Sun'], 'day', toIso)).toThrow();
  });
});

describe('buildPlanetaryHours (pure)', () => {
  const toIso = (ms: number) => new Date(ms).toISOString();

  it('builds 12 day + 12 night hours with correct seasonal lengths', () => {
    // Asymmetric day/night: 10h day, 14h night.
    const sunrise = Date.UTC(2024, 11, 21, 7, 0, 0);
    const sunset = Date.UTC(2024, 11, 21, 17, 0, 0); // +10h
    const nextSunrise = Date.UTC(2024, 11, 22, 7, 0, 0); // +14h from sunset
    const t = buildPlanetaryHours(sunrise, sunset, nextSunrise, 6 /* Saturday */, toIso);

    expect(t.dayHours).toHaveLength(12);
    expect(t.nightHours).toHaveLength(12);
    expect(t.dayHourLengthMinutes).toBeCloseTo(50, 6); // 600min/12
    expect(t.nightHourLengthMinutes).toBeCloseTo(70, 6); // 840min/12
    // Day hours sum to the day span, night to the night span.
    expect(t.dayHours.reduce((s, h) => s + h.lengthMinutes, 0)).toBeCloseTo(600, 6);
    expect(t.nightHours.reduce((s, h) => s + h.lengthMinutes, 0)).toBeCloseTo(840, 6);

    // Saturday → Saturn rules the day + the 1st day hour.
    expect(t.dayRuler).toBe('Saturn');
    expect(t.dayHours[0]!.ruler).toBe('Saturn');
    // The night hours continue the same chain (hours 13..24).
    expect(t.rulerSequence).toHaveLength(24);
    expect(t.nightHours[0]!.ruler).toBe(t.rulerSequence[12]);
    // Day end joins night start (sunset).
    expect(t.dayHours[11]!.end).toBe(t.nightHours[0]!.start);
    expect(t.weekdayName).toBe('Saturday');
  });

  it('near the equinox, day and night hours are nearly equal', () => {
    // ~12h day, ~12h night.
    const sunrise = Date.UTC(2024, 2, 20, 6, 5, 0);
    const sunset = Date.UTC(2024, 2, 20, 18, 7, 0);
    const nextSunrise = Date.UTC(2024, 2, 21, 6, 3, 0);
    const t = buildPlanetaryHours(sunrise, sunset, nextSunrise, 3, toIso);
    expect(Math.abs(t.dayHourLengthMinutes - t.nightHourLengthMinutes)).toBeLessThan(2);
  });

  it('rejects out-of-order instants', () => {
    expect(() => buildPlanetaryHours(100, 50, 200, 0, toIso)).toThrow();
    expect(() => buildPlanetaryHours(100, 200, 150, 0, toIso)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* JD ↔ epoch conversion                                                      */
/* -------------------------------------------------------------------------- */

describe('jd ↔ epoch conversion', () => {
  it('round-trips and anchors the Unix epoch at JD 2440587.5', () => {
    expect(jdUtToEpochMs(2_440_587.5)).toBe(0);
    const jd = 2_460_000.25;
    expect(epochMsToJdUt(jdUtToEpochMs(jd))).toBeCloseTo(jd, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* sweph-backed compute                                                       */
/* -------------------------------------------------------------------------- */

describe('computePlanetaryHours — Lisbon, a known date', () => {
  // 2024-06-16 is a SUNDAY → 1st day hour ruled by the Sun.
  const lisbon = { date: '2024-06-16', lat: 38.7223, lon: -9.1393, tzIana: 'Europe/Lisbon' };

  it('returns 12 day + 12 night hours with sunrise<sunset and a Sunday Sun ruler', () => {
    const r = computePlanetaryHours(lisbon);
    expect(r.available).toBe(true);
    if (!r.available) return;

    expect(r.weekdayName).toBe('Sunday');
    expect(r.dayRuler).toBe('Sun');
    expect(r.dayHours).toHaveLength(12);
    expect(r.nightHours).toHaveLength(12);
    expect(r.dayHours[0]!.ruler).toBe('Sun');

    const sunrise = DateTime.fromISO(r.sunrise);
    const sunset = DateTime.fromISO(r.sunset);
    const nextSunrise = DateTime.fromISO(r.nextSunrise);
    expect(sunset.toMillis()).toBeGreaterThan(sunrise.toMillis());
    expect(nextSunrise.toMillis()).toBeGreaterThan(sunset.toMillis());

    // Day + night spans cover exactly one solar day (~24h ± a few minutes).
    const totalHours = (nextSunrise.toMillis() - sunrise.toMillis()) / 3_600_000;
    expect(totalHours).toBeGreaterThan(23.5);
    expect(totalHours).toBeLessThan(24.5);

    // First day hour starts at sunrise; last night hour ends at next sunrise.
    expect(r.dayHours[0]!.start).toBe(r.sunrise);
    expect(r.nightHours[11]!.end).toBe(r.nextSunrise);

    // Mid-June Lisbon: long day, so day hours are longer than night hours.
    expect(r.dayHourLengthMinutes).toBeGreaterThan(r.nightHourLengthMinutes);
  });

  it('flags the current hour when `now` is inside the window', () => {
    const r = computePlanetaryHours(lisbon);
    if (!r.available) throw new Error('expected available');
    // Pick the midpoint of the 3rd day hour as `now`.
    const third = r.dayHours[2]!;
    const mid = DateTime.fromISO(third.start)
      .plus({
        milliseconds:
          (DateTime.fromISO(third.end).toMillis() - DateTime.fromISO(third.start).toMillis()) / 2,
      })
      .toISO()!;
    const withNow = computePlanetaryHours({ ...lisbon, now: mid });
    if (!withNow.available) throw new Error('expected available');
    expect(withNow.current).not.toBeNull();
    expect(withNow.current).toMatchObject({ period: 'day', index: 3, ruler: third.ruler });
  });

  it('returns current:null when `now` is outside the window', () => {
    const r = computePlanetaryHours({ ...lisbon, now: '2024-06-15T03:00:00+01:00' });
    if (!r.available) throw new Error('expected available');
    expect(r.current).toBeNull();
  });

  it('near the equinox the hours are nearly equal length', () => {
    // Equinox ~2024-09-22; near the equator day≈night.
    const r = computePlanetaryHours({
      date: '2024-09-22',
      lat: 0,
      lon: 0,
      tzIana: 'UTC',
    });
    if (!r.available) throw new Error('expected available');
    expect(Math.abs(r.dayHourLengthMinutes - r.nightHourLengthMinutes)).toBeLessThan(3);
  });
});

describe('computePlanetaryHours — polar edge case', () => {
  it('returns available:false (no fabricated hours) during polar day', () => {
    // Svalbard in midsummer: the Sun never sets (polar day).
    const r = computePlanetaryHours({
      date: '2024-06-21',
      lat: 78.22,
      lon: 15.65,
      tzIana: 'Arctic/Longyearbyen',
    });
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toMatch(/polar|rise|set/i);
    expect(r).not.toHaveProperty('dayHours');
  });

  it('returns available:false during polar night', () => {
    // Svalbard at midwinter: the Sun never rises (polar night).
    const r = computePlanetaryHours({
      date: '2024-12-21',
      lat: 78.22,
      lon: 15.65,
      tzIana: 'Arctic/Longyearbyen',
    });
    expect(r.available).toBe(false);
  });
});
