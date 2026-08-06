/**
 * Natal-chart accuracy tests.
 *
 * Reference values are taken from published professional sources (Astro.com /
 * Astro-Seek). Because the default test backend is the built-in **Moshier**
 * ephemeris (no `.se1` files), we assert with an honest tolerance of **±0.5°**
 * on longitudes and require sign matches. Full Swiss `.se1` files tighten this
 * to arc-seconds in production; see README.
 *
 * Tolerance rationale: Moshier vs Swiss differ by well under 0.1° for the Sun
 * and the major planets in the modern era; the Moon and the Ascendant can drift
 * slightly more, and pre-1970 charts additionally inherit timezone uncertainty
 * (IANA tz-db is only reliable post ~1970). ±0.5° comfortably covers Moshier
 * error while still catching real regressions (a wrong sign or a degrees bug).
 */
import { describe, it, expect } from 'vitest';
import { computeNatal } from '../src/natal.js';
import { signFor } from '../src/astro.js';

const TOL = 0.5; // degrees

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

describe('natal — modern birth with exact time (J2000 noon @ Greenwich)', () => {
  // Reference: 1 Jan 2000, 12:00 UTC, Greenwich (51.4779N, 0.0015W).
  // Standard J2000-noon positions (Astro.com / widely published ephemeris):
  //   Sun       10°22' Capricorn  (abs 280.37°)
  //   Moon      ~13.3° Scorpio    (abs ~223.3°)
  //   Mercury    1°53' Capricorn  (abs 271.89°)
  //   Ascendant  ~24.3° Aries     (abs ~24.3°)  [Placidus, Greenwich, noon]
  const chart = computeNatal({
    date: '2000-01-01',
    time: '12:00',
    timeKnown: true,
    lat: 51.4779,
    lon: -0.0015,
    tzIana: 'Europe/London',
    houseSystem: 'placidus',
  });

  const byName = (n: string) => chart.planets.find((p) => p.name === n)!;

  it('places the Sun at ~10.37° Capricorn', () => {
    const sun = byName('Sun');
    expect(sun.sign).toBe('Capricorn');
    expect(angDiff(sun.absoluteDegree, 280.37)).toBeLessThanOrEqual(TOL);
  });

  it('places the Moon in Scorpio at ~13.3°', () => {
    const moon = byName('Moon');
    expect(moon.sign).toBe('Scorpio');
    expect(angDiff(moon.absoluteDegree, 223.3)).toBeLessThanOrEqual(TOL);
  });

  it('places Mercury at ~1.89° Capricorn', () => {
    const merc = byName('Mercury');
    expect(merc.sign).toBe('Capricorn');
    expect(angDiff(merc.absoluteDegree, 271.89)).toBeLessThanOrEqual(TOL);
  });

  it('computes an Ascendant near 24.3° Aries', () => {
    expect(signFor(chart.ascendant)).toBe('Aries');
    expect(angDiff(chart.ascendant, 24.3)).toBeLessThanOrEqual(TOL);
  });

  it('returns 12 houses and Asc/MC because the time is known', () => {
    expect(chart.housesAvailable).toBe(true);
    expect(chart.houses).toHaveLength(12);
    expect(chart.preTzDatabaseEra).toBe(false);
  });

  it('marks degree-within-sign consistently with absoluteDegree', () => {
    const sun = byName('Sun');
    expect(sun.degree).toBeCloseTo(sun.absoluteDegree % 30, 6);
  });
});

describe('natal — pre-1970 birth (Albert Einstein, 1879)', () => {
  // Reference: Albert Einstein, 14 Mar 1879, 11:30 LMT, Ulm (48.4N, 9.98E).
  // Astro.com / AstroDatabank (Rodden AA):
  //   Sun   23°30' Pisces   Moon ~14° Sagittarius
  //   Mercury Aries  Venus Aries  Ascendant Cancer
  // We assert SIGNS (robust across the LMT-vs-tzdb offset ambiguity) and the
  // Sun's degree, and we expect the pre-tz-database flag to be set.
  const chart = computeNatal({
    date: '1879-03-14',
    time: '11:30',
    timeKnown: true,
    lat: 48.4,
    lon: 9.9833,
    tzIana: 'Europe/Berlin',
    houseSystem: 'placidus',
  });
  const byName = (n: string) => chart.planets.find((p) => p.name === n)!;

  it('flags the chart as pre-tz-database era', () => {
    expect(chart.preTzDatabaseEra).toBe(true);
  });

  it('places the Sun at ~23.5° Pisces', () => {
    const sun = byName('Sun');
    expect(sun.sign).toBe('Pisces');
    expect(angDiff(sun.absoluteDegree, 353.5)).toBeLessThanOrEqual(TOL);
  });

  it('places the Moon in Sagittarius', () => {
    expect(byName('Moon').sign).toBe('Sagittarius');
  });

  it('places Mercury, Venus and Saturn in Aries', () => {
    expect(byName('Mercury').sign).toBe('Aries');
    expect(byName('Venus').sign).toBe('Aries');
    expect(byName('Saturn').sign).toBe('Aries');
  });

  it('computes an Ascendant in Cancer', () => {
    // Astro.com gives Einstein an early-Cancer Ascendant; tz/LMT offset shifts
    // the exact degree, but the sign is stable, so we assert the sign only.
    expect(signFor(chart.ascendant)).toBe('Cancer');
  });
});

