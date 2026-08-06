/**
 * Sidereal zodiac tests (TASK C6).
 *
 * Three guarantees:
 *  1. Tropical (the default) is byte-for-byte unchanged — an existing reference
 *     fixture (the J2000 noon @ Greenwich chart) still produces the same Sun
 *     longitude/sign whether `zodiac` is omitted OR explicitly `'tropical'`.
 *  2. Sidereal Sun longitude = tropical Sun longitude − ayanamsa (mod 360),
 *     within tolerance (~24° for a modern date under Lahiri).
 *  3. Request isolation — a sidereal request followed by a tropical request
 *     yields the correct tropical result (proves no global sid-state leak).
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import { computeNatal } from '../src/natal.js';
import { ayanamsaDegrees } from '../src/ephemeris.js';
import { resolveBirthInstant } from '../src/time.js';

const TOL = 0.5; // degrees — matches the Moshier-backend tolerance used elsewhere.

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** The shared J2000-noon @ Greenwich birth used across the natal accuracy tests. */
const J2000: BirthData = {
  date: '2000-01-01',
  time: '12:00',
  timeKnown: true,
  lat: 51.4779,
  lon: -0.0015,
  tzIana: 'Europe/London',
  houseSystem: 'placidus',
};

const sunOf = (birth: BirthData) => computeNatal(birth).planets.find((p) => p.name === 'Sun')!;

describe('sidereal — tropical default is unchanged', () => {
  it('omitting zodiac matches the J2000 fixture Sun (10.37° Capricorn)', () => {
    const sun = sunOf(J2000);
    expect(sun.sign).toBe('Capricorn');
    expect(angDiff(sun.absoluteDegree, 280.37)).toBeLessThanOrEqual(TOL);
  });

  it('explicit zodiac:"tropical" is identical to omitting it', () => {
    const implicit = computeNatal(J2000);
    const explicit = computeNatal({ ...J2000, zodiac: 'tropical' });
    expect(explicit.zodiac).toBe('tropical');
    expect(explicit.ayanamsaDegrees).toBe(0);
    // Every planet longitude is byte-for-byte identical.
    for (let i = 0; i < implicit.planets.length; i++) {
      expect(explicit.planets[i]!.absoluteDegree).toBe(implicit.planets[i]!.absoluteDegree);
      expect(explicit.planets[i]!.sign).toBe(implicit.planets[i]!.sign);
    }
    expect(explicit.ascendant).toBe(implicit.ascendant);
    expect(explicit.midheaven).toBe(implicit.midheaven);
  });
});

describe('sidereal — Lahiri offset', () => {
  it('sidereal Sun = tropical Sun − ayanamsa (mod 360)', () => {
    const tropical = sunOf(J2000);
    const sidereal = sunOf({ ...J2000, zodiac: 'sidereal', ayanamsa: 'lahiri' });

    const { resolved } = resolveBirthInstant(J2000.date, J2000.time, J2000.timeKnown, J2000.tzIana);
    const aya = ayanamsaDegrees(resolved.jdUt, 'lahiri');

    // Lahiri ayanamsa in the 2000s is ~23.85°.
    expect(aya).toBeGreaterThan(23);
    expect(aya).toBeLessThan(25);

    const expected = (((tropical.absoluteDegree - aya) % 360) + 360) % 360;
    expect(angDiff(sidereal.absoluteDegree, expected)).toBeLessThanOrEqual(TOL);
  });

  it('reports the zodiac + ayanamsa it used for transparency', () => {
    const chart = computeNatal({ ...J2000, zodiac: 'sidereal' });
    expect(chart.zodiac).toBe('sidereal');
    expect(chart.ayanamsa).toBe('lahiri'); // defaulted
    expect(chart.ayanamsaDegrees).toBeGreaterThan(23);
    expect(chart.ayanamsaDegrees).toBeLessThan(25);
  });

  it('shifts the Asc/MC by the same ayanamsa as the planets', () => {
    const tropical = computeNatal(J2000);
    const sidereal = computeNatal({ ...J2000, zodiac: 'sidereal' });
    const aya = sidereal.ayanamsaDegrees;
    const expectedAsc = (((tropical.ascendant - aya) % 360) + 360) % 360;
    expect(angDiff(sidereal.ascendant, expectedAsc)).toBeLessThanOrEqual(TOL);
  });
});

describe('sidereal — request isolation (no global-state leak)', () => {
  it('a sidereal request does not contaminate a following tropical one', () => {
    const tropicalBefore = sunOf(J2000);
    // Sidereal request in between.
    computeNatal({ ...J2000, zodiac: 'sidereal' });
    const tropicalAfter = sunOf(J2000);
    expect(tropicalAfter.absoluteDegree).toBe(tropicalBefore.absoluteDegree);
    expect(tropicalAfter.sign).toBe('Capricorn');
  });

  it('alternating sidereal/tropical stays stable across many iterations', () => {
    const baseline = sunOf(J2000).absoluteDegree;
    for (let i = 0; i < 5; i++) {
      computeNatal({ ...J2000, zodiac: 'sidereal' });
      expect(sunOf(J2000).absoluteDegree).toBe(baseline);
    }
  });
});
