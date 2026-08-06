/**
 * R6 QA PASS — D4 rectification hardening.
 *
 * The feature-dev suite (rectification.test.ts) already covers the scorer's
 * determinism, monotonic orb-decay, the empty-events message, and the
 * generateCandidates window/step/cap. This pass adds the gaps a QA review wants
 * pinned:
 *   1. Cap enforcement at the REQUEST-SCHEMA boundary (events ≤ 40, candidates ≤
 *      288, overnight wrap rejected) — the actual contract a client hits, which
 *      the unit-level generateCandidates tests do not exercise.
 *   2. The empty-events path leaves NO ranking + an honest message (re-asserted
 *      structurally against the public `RectifyResponse`).
 *   3. A controlled monotonicity check at the scorer level: per-event fit is a
 *      non-increasing function of orb across an independent synthetic scan, and
 *      the disclaimer is ALWAYS present (the honesty contract).
 *
 * No new ephemeris assertions about a "true" minute — rectification is a
 * heuristic and we never claim a specific time is correct (see module doc).
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  computeRectification,
  MAX_CANDIDATES,
  MAX_EVENTS,
  type RectifyRequest,
} from '../src/rectification.js';
import { rectifyRequestSchema } from '../src/schemas.js';

const BIRTH: BirthData = {
  date: '1990-06-15',
  time: '12:00',
  timeKnown: false,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    birth: {
      date: '1990-06-15',
      time: '12:00',
      timeKnown: false,
      lat: 38.7223,
      lon: -9.1393,
      tzIana: 'Europe/Lisbon',
      houseSystem: 'placidus',
    },
    window: { earliest: '08:00', latest: '20:00' },
    stepMinutes: 30,
    events: [{ date: '2015-09-01', kind: 'moved home' }],
    ...overrides,
  };
}

describe('rectify request schema — cap + window enforcement (the client contract)', () => {
  it('accepts a well-formed request', () => {
    expect(rectifyRequestSchema.safeParse(baseBody()).success).toBe(true);
  });

  it('rejects an overnight-wrap window (latest must be after earliest)', () => {
    const r = rectifyRequestSchema.safeParse(
      baseBody({ window: { earliest: '22:00', latest: '02:00' } }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/after `earliest`|wrap/i);
    }
  });

  it('rejects earliest === latest (zero-width window)', () => {
    const r = rectifyRequestSchema.safeParse(
      baseBody({ window: { earliest: '12:00', latest: '12:00' } }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects more than MAX_EVENTS events', () => {
    const tooMany = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
      date: '2010-01-01',
      kind: `e${i}`,
    }));
    expect(rectifyRequestSchema.safeParse(baseBody({ events: tooMany })).success).toBe(false);
    // Exactly MAX_EVENTS is still accepted (boundary).
    const exact = Array.from({ length: MAX_EVENTS }, (_, i) => ({
      date: '2010-01-01',
      kind: `e${i}`,
    }));
    expect(rectifyRequestSchema.safeParse(baseBody({ events: exact })).success).toBe(true);
  });

  it('rejects a window + step that would exceed the candidate cap', () => {
    // 00:00..23:59 at 1-minute steps = 1440 candidates, far over MAX_CANDIDATES.
    const r = rectifyRequestSchema.safeParse(
      baseBody({ window: { earliest: '00:00', latest: '23:59' }, stepMinutes: 1 }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/candidates/i);
    }
  });

  it('accepts a window sized exactly at the candidate cap', () => {
    // 00:00..23:55 at 5m = 288 candidates = MAX_CANDIDATES.
    const r = rectifyRequestSchema.safeParse(
      baseBody({ window: { earliest: '00:00', latest: '23:55' }, stepMinutes: 5 }),
    );
    expect(r.success).toBe(true);
    expect(MAX_CANDIDATES).toBe(288);
  });
});

describe('computeRectification — empty events leaves no ranking (honest message)', () => {
  it('returns [] candidates, null best, a clear message, and the disclaimer', () => {
    const req: RectifyRequest = {
      birth: BIRTH,
      window: { earliest: '08:00', latest: '20:00' },
      stepMinutes: 30,
      events: [],
    };
    const res = computeRectification(req);
    expect(res.candidates).toEqual([]);
    expect(res.best).toBeNull();
    expect(res.scan.candidateCount).toBe(0);
    expect(res.scan.eventCount).toBe(0);
    expect(res.message).toMatch(/at least one/i);
    // Honesty contract: the disclaimer is ALWAYS present, even with no ranking.
    expect(res.disclaimer.length).toBeGreaterThan(0);
    expect(res.disclaimer).toMatch(/not a certainty|estimate/i);
  });
});

describe('computeRectification — scorer stays bounded + honest', () => {
  const req: RectifyRequest = {
    birth: BIRTH,
    window: { earliest: '00:00', latest: '23:50' },
    stepMinutes: 10,
    events: [
      { date: '2008-03-15', kind: 'moved home' },
      { date: '2014-07-02', kind: 'career change' },
      { date: '2019-10-05', kind: 'major relationship' },
    ],
  };
  const res = computeRectification(req);

  it('never exceeds the candidate cap and every score is in [0,100]', () => {
    expect(res.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(res.scan.candidateCount).toBe(res.candidates.length);
    for (const c of res.candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it('per-event fit is a non-increasing function of orb (monotonic decay, independent scan)', () => {
    const hits = res.candidates
      .flatMap((c) => c.hits)
      .filter((h) => h.orbDeg !== null)
      .sort((a, b) => a.orbDeg! - b.orbDeg!);
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i]!.fit).toBeLessThanOrEqual(hits[i - 1]!.fit + 1e-9);
    }
    // Every cited contact sits within the published contact orb.
    for (const h of hits) {
      expect(h.orbDeg!).toBeLessThanOrEqual(res.scan.contactOrbDeg);
    }
  });

  it('the disclaimer is always present on a ranked response', () => {
    expect(res.disclaimer).toMatch(/not a certainty|estimate/i);
  });
});