describe('natal — unknown birth time', () => {
  // Same date/place, time unknown. Houses/Asc/MC must be omitted/flagged;
  // planet positions must still be present (computed for local noon).
  const chart = computeNatal({
    date: '1990-06-15',
    time: null,
    timeKnown: false,
    lat: 38.7223,
    lon: -9.1393,
    tzIana: 'Europe/Lisbon',
    houseSystem: 'placidus',
  });

  it('omits houses and flags them unavailable', () => {
    expect(chart.timeKnown).toBe(false);
    expect(chart.housesAvailable).toBe(false);
    expect(chart.houses).toHaveLength(0);
    expect(chart.usedNoonFallback).toBe(true);
  });

  it('sets Ascendant/MC to the neutral 0 sentinel when unknown', () => {
    expect(chart.ascendant).toBe(0);
    expect(chart.midheaven).toBe(0);
  });

  it('still returns planet positions (Sun..Pluto + nodes)', () => {
    expect(chart.planets.length).toBeGreaterThanOrEqual(11);
    const sun = chart.planets.find((p) => p.name === 'Sun')!;
    expect(sun.sign).toBe('Gemini'); // 15 Jun is Gemini
    // Houses unavailable ⇒ house index is the 0 sentinel.
    expect(sun.house).toBe(0);
  });
});

describe('natal — high-latitude Placidus does not crash (A10 regression)', () => {
  // BUG (found in A10): above the polar circle `swe_houses_ex` returns a negative
  // flag for Placidus/Koch and the old code THREW, so a high-latitude birth with
  // a time-based house system produced an unhandled 500. Swiss still returns a
  // usable Asc/MC + fallback cusps; we now accept them and flag `houseSystemDegraded`.
  const chart = computeNatal({
    date: '1979-11-20',
    time: '03:00',
    timeKnown: true,
    lat: 69.6492, // Tromsø, Norway — above the Arctic Circle
    lon: 18.9553,
    tzIana: 'Europe/Oslo',
    houseSystem: 'placidus',
  });

  it('returns a usable chart instead of throwing', () => {
    expect(chart.housesAvailable).toBe(true);
    expect(chart.houses).toHaveLength(12);
    expect(Number.isFinite(chart.ascendant)).toBe(true);
    expect(Number.isFinite(chart.midheaven)).toBe(true);
  });

  it('flags the house system as degraded at this latitude', () => {
    expect(chart.houseSystemDegraded).toBe(true);
  });

  it('places every body in a valid house (1..12)', () => {
    for (const p of chart.planets) {
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
    }
  });
});

describe('natal — normal-latitude chart is NOT marked degraded', () => {
  const chart = computeNatal({
    date: '2000-01-01',
    time: '12:00',
    timeKnown: true,
    lat: 51.4779,
    lon: -0.0015,
    tzIana: 'Europe/London',
    houseSystem: 'placidus',
  });
  it('leaves houseSystemDegraded false for a London chart', () => {
    expect(chart.houseSystemDegraded).toBe(false);
  });
});

describe('natal — ephemeris backend / Chiron availability', () => {
  const chart = computeNatal({
    date: '2000-01-01',
    time: '12:00',
    timeKnown: true,
    lat: 51.4779,
    lon: -0.0015,
    tzIana: 'Europe/London',
    houseSystem: 'placidus',
  });

  it('reports the active backend', () => {
    expect(['swiss', 'moshier']).toContain(chart.ephemerisBackend);
  });

  it('under Moshier, omits Chiron and lists it as unavailable', () => {
    if (chart.ephemerisBackend === 'moshier') {
      expect(chart.unavailableBodies).toContain('Chiron');
      expect(chart.planets.find((p) => p.name === 'Chiron')).toBeUndefined();
    } else {
      expect(chart.planets.find((p) => p.name === 'Chiron')).toBeDefined();
    }
  });

  it('handles the major asteroids exactly like Chiron (computed with files, else unavailable)', () => {
    const asteroids = ['Ceres', 'Pallas', 'Juno', 'Vesta'] as const;
    for (const name of asteroids) {
      if (chart.ephemerisBackend === 'moshier') {
        // No seas_*.se1 files → must be reported unavailable, never fabricated.
        expect(chart.unavailableBodies).toContain(name);
        expect(chart.planets.find((p) => p.name === name)).toBeUndefined();
      } else {
        // Swiss backend with asteroid files → computed into a valid sign.
        const body = chart.planets.find((p) => p.name === name);
        expect(body).toBeDefined();
        expect(body!.sign).toBeTruthy();
        expect(body!.absoluteDegree).toBeGreaterThanOrEqual(0);
        expect(body!.absoluteDegree).toBeLessThan(360);
      }
    }
  });

  it('does not change the classical planets when asteroids are added', () => {
    // The asteroid additions are purely additive; existing reference bodies
    // must still be present and in their expected signs.
    expect(chart.planets.find((p) => p.name === 'Sun')?.sign).toBe('Capricorn');
    expect(chart.planets.find((p) => p.name === 'Moon')?.sign).toBe('Scorpio');
  });
});
