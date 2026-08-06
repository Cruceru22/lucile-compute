/**
 * R6 QA PASS — D5 Vedic (nakshatra + Vimshottari) hardening.
 *
 * The feature-dev suite (vedic.test.ts) covers the boundary mapping, the 120y
 * sum, birth-lord = Moon-nakshatra lord, the elapsed fraction, the antar sum,
 * and a known-value Ashwini→Ketu check. This pass pins the remaining invariants
 * a QA review wants explicit:
 *   1. The FULL nakshatra→lord table by NAME (all 27, the 9-lord cycle ×3) — a
 *      named-value check, not just "matches DASHA_SEQUENCE[i%9]".
 *   2. Antar-dashas chain end→start with NO gaps/overlaps (date continuity), and
 *      the first antar lord = the maha lord (the canonical start-from-self rule).
 *   3. The Maha timeline is contiguous and the elapsed fraction at an exact
 *      nakshatra boundary is 0 (birth lord starts fresh).
 *   4. A second independent known-value: Moon mid-Pushya (index 7) → Saturn maha.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  antarDashas,
  computeVimshottari,
  DASHA_SEQUENCE,
  DASHA_YEAR_DAYS,
  lordYears,
  NAKSHATRA_DEG,
  NAKSHATRA_NAMES,
  nakshatraLord,
  nakshatraOf,
  type DashaLord,
} from '../src/vedic.js';

const BIRTH_ISO = '1985-03-21T11:00:00Z';

function daysBetween(aIso: string, bIso: string): number {
  return DateTime.fromISO(bIso, { zone: 'utc' }).diff(
    DateTime.fromISO(aIso, { zone: 'utc' }),
    'days',
  ).days;
}

/** The canonical 9-lord cycle, named, so the table check reads as ground truth. */
const NINE: readonly DashaLord[] = [
  'Ketu',
  'Venus',
  'Sun',
  'Moon',
  'Mars',
  'Rahu',
  'Jupiter',
  'Saturn',
  'Mercury',
];

describe('nakshatra → lord table (all 27, by name)', () => {
  it('the 27 lords are the 9-lord cycle repeated three times, by named value', () => {
    expect(NAKSHATRA_NAMES).toHaveLength(27);
    const expected: DashaLord[] = [...NINE, ...NINE, ...NINE];
    for (let i = 0; i < 27; i += 1) {
      expect(nakshatraLord(i), `${NAKSHATRA_NAMES[i]} (index ${i})`).toBe(expected[i]);
    }
  });

  it('a few spot-checks anchor the table to tradition', () => {
    expect(nakshatraLord(0)).toBe('Ketu'); // Ashwini
    expect(nakshatraLord(3)).toBe('Moon'); // Rohini
    expect(nakshatraLord(7)).toBe('Saturn'); // Pushya
    expect(nakshatraLord(26)).toBe('Mercury'); // Revati
  });

  it('lord assignment wraps for out-of-range indices (negative + >26)', () => {
    expect(nakshatraLord(27)).toBe(nakshatraLord(0));
    expect(nakshatraLord(-1)).toBe(nakshatraLord(26));
  });
});

describe('elapsed fraction is exactly 0 at a nakshatra boundary', () => {
  it('a Moon exactly at the start of a nakshatra → fresh birth lord (fraction 0, full remaining)', () => {
    // Start of nakshatra index 7 (Pushya → Saturn).
    const moon = 7 * NAKSHATRA_DEG;
    const n = nakshatraOf(moon);
    expect(n.index).toBe(7);
    expect(n.lord).toBe('Saturn');
    expect(n.fractionTraversed).toBeCloseTo(0, 9);

    const v = computeVimshottari(moon, BIRTH_ISO, undefined, 'lahiri');
    expect(v.birthLord).toBe('Saturn');
    expect(v.firstDashaElapsedFraction).toBeCloseTo(0, 9);
    expect(v.firstDashaRemainingYears).toBeCloseTo(lordYears('Saturn'), 9);
    // Fraction 0 → notional start == birth.
    expect(daysBetween(BIRTH_ISO, v.mahaDashas[0]!.start)).toBeCloseTo(0, 6);
  });
});

describe('Maha + Antar date continuity (no gaps, no overlaps)', () => {
  it('the 9 Maha-dashas tile the 120-year cycle contiguously', () => {
    const v = computeVimshottari(123.456, BIRTH_ISO, undefined, 'lahiri');
    expect(v.mahaDashas).toHaveLength(9);
    for (let i = 1; i < 9; i += 1) {
      // Each Maha begins exactly where the previous ended (string-equal ISO).
      expect(v.mahaDashas[i]!.start).toBe(v.mahaDashas[i - 1]!.end);
    }
    const span = daysBetween(v.mahaDashas[0]!.start, v.mahaDashas[8]!.end);
    expect(span).toBeCloseTo(120 * DASHA_YEAR_DAYS, 2);
  });

  it('every Maha-dasha`s 9 antar-dashas chain contiguously and sum to its length', () => {
    for (const { lord } of DASHA_SEQUENCE) {
      const subs = antarDashas(lord, BIRTH_ISO);
      expect(subs).toHaveLength(9);
      // First antar lord = the maha lord (start-from-self rule).
      expect(subs[0]!.lord).toBe(lord);
      // Contiguous: each antar starts where the previous ended.
      for (let i = 1; i < 9; i += 1) {
        expect(subs[i]!.start).toBe(subs[i - 1]!.end);
      }
      // Antar lords run the full 9-lord cycle exactly once (no repeats/omissions).
      expect(new Set(subs.map((s) => s.lord)).size).toBe(9);
      // Sum of antar years == the maha length.
      const sumYears = subs.reduce((s, a) => s + a.years, 0);
      expect(sumYears).toBeCloseTo(lordYears(lord), 9);
      // Date span matches too.
      const span = daysBetween(subs[0]!.start, subs[8]!.end);
      expect(span).toBeCloseTo(lordYears(lord) * DASHA_YEAR_DAYS, 3);
    }
  });
});

describe('known-value: Moon mid-Pushya → Saturn maha-dasha, then Mercury, Ketu …', () => {
  it('seeds Saturn and the sequence walks Saturn → Mercury → Ketu', () => {
    // Middle of Pushya (index 7), lord Saturn.
    const moon = 7 * NAKSHATRA_DEG + NAKSHATRA_DEG / 2;
    const v = computeVimshottari(moon, BIRTH_ISO, undefined, 'lahiri');
    expect(v.moonNakshatra.name).toBe('Pushya');
    expect(v.birthLord).toBe('Saturn');
    expect(v.firstDashaElapsedFraction).toBeCloseTo(0.5, 9);
    expect(v.firstDashaRemainingYears).toBeCloseTo(lordYears('Saturn') * 0.5, 9);
    // After Saturn the canonical wrap continues Mercury, then Ketu …
    expect(v.mahaDashas.map((m) => m.lord).slice(0, 3)).toEqual(['Saturn', 'Mercury', 'Ketu']);
  });
});
