/**
 * Composite + Davison relationship-chart tests (TASK B5).
 *
 * We test the NEW maths exactly (midpoint along the shorter arc incl. the 360°
 * wrap, the temporal + geographic midpoints) on hand-computable cases, and
 * assert both endpoints return well-formed charts. The underlying astronomy is
 * the already-tested A3 natal path (Moshier by default), so we keep planetary
 * assertions to shape/structure and reserve the exact assertions for the
 * reductions this task introduces.
 */
import { describe, it, expect } from 'vitest';
import type { BirthData } from '@astroapp/shared';
import {
  shorterArcMidpoint,
  geographicMidpoint,
  temporalMidpointJd,
  compositeBodies,
  computeComposite,
  computeDavison,
} from '../src/relationship.js';
import { computeAllBodies } from '../src/astro.js';
import { localToJulianDay, julianDayToIso } from '../src/time.js';

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

describe('shorterArcMidpoint — composite midpoint convention', () => {
  it('takes the plain midpoint when both are in the same half', () => {
    expect(shorterArcMidpoint(10, 50).midpoint).toBeCloseTo(30, 6);
    expect(shorterArcMidpoint(0, 90).midpoint).toBeCloseTo(45, 6);
  });

  it('crosses 0° along the SHORTER arc (the wrap case: 350° & 10° → 0°)', () => {
    const r = shorterArcMidpoint(350, 10);
    expect(angDiff(r.midpoint, 0)).toBeCloseTo(0, 6);
    expect(r.antipodal).toBe(false);
  });

  it('is symmetric in its arguments', () => {
    expect(shorterArcMidpoint(10, 350).midpoint).toBeCloseTo(
      shorterArcMidpoint(350, 10).midpoint,
      6,
    );
    expect(shorterArcMidpoint(200, 40).midpoint).toBeCloseTo(
      shorterArcMidpoint(40, 200).midpoint,
      6,
    );
  });

  it('handles another wrap: 340° & 20° → 0°', () => {
    expect(angDiff(shorterArcMidpoint(340, 20).midpoint, 0)).toBeCloseTo(0, 6);
  });

  it('flags antipodal (exactly 180° apart) and disambiguates to a + 90°', () => {
    const r = shorterArcMidpoint(0, 180);
    expect(r.antipodal).toBe(true);
    expect(r.midpoint).toBeCloseTo(90, 6);
    const r2 = shorterArcMidpoint(100, 280);
    expect(r2.antipodal).toBe(true);
    expect(r2.midpoint).toBeCloseTo(190, 6);
  });

  it('returns a value in [0, 360)', () => {
    for (const [a, b] of [
      [359, 1],
      [10, 200],
      [123.4, 67.8],
    ]) {
      const m = shorterArcMidpoint(a, b).midpoint;
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(360);
    }
  });
});

describe('geographicMidpoint — great-circle midpoint', () => {
  it('midpoint of two points on the equator is the average longitude', () => {
    const m = geographicMidpoint(0, 0, 0, 90);
    expect(m.lat).toBeCloseTo(0, 6);
    expect(m.lon).toBeCloseTo(45, 6);
  });

  it('midpoint of identical points is that point', () => {
    const m = geographicMidpoint(38.72, -9.14, 38.72, -9.14);
    expect(m.lat).toBeCloseTo(38.72, 4);
    expect(m.lon).toBeCloseTo(-9.14, 4);
  });

  it('midpoint across the antimeridian wraps correctly (170°E & 170°W → 180°)', () => {
    const m = geographicMidpoint(0, 170, 0, -170);
    expect(m.lat).toBeCloseTo(0, 6);
    expect(angDiff(m.lon, 180)).toBeCloseTo(0, 4);
  });

  it('midpoint of two same-meridian points is the latitude average', () => {
    const m = geographicMidpoint(40, 10, 60, 10);
    expect(m.lon).toBeCloseTo(10, 4);
    expect(m.lat).toBeCloseTo(50, 1);
  });
});

describe('temporalMidpointJd — average of the two UTC instants', () => {
  it('the midpoint JD is exactly the average of the two birth JDs', () => {
    const a: BirthData = {
      date: '2000-01-01',
      time: '00:00',
      timeKnown: true,
      lat: 0,
      lon: 0,
      tzIana: 'UTC',
      houseSystem: 'placidus',
    };
    const b: BirthData = { ...a, date: '2000-01-11', time: '00:00' };
    const { jdUt } = temporalMidpointJd(a, b);
    const jdA = localToJulianDay('2000-01-01', '00:00', 'UTC').jdUt;
    const jdB = localToJulianDay('2000-01-11', '00:00', 'UTC').jdUt;
    expect(jdUt).toBeCloseTo((jdA + jdB) / 2, 9);
    // 10 days apart → midpoint is 2000-01-06 00:00 UTC.
    expect(julianDayToIso(jdUt)).toContain('2000-01-06');
  });

  it('averages the TIME of day too (06:00 & 18:00 same day → 12:00)', () => {
    const a: BirthData = {
      date: '2010-05-05',
      time: '06:00',
      timeKnown: true,
      lat: 0,
      lon: 0,
      tzIana: 'UTC',
      houseSystem: 'placidus',
    };
    const b: BirthData = { ...a, time: '18:00' };
    const { jdUt } = temporalMidpointJd(a, b);
    const iso = julianDayToIso(jdUt);
    expect(iso).toContain('2010-05-05');
    expect(iso).toContain('12:00');
  });
});

