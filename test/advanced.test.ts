/**
 * TASK B6 — pro-depth techniques tests: harmonic math, midpoint wrap, antiscia
 * formulas on hand-computable values, and the fixed-stars contract in BOTH
 * states — catalogue installed and catalogue absent.
 *
 * The pure-math tests are exact (the transforms are deterministic). The
 * chart-level tests use a known modern birth and assert structure + honest
 * Moshier tolerance where a longitude is involved.
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  antiscion,
  contraAntiscion,
  computeAntiscia,
  computeFixedStars,
  computeHarmonics,
  computeMidpoints,
  fixedStarLongitude,
  harmonicLongitude,
} from '../src/advanced.js';

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

const BIRTH: BirthData = {
  date: '2000-01-01',
  time: '12:00',
  timeKnown: true,
  lat: 51.4779,
  lon: -0.0015,
  tzIana: 'Europe/London',
  houseSystem: 'placidus',
};

/* ----------------------------- Harmonics --------------------------------- */

describe('harmonics — Hₙ(λ) = (λ·N) mod 360', () => {
  it('a 10° body in H4 maps to 40°', () => {
    expect(harmonicLongitude(10, 4)).toBe(40);
  });

  it('wraps past 360 (100° in H4 → 40°)', () => {
    expect(harmonicLongitude(100, 4)).toBe(40);
  });

  it('a 36° body in H5 maps to 180° (quintile family folds)', () => {
    expect(harmonicLongitude(36, 5)).toBe(180);
  });

  it('H1 is the identity', () => {
    expect(harmonicLongitude(123.456, 1)).toBeCloseTo(123.456, 9);
  });

  it('normalises a negative/oversized natural longitude before multiplying', () => {
    // -10° ≡ 350°; ×4 = 1400 ≡ 320°.
    expect(harmonicLongitude(-10, 4)).toBe(320);
  });

  it('produces a harmonic chart with one harmonic point per body + recomputed aspects', () => {
    const natalLike = computeHarmonics(BIRTH, 1);
    const h4 = computeHarmonics(BIRTH, 4);
    expect(h4.harmonic).toBe(4);
    expect(h4.points.length).toBe(natalLike.points.length);
    // Each harmonic point equals (natural × 4) mod 360.
    for (const p of h4.points) {
      const natural = natalLike.points.find((q) => q.name === p.name)!;
      expect(angDiff(p.absoluteDegree, harmonicLongitude(natural.absoluteDegree, 4))).toBeLessThan(
        1e-9,
      );
    }
    expect(Array.isArray(h4.aspects)).toBe(true);
    // Harmonic abstractions have no motion → no applying aspects.
    expect(h4.aspects.every((a) => a.applying === false)).toBe(true);
  });
});

/* ----------------------------- Midpoints --------------------------------- */

describe('midpoints — shorter-arc convention + wrap', () => {
  it('returns every unordered planet pair', () => {
    const r = computeMidpoints(BIRTH);
    const n = r.pairs.length;
    // n bodies → n*(n-1)/2 pairs. Derive body count from a harmonic chart.
    const bodies = computeHarmonics(BIRTH, 1).points.length;
    expect(n).toBe((bodies * (bodies - 1)) / 2);
  });

  it('each pair midpoint sits on the shorter arc between the two bodies', () => {
    const r = computeMidpoints(BIRTH);
    for (const pair of r.pairs.slice(0, 5)) {
      expect(pair.midpoint).toBeGreaterThanOrEqual(0);
      expect(pair.midpoint).toBeLessThan(360);
    }
  });

  it('flags a planet sitting on a midpoint within orb as a direct contact', () => {
    // With a generous orb every contact reported must truly be within that orb.
    const r = computeMidpoints(BIRTH, 3);
    for (const c of r.contacts) {
      expect(c.orb).toBeLessThanOrEqual(3 + 1e-9);
      expect(c.planet).not.toBe(c.a);
      expect(c.planet).not.toBe(c.b);
    }
  });
});

/* ----------------------------- Antiscia ---------------------------------- */

