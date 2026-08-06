/**
 * TASK D5 — Nakshatra + Vimshottari Dasha math tests.
 *
 * The astronomy (the sidereal Moon longitude) carries the usual Moshier-backend
 * error, but the dasha + nakshatra math is PURE and exact given a longitude, so
 * we test the pure functions with worked sidereal longitudes and assert the
 * invariants exactly:
 *   - nakshatra boundaries (0° Aries → Ashwini pada 1; 13°20′ → Bharani; wrap).
 *   - the dasha sequence sums to exactly 120 years.
 *   - the birth dasha lord = the Moon-nakshatra lord.
 *   - the elapsed fraction of the first dasha matches the Moon's progress.
 *   - Antar-dasha sub-periods sum to the Maha-dasha length.
 *   - a known-value check: a Moon at a given sidereal longitude → expected
 *     nakshatra + starting dasha.
 *   - the full /vedic compute path runs and is internally consistent.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { BirthData } from '@astroapp/shared';

import {
  antarDashas,
  computeVedic,
  computeVimshottari,
  DASHA_SEQUENCE,
  DASHA_YEAR_DAYS,
  lordYears,
  NAKSHATRA_DEG,
  nakshatraLord,
  nakshatraOf,
  PADA_DEG,
  VIMSHOTTARI_TOTAL_YEARS,
} from '../src/vedic.js';

const BIRTH_ISO = '1990-06-15T06:30:00Z';

/** Days between two ISO instants. */
function daysBetween(aIso: string, bIso: string): number {
  const a = DateTime.fromISO(aIso, { zone: 'utc' });
  const b = DateTime.fromISO(bIso, { zone: 'utc' });
  return b.diff(a, 'days').days;
}

describe('nakshatra boundaries', () => {
  it('0° sidereal Aries → Ashwini, pada 1, lord Ketu', () => {
    const n = nakshatraOf(0);
    expect(n.index).toBe(0);
    expect(n.name).toBe('Ashwini');
    expect(n.pada).toBe(1);
    expect(n.lord).toBe('Ketu');
    expect(n.fractionTraversed).toBeCloseTo(0, 10);
  });

  it('just below 13°20′ is still Ashwini pada 4; exactly 13°20′ is Bharani pada 1', () => {
    const justBefore = nakshatraOf(NAKSHATRA_DEG - 1e-6);
    expect(justBefore.name).toBe('Ashwini');
    expect(justBefore.pada).toBe(4);

    const atBharani = nakshatraOf(NAKSHATRA_DEG); // 13°20′
    expect(atBharani.index).toBe(1);
    expect(atBharani.name).toBe('Bharani');
    expect(atBharani.pada).toBe(1);
    expect(atBharani.lord).toBe('Venus');
  });

  it('padas split each nakshatra into 4 × 3°20′', () => {
    expect(PADA_DEG).toBeCloseTo(3 + 20 / 60, 10);
    // Within Ashwini: 0..3°20′ pada1, 3°20′..6°40′ pada2, etc. Probe the MIDDLE
    // of each pada (exact boundaries are FP-fragile and never occur in practice).
    expect(nakshatraOf(0.5 * PADA_DEG).pada).toBe(1);
    expect(nakshatraOf(1.5 * PADA_DEG).pada).toBe(2);
    expect(nakshatraOf(2.5 * PADA_DEG).pada).toBe(3);
    expect(nakshatraOf(3.5 * PADA_DEG).pada).toBe(4);
  });

  it('wraps at 360° (just below 360° is Revati pada 4; 360° wraps to Ashwini)', () => {
    const last = nakshatraOf(360 - 1e-6);
    expect(last.index).toBe(26);
    expect(last.name).toBe('Revati');
    expect(last.pada).toBe(4);

    const wrapped = nakshatraOf(360);
    expect(wrapped.index).toBe(0);
    expect(wrapped.name).toBe('Ashwini');

    const over = nakshatraOf(370);
    expect(over.index).toBe(nakshatraOf(10).index);
  });
});

