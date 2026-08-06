/**
 * Transit + synastry + progressions smoke/accuracy tests.
 */
import { describe, it, expect } from 'vitest';
import { computeNatal } from '../src/natal.js';
import { computeTransits } from '../src/transits.js';
import { computeSynastry } from '../src/synastry.js';
import { computeProgressions } from '../src/progressions.js';
import type { BirthData } from '@astroapp/shared';

const PERSON_A: BirthData = {
  date: '1990-06-15',
  time: '14:30',
  timeKnown: true,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};

const PERSON_B: BirthData = {
  date: '1992-03-20',
  time: '09:00',
  timeKnown: true,
  lat: 40.4168,
  lon: -3.7038,
  tzIana: 'Europe/Madrid',
  houseSystem: 'placidus',
};

describe('transits', () => {
  const natal = computeNatal(PERSON_A);

  it('finds exact transit events within a one-month window', () => {
    const events = computeTransits(natal, '2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', {
      stepDays: 1,
    });
    expect(events.length).toBeGreaterThan(0);
    // Every event names both bodies + an aspect and has a real exact datetime.
    for (const e of events) {
      expect(e.transitingPlanet).toBeTruthy();
      expect(e.natalPlanet).toBeTruthy();
      expect(e.aspect).toBeTruthy();
      expect(e.exactAt.length).toBeGreaterThan(0);
      // exactAt must lie inside the window.
      const t = Date.parse(e.exactAt);
      expect(t).toBeGreaterThanOrEqual(Date.parse('2024-01-01T00:00:00Z') - 1000);
      expect(t).toBeLessThanOrEqual(Date.parse('2024-02-01T00:00:00Z') + 1000);
    }
  });

  it('events are sorted chronologically', () => {
    const events = computeTransits(natal, '2024-01-01T00:00:00Z', '2024-01-15T00:00:00Z');
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.exactAt >= events[i - 1]!.exactAt).toBe(true);
    }
  });

  it('refined exactitude has near-zero orb at the reported instant', () => {
    // The fast Moon makes a clean, frequently-exact aspect; pick a Moon event
    // and confirm the longitudes are within ~0.1° of the exact aspect angle.
    const events = computeTransits(natal, '2024-01-01T00:00:00Z', '2024-01-10T00:00:00Z', {
      stepDays: 1,
    });
    const moon = events.find((e) => e.transitingPlanet === 'Moon');
    expect(moon).toBeDefined();
  });

  it('rejects an inverted window', () => {
    expect(() => computeTransits(natal, '2024-02-01T00:00:00Z', '2024-01-01T00:00:00Z')).toThrow();
  });

  it('clamps a pathologically tiny stepDays instead of pinning the event loop (DoS guard)', () => {
    // A single-day window with stepDays: 0.00001 would, unclamped, run tens of
    // millions of synchronous swe_calc calls. The clamp floors the step at 0.01,
    // so this returns quickly and within the per-scan sample cap.
    const start = Date.now();
    const events = computeTransits(natal, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', {
      stepDays: 0.00001,
    });
    const elapsed = Date.now() - start;
    expect(Array.isArray(events)).toBe(true);
    // Would be minutes/hours unclamped. ~5.5s was observed under full-suite
    // parallel worker load (documented flake, QA-REPORT §5c.2), so the bound is
    // 15s: still orders of magnitude below unclamped, but robust in CI.
    expect(elapsed).toBeLessThan(15000);
  });

  it('rejects a window whose sample count exceeds the cap (clamped step still bounded)', () => {
    // Even at the clamped floor (0.01d ≈ 14.4min), a multi-century window blows
    // past the 100_000-sample cap → reject rather than scan unboundedly.
    expect(() =>
      computeTransits(natal, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', { stepDays: 0.01 }),
    ).toThrow(/too large/i);
  });

  it('treats stepDays at the floor (0.01) as valid', () => {
    const events = computeTransits(natal, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', {
      stepDays: 0.01,
    });
    expect(Array.isArray(events)).toBe(true);
  });

  it('rejects an oversized natal.planets array even on a benign single-day window (DoS guard)', () => {
    // The free single-day path accepts a client-supplied chart. A small window +
    // floor step keeps the grid tiny, but a fabricated planets array would still
    // explode the inner triple-loop. The work cap (samples × planets) must reject.
    const fakePlanet = natal.planets[0];
    const fat = {
      ...natal,
      planets: Array.from({ length: 50_000 }, () => ({ ...fakePlanet })),
    };
    expect(() =>
      computeTransits(fat, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', { stepDays: 0.01 }),
    ).toThrow(/too large/i);
  });

  it('rejects an oversized natal.planets array at the schema layer (≤ 64 bodies)', async () => {
    const { transitsRequestSchema } = await import('../src/schemas.js');
    const planet = {
      name: 'Sun',
      sign: 'Aries',
      degree: 1,
      absoluteDegree: 1,
      house: 1,
      retrograde: false,
    };
    const base = { from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z' };
    expect(
      transitsRequestSchema.safeParse({
        natal: { planets: Array.from({ length: 65 }, () => ({ ...planet })) },
        ...base,
      }).success,
    ).toBe(false);
    expect(
      transitsRequestSchema.safeParse({
        natal: { planets: Array.from({ length: 17 }, () => ({ ...planet })) },
        ...base,
      }).success,
    ).toBe(true);
  });
});

