/**
 * ROADMAP-V2 QA PASS — strengthened harmonics / midpoints / antiscia maths and
 * the fixed-stars graceful-unavailable path (TASK B6).
 *
 * Complements `advanced.test.ts` with additional WORKED, exact cases that
 * exercise the wrap behaviour of each transform, plus a midpoint case driven by
 * hand-picked longitudes (so the midpoint number is independently checkable),
 * and re-pins the fixed-star contract (available:false + NO fabricated
 * positions) on a second birth so it isn't an accident of one fixture.
 *
 * Every assertion here is EXACT (the transforms are closed-form integer/degree
 * arithmetic). No external ephemeris reference is claimed.
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  antiscion,
  contraAntiscion,
  computeFixedStars,
  fixedStarLongitude,
  harmonicLongitude,
} from '../src/advanced.js';
import { shorterArcMidpoint } from '../src/relationship.js';

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/* ----------------------------- Harmonics (wrap) -------------------------- */

describe('harmonic Hₙ(λ) = (λ·N) mod 360 — worked wrap cases', () => {
  it('H9(50°) = 450 mod 360 = 90°', () => {
    expect(harmonicLongitude(50, 9)).toBe(90);
  });
  it('H7(300°) = 2100 mod 360 = 300° (exact multiple-wrap)', () => {
    expect(harmonicLongitude(300, 7)).toBe(300);
  });
  it('H5(355°) = 1775 mod 360 = 335°', () => {
    expect(harmonicLongitude(355, 5)).toBe(335);
  });
  it('H2 of opposite points coincide (180° apart → conjunct in H2)', () => {
    // The defining property of the harmonic: points 360/N° apart fold together.
    expect(angDiff(harmonicLongitude(40, 2), harmonicLongitude(220, 2))).toBeLessThan(1e-9);
  });
});

/* ----------------------------- Antiscia (worked) ------------------------- */

describe('antiscion (180−λ) and contra (360−λ) — worked cases with wrap', () => {
  it('23° Gemini (83°) → antiscion 7° Cancer (97°)', () => {
    expect(antiscion(83)).toBe(97);
  });
  it('23° Gemini (83°) → contra-antiscion 7° Capricorn (277°)', () => {
    expect(contraAntiscion(83)).toBe(277);
  });
  it('20° Libra (200°) → antiscion wraps to 340° (10° Pisces)', () => {
    expect(antiscion(200)).toBe(340);
  });
  it('20° Libra (200°) → contra 160° (10° Virgo) = antiscion ± 180°', () => {
    expect(contraAntiscion(200)).toBe(160);
    expect(angDiff(contraAntiscion(200), antiscion(200) + 180)).toBeLessThan(1e-9);
  });
  it('contra is an involution and antiscion is an involution', () => {
    for (const lon of [5, 83, 200, 311.7]) {
      expect(angDiff(antiscion(antiscion(lon)), lon)).toBeLessThan(1e-9);
      expect(angDiff(contraAntiscion(contraAntiscion(lon)), lon)).toBeLessThan(1e-9);
    }
  });
});

/* ----------------------------- Midpoint wrap ----------------------------- */

describe('midpoint wrap — shared shorter-arc convention', () => {
  it('355° & 5° midpoint is 0° (crosses Aries point, short arc)', () => {
    expect(angDiff(shorterArcMidpoint(355, 5).midpoint, 0)).toBeLessThan(1e-9);
  });
  it('340° & 80° midpoint is 30° (100°-wide short arc, not the 260° long arc)', () => {
    const m = shorterArcMidpoint(340, 80).midpoint;
    expect(angDiff(m, 30)).toBeLessThan(1e-9);
    // Must be within half the short-arc separation of each endpoint.
    const half = angDiff(340, 80) / 2;
    expect(angDiff(m, 340)).toBeLessThanOrEqual(half + 1e-9);
    expect(angDiff(m, 80)).toBeLessThanOrEqual(half + 1e-9);
  });
});

/* --------------------------- Fixed stars (graceful) ---------------------- */

describe('fixed stars — graceful unavailability, second fixture', () => {
  const BIRTH: BirthData = {
    date: '1975-09-09',
    time: '03:45',
    timeKnown: true,
    lat: 40.7128,
    lon: -74.006,
    tzIana: 'America/New_York',
    houseSystem: 'placidus',
  };

  it('stars NOT in sweph’s bundled mini-table resolve to null without sefstars.txt', () => {
    // `swe_fixstar2_ut` returns flag<0 for these (Regulus/Algol are not in the
    // tiny built-in table the sweph package ships), so the primitive is null.
    for (const star of ['Regulus', 'Algol', 'Aldebaran']) {
      expect(fixedStarLongitude(star, 2442664.6562)).toBeNull();
    }
  });

  it('the BUNDLED mini-table leaks a Spica position at the primitive level (documented sweph quirk)', () => {
    // REGRESSION GUARD for the fix in computeFixedStars: the sweph package ships
    // a built-in table containing Spica, so the low-level fixedStarLongitude can
    // return a finite value for it even with no sefstars.txt. This is exactly why
    // computeFixedStars must probe the WHOLE catalogue (next test) rather than a
    // single star — otherwise it would report a Spica-only partial result.
    const spica = fixedStarLongitude('Spica', 2442664.6562);
    expect(spica).not.toBeNull();
  });

  it('computeFixedStars is available:false, empty contacts, catalogue still present', () => {
    const r = computeFixedStars(BIRTH, { ascendant: 120.5, midheaven: 30.2 });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/sefstars\.txt/i);
    expect(r.contacts).toEqual([]);
    // No contact can claim a position when the catalogue is missing.
    expect(r.contacts.length).toBe(0);
    // The curated catalogue + meanings are always returned for the UI.
    expect(r.catalog.length).toBeGreaterThanOrEqual(8);
    for (const s of r.catalog) {
      expect(typeof s.meaning).toBe('string');
      expect(s.meaning.length).toBeGreaterThan(0);
    }
  });
});
