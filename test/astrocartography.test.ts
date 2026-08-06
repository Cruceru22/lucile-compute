/**
 * TASK B7 — Astrocartography (ACG) math tests.
 *
 * The default test backend is Moshier (no `.se1` files), so planet RA/Dec carry
 * the usual Moshier error; ACG line longitudes inherit it plus the GMST term.
 * We assert with honest tolerances (≤0.5° on a worked MC longitude) and verify
 * the geometric invariants exactly (they hold regardless of backend precision):
 *   - MC and IC meridians differ by exactly 180°.
 *   - AC and DC longitudes at a given latitude are symmetric about the MC.
 *   - The horizon equation is clipped where it has no solution.
 *   - Antimeridian segment-splitting never leaves a >180° jump inside a segment.
 *   - Unknown birth time → available:false with NO lines.
 *   - Recompute is deterministic.
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  computeAstrocartography,
  horizonCurves,
  normLon180,
  planetLines,
  splitAtAntimeridian,
  type AcgPoint,
} from '../src/astrocartography.js';

const TOL = 0.5; // degrees

/** Signed minimal difference a−b on the longitude circle, in (−180, 180]. */
function lonDiff(a: number, b: number): number {
  return normLon180(a - b);
}

const knownTime: BirthData = {
  date: '2000-01-01',
  time: '12:00',
  timeKnown: true,
  lat: 51.4779,
  lon: -0.0015,
  tzIana: 'Europe/London',
  houseSystem: 'placidus',
};

describe('normLon180', () => {
  it('maps into (−180, 180]', () => {
    expect(normLon180(0)).toBe(0);
    expect(normLon180(180)).toBe(180);
    expect(normLon180(-180)).toBe(180);
    expect(normLon180(190)).toBe(-170);
    expect(normLon180(360)).toBe(0);
    expect(normLon180(540)).toBe(180);
  });
});

describe('splitAtAntimeridian', () => {
  it('splits where consecutive longitudes jump more than 180°', () => {
    const pts: AcgPoint[] = [
      { lat: 0, lon: 170 },
      { lat: 1, lon: 179 },
      { lat: 2, lon: -179 }, // wrap: |−179 − 179| = 358 > 180 ⇒ split
      { lat: 3, lon: -170 },
    ];
    const segs = splitAtAntimeridian(pts);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
    // No segment contains an internal >180° jump.
    for (const seg of segs) {
      for (let i = 1; i < seg.length; i++) {
        expect(
          Math.abs((seg[i] as AcgPoint).lon - (seg[i - 1] as AcgPoint).lon),
        ).toBeLessThanOrEqual(180);
      }
    }
  });

  it('keeps a non-wrapping polyline as a single segment', () => {
    const pts: AcgPoint[] = [
      { lat: 0, lon: 10 },
      { lat: 1, lon: 12 },
      { lat: 2, lon: 15 },
    ];
    expect(splitAtAntimeridian(pts)).toHaveLength(1);
  });
});

describe('planetLines — MC/IC are opposite meridians', () => {
  it('IC longitude is exactly 180° from the MC', () => {
    // Arbitrary RA/Dec/GMST; the relation is purely geometric.
    for (const [ra, dec, gmst] of [
      [281, -23, 280],
      [10, 12, 350],
      [200, -5, 30],
    ] as const) {
      const l = planetLines('Sun', ra, dec, gmst);
      expect(Math.abs(Math.abs(lonDiff(l.mc, l.ic)) - 180)).toBeLessThan(1e-9);
    }
  });

  it('MC longitude equals normLon180(RA − GMST)', () => {
    const l = planetLines('Mars', 100, 20, 30);
    expect(l.mc).toBeCloseTo(normLon180(100 - 30), 9);
  });
});

