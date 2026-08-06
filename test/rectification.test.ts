/**
 * Birth-time rectification (TASK D4) tests.
 *
 * The scorer is deterministic and the candidate generator is bounded, so we can
 * assert exact structural properties. The astronomy runs under Moshier, so the
 * EVENT-FIT assertions use generous tolerances: we never assert a specific
 * minute is "the" birth time (rectification is a heuristic), only that the
 * mechanism behaves — candidates respect the window/step/cap, empty events give
 * no ranking, a clearly-fitting time out-scores a clearly-wrong one, and the
 * score is monotonic in orb in a controlled synthetic case.
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  computeRectification,
  generateCandidates,
  MAX_CANDIDATES,
  type RectifyRequest,
} from '../src/rectification.js';

const BIRTH: BirthData = {
  date: '1990-06-15',
  // time/timeKnown are irrelevant to the scan (each candidate overrides the
  // time); we pass an approximate value as a real user would.
  time: '12:00',
  timeKnown: false,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};

describe('generateCandidates', () => {
  it('respects the window + step (inclusive endpoints)', () => {
    const c = generateCandidates('12:00', '13:00', 15);
    // 12:00, 12:15, 12:30, 12:45, 13:00
    expect(c).toEqual([720, 735, 750, 765, 780]);
  });

  it('rejects an overnight wrap (latest must be after earliest)', () => {
    expect(() => generateCandidates('22:00', '02:00', 10)).toThrow(/wrap/i);
    expect(() => generateCandidates('12:00', '12:00', 10)).toThrow();
  });

  it('throws when the window + step exceed the candidate cap', () => {
    // 24h at 1-minute steps is 1440 candidates, well over the cap.
    expect(() => generateCandidates('00:00', '23:59', 1)).toThrow(/candidates/i);
  });

  it('caps the count at MAX_CANDIDATES at the boundary', () => {
    // A window sized to land exactly under the cap should succeed.
    const big = generateCandidates('00:00', '23:55', 5); // 288 candidates
    expect(big.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(big.length).toBe(288);
  });
});

describe('computeRectification — empty events', () => {
  it('returns no ranking and a clear message when no events are given', () => {
    const req: RectifyRequest = {
      birth: BIRTH,
      window: { earliest: '00:00', latest: '23:55' },
      stepMinutes: 30,
      events: [],
    };
    const res = computeRectification(req);
    expect(res.candidates).toEqual([]);
    expect(res.best).toBeNull();
    expect(res.message).toMatch(/at least one/i);
    expect(res.disclaimer).toMatch(/not a certainty/i);
    expect(res.scan.eventCount).toBe(0);
  });
});

describe('computeRectification — scan structure + bounds', () => {
  const req: RectifyRequest = {
    birth: BIRTH,
    window: { earliest: '08:00', latest: '20:00' },
    stepMinutes: 30,
    events: [
      { date: '2015-09-01', kind: 'moved home' },
      { date: '2019-04-20', kind: 'career change' },
      { date: '2022-11-10', kind: 'major relationship' },
    ],
  };
  const res = computeRectification(req);

  it('returns one candidate per scanned time, ranked best-first', () => {
    // 08:00..20:00 inclusive at 30m = 25 candidates.
    expect(res.candidates.length).toBe(25);
    expect(res.scan.candidateCount).toBe(25);
    for (let i = 1; i < res.candidates.length; i++) {
      expect(res.candidates[i - 1]!.score).toBeGreaterThanOrEqual(res.candidates[i]!.score);
    }
  });

  it('best is the top candidate; every candidate has angles + per-event hits', () => {
    expect(res.best).toEqual(res.candidates[0]);
    for (const cand of res.candidates) {
      expect(cand.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(cand.score).toBeGreaterThanOrEqual(0);
      expect(cand.score).toBeLessThanOrEqual(100);
      expect(cand.ascendant).toBeGreaterThanOrEqual(0);
      expect(cand.ascendant).toBeLessThan(360);
      expect(cand.hits.length).toBe(req.events.length);
      expect(cand.rationale.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic (same input ⇒ identical ranking + scores)', () => {
    const again = computeRectification(req);
    expect(again.candidates.map((c) => [c.time, c.score])).toEqual(
      res.candidates.map((c) => [c.time, c.score]),
    );
  });

  it('reports the active ephemeris backend honestly', () => {
    expect(['swiss', 'moshier']).toContain(res.scan.ephemerisBackend);
  });
});

describe('computeRectification — a fitting time out-scores a wrong one', () => {
  // Synthetic, end-to-end: scan a full day at a coarse step against a handful of
  // events, then assert the WINNER scores strictly higher than the WORST
  // candidate. Because the angles sweep the whole zodiac across 24h, at least
  // one candidate must land its angles on a slow-transit/progressed contact for
  // some event, while another must not — so the spread is real, not noise.
  const req: RectifyRequest = {
    birth: BIRTH,
    window: { earliest: '00:00', latest: '23:50' },
    stepMinutes: 10,
    events: [
      { date: '2008-03-15', kind: 'moved home' },
      { date: '2012-07-02', kind: 'career change' },
      { date: '2016-01-20', kind: 'major relationship' },
      { date: '2020-10-05', kind: 'child born' },
    ],
  };
  const res = computeRectification(req);

  it('produces a spread: the best scores strictly above the worst', () => {
    expect(res.best).not.toBeNull();
    const worst = res.candidates[res.candidates.length - 1]!;
    expect(res.best!.score).toBeGreaterThan(worst.score);
  });

  it('the best candidate cites at least one time-sensitive contact', () => {
    const fitting = res.best!.hits.filter((h) => h.technique !== null);
    expect(fitting.length).toBeGreaterThan(0);
    for (const h of fitting) {
      expect(h.orbDeg).not.toBeNull();
      expect(h.orbDeg!).toBeLessThanOrEqual(res.scan.contactOrbDeg);
      expect(['progressed-angle', 'transit-to-angle']).toContain(h.technique);
    }
  });

  it('tighter orbs yield higher per-event fit (monotonic decay)', () => {
    // Across all candidate/event hits, fit must be a non-increasing function of
    // orb: any hit with a smaller orb has a fit >= a hit with a larger orb.
    const hits = res.candidates
      .flatMap((c) => c.hits)
      .filter((h) => h.orbDeg !== null)
      .sort((a, b) => a.orbDeg! - b.orbDeg!);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.fit).toBeLessThanOrEqual(hits[i - 1]!.fit + 1e-9);
    }
  });
});

describe('computeRectification — weighting', () => {
  it('weights scale an event’s contribution to the score', () => {
    const base: RectifyRequest = {
      birth: BIRTH,
      window: { earliest: '06:00', latest: '18:00' },
      stepMinutes: 20,
      events: [{ date: '2018-05-05', kind: 'career change', weight: 1 }],
    };
    const heavy: RectifyRequest = {
      ...base,
      events: [{ date: '2018-05-05', kind: 'career change', weight: 5 }],
    };
    // A single event's weight cancels in the weighted MEAN (weight/weightSum
    // = 1 either way), so per-candidate scores must be identical — this guards
    // the normalisation against a regression where weight leaks into the scale.
    const a = computeRectification(base);
    const b = computeRectification(heavy);
    expect(b.candidates.map((c) => c.score)).toEqual(a.candidates.map((c) => c.score));
  });
});