describe('nakshatra lords repeat every 9', () => {
  it('the 27 lords are the 9-lord sequence repeated three times', () => {
    for (let i = 0; i < 27; i++) {
      expect(nakshatraLord(i)).toBe(DASHA_SEQUENCE[i % 9]!.lord);
    }
  });
});

describe('Vimshottari sequence', () => {
  it('the nine lord-periods sum to exactly 120 years', () => {
    const total = DASHA_SEQUENCE.reduce((s, d) => s + d.years, 0);
    expect(total).toBe(VIMSHOTTARI_TOTAL_YEARS);
    expect(total).toBe(120);
  });

  it('the canonical order and year values are exact', () => {
    expect(DASHA_SEQUENCE.map((d) => d.lord)).toEqual([
      'Ketu',
      'Venus',
      'Sun',
      'Moon',
      'Mars',
      'Rahu',
      'Jupiter',
      'Saturn',
      'Mercury',
    ]);
    expect(DASHA_SEQUENCE.map((d) => d.years)).toEqual([7, 20, 6, 10, 7, 18, 16, 19, 17]);
  });
});

describe('Vimshottari dasha from the Moon nakshatra', () => {
  it('birth Maha-dasha lord = the Moon-nakshatra lord', () => {
    // Moon at 200° sidereal: index = floor(200/13.333) = 15 (Vishakha) → lord?
    const moon = 200;
    const n = nakshatraOf(moon);
    const v = computeVimshottari(moon, BIRTH_ISO, undefined, 'lahiri');
    expect(v.birthLord).toBe(n.lord);
    expect(v.mahaDashas[0]!.lord).toBe(n.lord);
  });

  it('the first-dasha elapsed fraction equals the Moon progress through its nakshatra', () => {
    // Place the Moon exactly halfway through nakshatra index 3 (Rohini → Moon).
    const moon = 3 * NAKSHATRA_DEG + NAKSHATRA_DEG / 2;
    const n = nakshatraOf(moon);
    expect(n.name).toBe('Rohini');
    expect(n.lord).toBe('Moon');

    const v = computeVimshottari(moon, BIRTH_ISO, undefined, 'lahiri');
    expect(v.firstDashaElapsedFraction).toBeCloseTo(0.5, 10);
    // Rohini's lord is the Moon (10y); half elapsed → 5y remaining.
    expect(v.firstDashaRemainingYears).toBeCloseTo(5, 9);

    // Notional start = birth − 5y; first Maha ends at birth + 5y.
    const expectedStartDays = -lordYears('Moon') * 0.5 * DASHA_YEAR_DAYS;
    expect(daysBetween(BIRTH_ISO, v.mahaDashas[0]!.start)).toBeCloseTo(expectedStartDays, 3);
  });

  it('Maha-dashas chain end-to-start and span the full 120-year cycle', () => {
    const v = computeVimshottari(123.456, BIRTH_ISO, undefined, 'lahiri');
    expect(v.mahaDashas).toHaveLength(9);
    for (let i = 1; i < v.mahaDashas.length; i++) {
      expect(v.mahaDashas[i]!.start).toBe(v.mahaDashas[i - 1]!.end);
    }
    // Total span from the first start to the last end = 120 dasha-years.
    const span = daysBetween(v.mahaDashas[0]!.start, v.mahaDashas[8]!.end);
    expect(span).toBeCloseTo(VIMSHOTTARI_TOTAL_YEARS * DASHA_YEAR_DAYS, 2);
  });

  it('the nine Antar-dashas sum exactly to the Maha-dasha length', () => {
    for (const { lord } of DASHA_SEQUENCE) {
      const subs = antarDashas(lord, BIRTH_ISO);
      expect(subs).toHaveLength(9);
      const sumYears = subs.reduce((s, a) => s + a.years, 0);
      expect(sumYears).toBeCloseTo(lordYears(lord), 9);
      // First sub-period lord = the Maha lord itself.
      expect(subs[0]!.lord).toBe(lord);
      // Date span matches the Maha length.
      const span = daysBetween(subs[0]!.start, subs[8]!.end);
      expect(span).toBeCloseTo(lordYears(lord) * DASHA_YEAR_DAYS, 3);
    }
  });

  it('known-value check: Moon at ~10° sidereal (Ashwini) → Ketu Maha-dasha', () => {
    // 10° sidereal is within Ashwini (0..13°20′), lord Ketu; 10/13.333 = 0.75
    // traversed → 25% of Ketu's 7y remaining = 1.75y.
    const v = computeVimshottari(10, BIRTH_ISO, undefined, 'lahiri');
    expect(v.moonNakshatra.name).toBe('Ashwini');
    expect(v.birthLord).toBe('Ketu');
    expect(v.firstDashaElapsedFraction).toBeCloseTo(10 / NAKSHATRA_DEG, 10);
    expect(v.firstDashaRemainingYears).toBeCloseTo(7 * (1 - 10 / NAKSHATRA_DEG), 9);
    // The sequence after Ketu starts Venus, Sun, …
    expect(v.mahaDashas.map((m) => m.lord).slice(0, 3)).toEqual(['Ketu', 'Venus', 'Sun']);
  });

  it('marks the current Maha + Antar dasha when a `now` is supplied', () => {
    // Moon at the very START of Ashwini → at birth almost no time has elapsed, so
    // birth sits inside the FIRST Maha-dasha (Ketu) and its FIRST Antar (Ketu).
    const moon = 1e-7;
    const v = computeVimshottari(moon, BIRTH_ISO, BIRTH_ISO, 'lahiri');
    expect(v.currentMahaIndex).toBe(0);
    expect(v.mahaDashas[v.currentMahaIndex]!.lord).toBe('Ketu');
    expect(v.currentAntarIndex).toBe(0);
    expect(v.currentAntarDashas[v.currentAntarIndex]!.lord).toBe('Ketu');

    // And a `now` well into the timeline lands in a later Maha-dasha.
    const later = DateTime.fromISO(BIRTH_ISO, { zone: 'utc' })
      .plus({ days: 30 * DASHA_YEAR_DAYS })
      .toISO()!;
    const v2 = computeVimshottari(moon, BIRTH_ISO, later, 'lahiri');
    // 30y in: Ketu(7)+Venus(20)=27y, so we're 3y into Sun (index 2).
    expect(v2.currentMahaIndex).toBe(2);
    expect(v2.mahaDashas[v2.currentMahaIndex]!.lord).toBe('Sun');
  });
});