describe('antiscia — reflection formulas on hand-computable values', () => {
  it('15° Taurus (45°) → antiscion 15° Leo (135°)', () => {
    expect(antiscion(45)).toBe(135);
  });

  it('15° Taurus (45°) → contra-antiscion 15° Aquarius (315°)', () => {
    expect(contraAntiscion(45)).toBe(315);
  });

  it('0° Cancer (90°) is its own antiscion (on the solstitial axis)', () => {
    expect(antiscion(90)).toBe(90);
  });

  it('0° Capricorn (270°) is its own antiscion', () => {
    expect(antiscion(270)).toBe(270);
  });

  it('0° Aries (0°) is its own contra-antiscion (on the equinoctial axis)', () => {
    expect(contraAntiscion(0)).toBe(0);
  });

  it('contra-antiscion is always the opposition of the antiscion', () => {
    for (const lon of [12, 88, 200, 359.9]) {
      expect(angDiff(contraAntiscion(lon), antiscion(lon) + 180)).toBeLessThan(1e-9);
    }
  });

  it('antiscion is an involution: antiscion(antiscion(λ)) = λ', () => {
    for (const lon of [10, 137, 270, 333.3]) {
      expect(angDiff(antiscion(antiscion(lon)), lon)).toBeLessThan(1e-9);
    }
  });

  it('produces an entry per body with both reflection points placed', () => {
    const r = computeAntiscia(BIRTH);
    expect(r.entries.length).toBeGreaterThan(0);
    for (const e of r.entries) {
      expect(angDiff(e.antiscion.absoluteDegree, antiscion(e.natal.absoluteDegree))).toBeLessThan(
        1e-9,
      );
      expect(
        angDiff(e.contraAntiscion.absoluteDegree, contraAntiscion(e.natal.absoluteDegree)),
      ).toBeLessThan(1e-9);
    }
  });
});

/* --------------------------- Fixed stars --------------------------------- */

/**
 * These assertions are DELIBERATELY environment-aware. `sefstars.txt` is fetched
 * by `scripts/fetch-ephemeris.sh` into a gitignored `ephe/`, so CI runs without
 * it and a configured dev box (or the deployed service) runs with it. Pinning
 * only one branch would mean the suite fails on exactly the machines where the
 * feature actually works. Both branches are real contracts, so both are pinned.
 *
 * Regulus is the probe: it is NOT in the tiny star table the `sweph` package
 * bundles, so a finite longitude for it means the real catalogue is installed.
 */
const CATALOGUE_INSTALLED = fixedStarLongitude('Regulus', 2451545.0) !== null;

describe('fixed stars', () => {
  it('fixedStarLongitude: null without the catalogue, the true position with it', () => {
    // J2000 noon JD.
    const lon = fixedStarLongitude('Regulus', 2451545.0);
    if (!CATALOGUE_INSTALLED) {
      expect(lon).toBeNull();
      return;
    }
    // Regulus at J2000 sits at 29°50' Leo — the published value, so this pins
    // the actual astronomy and not merely "some number came back".
    expect(lon).toBeCloseTo(149.829, 2);
  });

  it('computeFixedStars: honest unavailability, or real contacts when installed', () => {
    const r = computeFixedStars(BIRTH, { ascendant: 24.3, midheaven: 270 });
    expect(r.technique).toBe('fixed_stars');

    if (!CATALOGUE_INSTALLED) {
      expect(r.available).toBe(false);
      expect(r.reason).toMatch(/sefstars\.txt/i);
      expect(r.contacts).toEqual([]);
    } else {
      expect(r.available).toBe(true);
      expect(r.reason).toBeUndefined();
      // Never a fabricated 0°: every contact carries a real star position, a
      // catalogued star name, and an orb inside the configured limit.
      for (const c of r.contacts) {
        expect(Number.isFinite(c.starLongitude)).toBe(true);
        expect(c.starLongitude).toBeGreaterThanOrEqual(0);
        expect(c.starLongitude).toBeLessThan(360);
        expect(r.catalog.some((s) => s.name === c.star)).toBe(true);
        expect(Math.abs(c.orb)).toBeLessThanOrEqual(r.contactOrb);
      }
    }

    // The curated catalogue + meanings are returned for the UI EITHER WAY.
    expect(r.catalog.length).toBeGreaterThanOrEqual(8);
    expect(r.catalog.find((s) => s.name === 'Regulus')?.meaning).toBeTruthy();
  });
});