describe('compositeBodies — per-body midpoints from two real charts', () => {
  it('returns one entry per body common to both charts', () => {
    const aBodies = computeAllBodies(localToJulianDay('1990-06-15', '12:00', 'Europe/Lisbon').jdUt);
    const bBodies = computeAllBodies(localToJulianDay('1992-03-20', '12:00', 'Europe/Lisbon').jdUt);
    const composite = compositeBodies(aBodies, bBodies);
    expect(composite.length).toBeGreaterThanOrEqual(11);
    for (const cb of composite) {
      expect(cb.midpoint).toBeGreaterThanOrEqual(0);
      expect(cb.midpoint).toBeLessThan(360);
      // The midpoint must lie on the shorter arc between the two sources.
      const half = angDiff(cb.lonA, cb.lonB) / 2;
      expect(angDiff(cb.midpoint, cb.lonA)).toBeLessThanOrEqual(half + 1e-6);
      expect(angDiff(cb.midpoint, cb.lonB)).toBeLessThanOrEqual(half + 1e-6);
    }
  });
});

const ALICE: BirthData = {
  date: '1990-06-15',
  time: '14:30',
  timeKnown: true,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};
const BOB: BirthData = {
  date: '1988-11-02',
  time: '09:15',
  timeKnown: true,
  lat: 40.4168,
  lon: -3.7038,
  tzIana: 'Europe/Madrid',
  houseSystem: 'placidus',
};

describe('computeComposite — well-formed composite chart', () => {
  const chart = computeComposite(ALICE, BOB);

  it('is tagged as a composite with the documented method', () => {
    expect(chart.kind).toBe('composite');
    expect(chart.method.longitudes).toBe('shorter-arc-midpoint');
    expect(chart.method.houses).toBe('midpoint-of-ascendants-and-mc');
  });

  it('returns planets with consistent sign/degree from the midpoint longitude', () => {
    expect(chart.planets.length).toBeGreaterThanOrEqual(11);
    for (const p of chart.planets) {
      expect(p.degree).toBeCloseTo(p.absoluteDegree % 30, 6);
      expect(p.retrograde).toBe(false); // composite points have no motion
    }
  });

  it('has 12 equal houses and a composite Asc/MC because both times are known', () => {
    expect(chart.housesAvailable).toBe(true);
    expect(chart.houses).toHaveLength(12);
    expect(typeof chart.ascendant).toBe('number');
    // Equal houses: each cusp 30° from the previous.
    for (let i = 1; i < 12; i++) {
      expect(angDiff(chart.houses[i]!.cuspDegree, chart.houses[i - 1]!.cuspDegree)).toBeCloseTo(
        30,
        4,
      );
    }
  });

  it("each composite planet's longitude is the shorter-arc midpoint of the two sources", () => {
    const aBodies = computeAllBodies(localToJulianDay('1990-06-15', '14:30', 'Europe/Lisbon').jdUt);
    const bBodies = computeAllBodies(localToJulianDay('1988-11-02', '09:15', 'Europe/Madrid').jdUt);
    const sun = chart.planets.find((p) => p.name === 'Sun')!;
    const aSun = aBodies.find((p) => p.name === 'Sun')!;
    const bSun = bBodies.find((p) => p.name === 'Sun')!;
    const expected = shorterArcMidpoint(aSun.absoluteDegree, bSun.absoluteDegree).midpoint;
    expect(angDiff(sun.absoluteDegree, expected)).toBeCloseTo(0, 6);
  });

  it('omits houses when either birth time is unknown', () => {
    const noTime = computeComposite({ ...ALICE, time: null, timeKnown: false }, BOB);
    expect(noTime.housesAvailable).toBe(false);
    expect(noTime.houses).toHaveLength(0);
    expect(noTime.ascendant).toBeNull();
    expect(noTime.method.houses).toBe('omitted-unknown-time');
    // Planets still present.
    expect(noTime.planets.length).toBeGreaterThanOrEqual(11);
  });
});

describe('computeDavison — well-formed Davison chart', () => {
  const chart = computeDavison(ALICE, BOB);

  it('is tagged as a davison with the documented method', () => {
    expect(chart.kind).toBe('davison');
    expect(chart.method.time).toBe('utc-instant-average');
    expect(chart.method.location).toBe('spherical-great-circle-midpoint');
  });

  it('exposes the derived midpoint date + location', () => {
    const expectedMid = geographicMidpoint(ALICE.lat, ALICE.lon, BOB.lat, BOB.lon);
    expect(chart.midpoint.lat).toBeCloseTo(expectedMid.lat, 4);
    expect(chart.midpoint.lon).toBeCloseTo(expectedMid.lon, 4);
    const { jdUt } = temporalMidpointJd(ALICE, BOB);
    expect(chart.midpoint.utc).toBe(julianDayToIso(jdUt));
  });

  it('is a REAL natal chart: 12 houses + Asc/MC when both times are known', () => {
    expect(chart.housesAvailable).toBe(true);
    expect(chart.houses).toHaveLength(12);
    expect(typeof chart.ascendant).toBe('number');
    for (const p of chart.planets) {
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
    }
  });

  it('omits houses when either birth time is unknown', () => {
    const noTime = computeDavison({ ...ALICE, time: null, timeKnown: false }, BOB);
    expect(noTime.housesAvailable).toBe(false);
    expect(noTime.houses).toHaveLength(0);
    expect(noTime.ascendant).toBeNull();
    expect(noTime.planets.length).toBeGreaterThanOrEqual(11);
  });
});