describe('horizonCurves — AC/DC symmetry about the MC meridian', () => {
  it('AC and DC are mirror images of the MC by ±H0 at every latitude', () => {
    const ra = 120;
    const dec = 15;
    const gmst = 40;
    const mc = normLon180(ra - gmst);
    const { asc, dsc } = horizonCurves(ra, dec, gmst);
    const ascByLat = new Map<number, number>();
    for (const seg of asc) for (const p of seg) ascByLat.set(p.lat, p.lon);
    const dscByLat = new Map<number, number>();
    for (const seg of dsc) for (const p of seg) dscByLat.set(p.lat, p.lon);

    let checked = 0;
    for (const [lat, ascLon] of ascByLat) {
      const dscLon = dscByLat.get(lat);
      expect(dscLon).toBeDefined();
      if (dscLon === undefined) continue;
      // λ_AC = MC − H0 and λ_DC = MC + H0 ⇒ (AC−MC) = −(DC−MC). Compare the sum
      // ON THE CIRCLE: at H0≈180° both offsets land on the antimeridian and
      // normLon180 maps them to +180, so a+d reads ±360 — which IS 0 mod 360.
      const a = lonDiff(ascLon, mc); // −H0
      const d = lonDiff(dscLon, mc); // +H0
      expect(Math.abs(normLon180(a + d))).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('clips latitudes where the body has no horizon crossing', () => {
    // High declination ⇒ near the poles cos H = −tanφ·tanδ leaves [−1,1].
    const { asc } = horizonCurves(0, 60, 0);
    const lats = asc.flat().map((p) => p.lat);
    // No |lat| beyond ~30° survives for δ=60° (|tanφ·tanδ| ≤ 1 ⇒ |tanφ| ≤ tan30°).
    expect(Math.max(...lats.map(Math.abs))).toBeLessThan(31);
  });

  it('never leaves a >180° jump inside any returned segment', () => {
    const { asc, dsc } = horizonCurves(179, -10, 5); // forces an antimeridian wrap
    for (const seg of [...asc, ...dsc]) {
      for (let i = 1; i < seg.length; i++) {
        expect(
          Math.abs((seg[i] as AcgPoint).lon - (seg[i - 1] as AcgPoint).lon),
        ).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe('computeAstrocartography — worked Sun MC (J2000 noon @ Greenwich)', () => {
  const result = computeAstrocartography(knownTime);

  it('is available with a GMST and an epoch for a known-time birth', () => {
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.gmst).toBeGreaterThanOrEqual(0);
    expect(result.gmst).toBeLessThan(360);
    expect(result.epochUtc).toMatch(/^2000-01-01T12:00/);
  });

  it("puts the Sun's MC line near the Greenwich meridian at ~local apparent noon", () => {
    // At 12:00 UTC on 2000-01-01 the Sun culminates ~at Greenwich (λ_MC ≈ +0.8°,
    // the equation-of-time offset). Reference RA≈281.28°, GMST≈280.46°.
    if (!result.available) throw new Error('expected available');
    const sun = result.lines.find((l) => l.planet === 'Sun');
    expect(sun).toBeDefined();
    expect(Math.abs(lonDiff(sun!.mc, 0.8))).toBeLessThanOrEqual(TOL);
  });

  it('returns four lines per body with AC/DC as point segments', () => {
    if (!result.available) throw new Error('expected available');
    const sun = result.lines.find((l) => l.planet === 'Sun')!;
    expect(typeof sun.mc).toBe('number');
    expect(typeof sun.ic).toBe('number');
    expect(Array.isArray(sun.asc)).toBe(true);
    expect(sun.asc.flat().length).toBeGreaterThan(50);
    expect(sun.dsc.flat().length).toBeGreaterThan(50);
    expect(sun.asc.flat()[0]).toHaveProperty('lat');
    expect(sun.asc.flat()[0]).toHaveProperty('lon');
  });

  it('includes the core planets (Sun..Pluto) and the lunar node', () => {
    if (!result.available) throw new Error('expected available');
    const names = result.lines.map((l) => l.planet);
    for (const n of [
      'Sun',
      'Moon',
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
      'Pluto',
      'NorthNode',
    ] as const) {
      expect(names).toContain(n);
    }
  });

  it('degrades Chiron under the Moshier backend (no fabricated line)', () => {
    if (!result.available) throw new Error('expected available');
    if (result.ephemerisBackend === 'moshier') {
      expect(result.unavailableBodies).toContain('Chiron');
      expect(result.lines.find((l) => l.planet === 'Chiron')).toBeUndefined();
    } else {
      expect(result.lines.find((l) => l.planet === 'Chiron')).toBeDefined();
    }
  });

  it('is deterministic across recomputes', () => {
    const again = computeAstrocartography(knownTime);
    if (!result.available || !again.available) throw new Error('expected available');
    expect(again.gmst).toBeCloseTo(result.gmst, 9);
    const sunA = result.lines.find((l) => l.planet === 'Sun')!;
    const sunB = again.lines.find((l) => l.planet === 'Sun')!;
    expect(sunB.mc).toBeCloseTo(sunA.mc, 9);
    expect(sunB.ic).toBeCloseTo(sunA.ic, 9);
  });
});

describe('computeAstrocartography — unknown birth time', () => {
  it('returns available:false with a clear reason and NO lines', () => {
    const result = computeAstrocartography({
      ...knownTime,
      time: null,
      timeKnown: false,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/exact birth time/i);
    // The result object carries no `lines` field at all on the unavailable path.
    expect((result as { lines?: unknown }).lines).toBeUndefined();
  });
});