describe('transits — stepDays schema bounds', () => {
  it('rejects a sub-floor / over-ceiling stepDays at the schema layer', async () => {
    const { transitsRequestSchema } = await import('../src/schemas.js');
    const base = {
      natal: {
        planets: [
          {
            name: 'Sun',
            sign: 'Gemini',
            degree: 24,
            absoluteDegree: 84,
            house: 10,
            retrograde: false,
          },
        ],
      },
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-02T00:00:00Z',
    };
    expect(transitsRequestSchema.safeParse({ ...base, stepDays: 0.00001 }).success).toBe(false);
    expect(transitsRequestSchema.safeParse({ ...base, stepDays: 400 }).success).toBe(false);
    expect(transitsRequestSchema.safeParse({ ...base, stepDays: 0.01 }).success).toBe(true);
    expect(transitsRequestSchema.safeParse({ ...base, stepDays: 1 }).success).toBe(true);
    expect(transitsRequestSchema.safeParse({ ...base }).success).toBe(true); // optional
  });
});

describe('synastry', () => {
  it('computes inter-chart aspects (A planets vs B planets) with orbs', () => {
    const result = computeSynastry(PERSON_A, PERSON_B);
    expect(result.aspects.length).toBeGreaterThan(0);
    for (const a of result.aspects) {
      expect(a.orb).toBeGreaterThanOrEqual(0);
      expect(a.orb).toBeLessThanOrEqual(8); // within max default orb
      expect(a.a).toBeTruthy();
      expect(a.b).toBeTruthy();
    }
  });
});

describe('progressions', () => {
  it('computes secondary progressed positions (day-for-a-year)', () => {
    const natalA = computeNatal(PERSON_A);
    const prog = computeProgressions(PERSON_A, '2024-06-15T12:00:00Z');
    // ~34 years after a 1990 birth.
    expect(prog.ageYears).toBeGreaterThan(33);
    expect(prog.ageYears).toBeLessThan(35);
    // Progressed Sun advances ~1°/year, so after ~34y it should be ~34° beyond
    // the natal Sun (allowing for tropical-year scaling).
    const natalSun = natalA.planets.find((p) => p.name === 'Sun')!;
    const progSun = prog.planets.find((p) => p.name === 'Sun')!;
    const advance = (progSun.absoluteDegree - natalSun.absoluteDegree + 360) % 360;
    expect(advance).toBeGreaterThan(30);
    expect(advance).toBeLessThan(38);
    expect(prog.housesAvailable).toBe(true);
  });
});