describe('computeVedic — full sidereal compute path', () => {
  const birth: BirthData = {
    date: '1990-06-15',
    time: '06:30',
    timeKnown: true,
    lat: 28.6139, // New Delhi
    lon: 77.209,
    tzIana: 'Asia/Kolkata',
    houseSystem: 'whole_sign',
  };

  it('returns a Moon nakshatra and an internally consistent dasha', () => {
    const r = computeVedic(birth, BIRTH_ISO);
    expect(r.ayanamsa).toBe('lahiri');
    // Moon is flagged as the key body and drives the dasha.
    const moon = r.nakshatras.find((n) => n.body === 'Moon');
    expect(moon).toBeDefined();
    expect(moon!.isKey).toBe(true);
    expect(r.dasha.birthLord).toBe(moon!.lord);
    expect(r.dasha.moonNakshatra.index).toBe(moon!.index);
    // The dasha timeline is a complete 120-year cycle.
    expect(r.dasha.mahaDashas).toHaveLength(9);
    const total = r.dasha.mahaDashas.reduce((s, m) => s + m.years, 0);
    expect(total).toBe(120);
    // Sidereal: a non-zero Lahiri ayanamsa offset was applied (~23-24° for 1990).
    expect(r.ayanamsaDegrees).toBeGreaterThan(20);
    expect(r.ayanamsaDegrees).toBeLessThan(26);
  });

  it('every computed body lands in a valid nakshatra (index 0..26, pada 1..4)', () => {
    const r = computeVedic(birth, BIRTH_ISO);
    expect(r.nakshatras.length).toBeGreaterThan(0);
    for (const n of r.nakshatras) {
      expect(n.index).toBeGreaterThanOrEqual(0);
      expect(n.index).toBeLessThanOrEqual(26);
      expect(n.pada).toBeGreaterThanOrEqual(1);
      expect(n.pada).toBeLessThanOrEqual(4);
    }
  });
});
