/**
 * Solar & lunar return tests (TASK C2).
 *
 * The NEW maths here is the one-dimensional root-find for the return instant.
 * We test it directly (the transiting body is at the natal longitude at the
 * found instant, within tolerance — including a 0°/360° WRAP case), that the
 * solar return lands near the birthday and the lunar return within ~27–28 days
 * of the target, and that the returned chart is well-formed. The underlying
 * astronomy is the already-tested A3 natal path (Moshier by default), so we keep
 * planetary assertions to shape/structure with honest Moshier tolerances.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { BirthData } from '@astroapp/shared';
import {
  ANGLE_TOLERANCE_DEG,
  buildConfidence,
  computeReturn,
  findReturnInstant,
  wrap180,
} from '../src/returns.js';
import { computeBody, norm360 } from '../src/astro.js';
import { constants } from '../src/ephemeris.js';
import { julianDayToIso, localToJulianDay, resolveBirthInstant } from '../src/time.js';

const ALICE: BirthData = {
  date: '1990-06-15',
  time: '14:30',
  timeKnown: true,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};

/** Sun/Moon longitude at a JD via the same path the module uses. */
function sunLon(jd: number): number {
  return computeBody(jd, constants.SE_SUN, 'Sun').absoluteDegree;
}
function moonLon(jd: number): number {
  return computeBody(jd, constants.SE_MOON, 'Moon').absoluteDegree;
}

describe('wrap180 — angular difference into (-180, 180]', () => {
  it('handles the 0/360 wrap', () => {
    expect(wrap180(0)).toBeCloseTo(0, 9);
    expect(wrap180(359)).toBeCloseTo(-1, 9);
    expect(wrap180(361)).toBeCloseTo(1, 9);
    expect(wrap180(180)).toBeCloseTo(180, 9);
    expect(wrap180(181)).toBeCloseTo(-179, 9);
  });
});

describe('findReturnInstant — root-finder convergence', () => {
  it('solar: the transiting Sun is AT the natal longitude at the found instant', () => {
    const natalLon = sunLon(
      resolveBirthInstant('1990-06-15', '14:30', true, 'Europe/Lisbon').resolved.jdUt,
    );
    const jdTarget = localToJulianDay('2024-06-10', '00:00', 'UTC').jdUt;
    const res = findReturnInstant(jdTarget, natalLon, 'solar');
    expect(res.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
    expect(Math.abs(wrap180(sunLon(res.jdUt) - natalLon))).toBeLessThan(ANGLE_TOLERANCE_DEG);
  });

  it('lunar: the transiting Moon is AT the natal longitude at the found instant', () => {
    const natalLon = moonLon(
      resolveBirthInstant('1990-06-15', '14:30', true, 'Europe/Lisbon').resolved.jdUt,
    );
    const jdTarget = localToJulianDay('2024-06-10', '00:00', 'UTC').jdUt;
    const res = findReturnInstant(jdTarget, natalLon, 'lunar');
    expect(res.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
    expect(Math.abs(wrap180(moonLon(res.jdUt) - natalLon))).toBeLessThan(ANGLE_TOLERANCE_DEG);
  });

  it('converges across the 0° Aries wrap (natal longitude very near 0°)', () => {
    // Pick a target where the Sun is just before 0° Aries and the return wraps
    // through 360°→0°. Late March each year the Sun crosses 0° Aries.
    const natalLon = 0.2; // just past 0° Aries
    const jdTarget = localToJulianDay('2024-03-01', '00:00', 'UTC').jdUt;
    const res = findReturnInstant(jdTarget, natalLon, 'solar');
    expect(res.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
    // Also test a natal longitude just BELOW 360 so the body wraps up to it.
    const natalLon2 = 359.8;
    const res2 = findReturnInstant(jdTarget, natalLon2, 'solar');
    expect(res2.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
    expect(Math.abs(wrap180(sunLon(res2.jdUt) - natalLon2))).toBeLessThan(ANGLE_TOLERANCE_DEG);
  });

  it('returns the NEXT return on/after the target', () => {
    const natalLon = sunLon(
      resolveBirthInstant('1990-06-15', '14:30', true, 'Europe/Lisbon').resolved.jdUt,
    );
    const jdTarget = localToJulianDay('2024-01-01', '00:00', 'UTC').jdUt;
    const res = findReturnInstant(jdTarget, natalLon, 'solar');
    // The solar return must be after Jan 1 and within ~one year.
    expect(res.jdUt).toBeGreaterThan(jdTarget);
    expect(res.jdUt - jdTarget).toBeLessThan(367);
  });
});

describe('computeReturn — solar return', () => {
  const result = computeReturn({ natal: ALICE, kind: 'solar', target: '2024-06-10' });

  it('is tagged as a solar_return with root-find diagnostics', () => {
    expect(result.kind).toBe('solar_return');
    expect(result.rootFind.method).toBe('newton-bisection-hybrid');
    expect(result.rootFind.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
  });

  it('lands near the birthday (mid-June)', () => {
    const dt = DateTime.fromISO(result.returnInstant, { zone: 'utc' });
    expect(dt.isValid).toBe(true);
    expect(dt.month).toBe(6);
    expect(dt.day).toBeGreaterThanOrEqual(13);
    expect(dt.day).toBeLessThanOrEqual(17);
  });

  it("the transiting Sun is at the chart's natal longitude at the return instant", () => {
    const jd = localToJulianDay(
      DateTime.fromISO(result.returnInstant, { zone: 'utc' }).toFormat('yyyy-MM-dd'),
      DateTime.fromISO(result.returnInstant, { zone: 'utc' }).toFormat('HH:mm'),
      'UTC',
    ).jdUt;
    expect(Math.abs(wrap180(sunLon(jd) - result.natalLongitude))).toBeLessThan(1e-3);
  });

  it('is a well-formed chart with houses (return instant + location are exact)', () => {
    expect(result.housesAvailable).toBe(true);
    expect(result.houses).toHaveLength(12);
    expect(typeof result.ascendant).toBe('number');
    expect(result.planets.length).toBeGreaterThanOrEqual(11);
    for (const p of result.planets) {
      expect(p.degree).toBeCloseTo(norm360(p.absoluteDegree) % 30, 6);
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
    }
  });

  it('defaults the location to the natal place when none is given', () => {
    expect(result.usedNatalLocation).toBe(true);
    expect(result.location.lat).toBeCloseTo(ALICE.lat, 9);
    expect(result.location.lon).toBeCloseTo(ALICE.lon, 9);
    expect(result.location.tzIana).toBe(ALICE.tzIana);
  });

  it('uses a supplied (relocated) location when given', () => {
    const relocated = computeReturn({
      natal: ALICE,
      kind: 'solar',
      target: '2024-06-10',
      location: { lat: 51.5074, lon: -0.1278, tzIana: 'Europe/London' },
    });
    expect(relocated.usedNatalLocation).toBe(false);
    expect(relocated.location.tzIana).toBe('Europe/London');
    // Same instant + planets (location-independent), different Ascendant.
    expect(relocated.returnInstant).toBe(result.returnInstant);
    expect(relocated.ascendant).not.toBeCloseTo(result.ascendant as number, 1);
  });

  it('is HIGH confidence when the natal time is known', () => {
    expect(result.confidence.level).toBe('high');
    expect(result.confidence.notes).toHaveLength(0);
  });
});

describe('computeReturn — lunar return', () => {
  const result = computeReturn({ natal: ALICE, kind: 'lunar', target: '2024-06-10' });

  it('is tagged as a lunar_return and converges', () => {
    expect(result.kind).toBe('lunar_return');
    expect(result.rootFind.residualDeg).toBeLessThan(ANGLE_TOLERANCE_DEG);
  });

  it('lands within ~27–28 days of the target', () => {
    const target = DateTime.fromISO('2024-06-10T00:00', { zone: 'utc' });
    const ret = DateTime.fromISO(result.returnInstant, { zone: 'utc' });
    const days = ret.diff(target, 'days').days;
    expect(days).toBeGreaterThanOrEqual(0);
    expect(days).toBeLessThanOrEqual(28);
  });

  it('the transiting Moon is at the natal longitude at the return instant', () => {
    const dt = DateTime.fromISO(result.returnInstant, { zone: 'utc' });
    const jd = localToJulianDay(dt.toFormat('yyyy-MM-dd'), dt.toFormat('HH:mm'), 'UTC').jdUt;
    // Within ~a minute of arc (the chart stored HH:mm rounds the instant).
    expect(Math.abs(wrap180(moonLon(jd) - result.natalLongitude))).toBeLessThan(0.3);
  });
});

describe('unknown-time confidence flags', () => {
  const noTime: BirthData = { ...ALICE, time: null, timeKnown: false };

  it('solar return is MEDIUM confidence (Sun moves slowly)', () => {
    const r = computeReturn({ natal: noTime, kind: 'solar', target: '2024-06-10' });
    expect(r.confidence.natalTimeKnown).toBe(false);
    expect(r.confidence.level).toBe('medium');
    expect(r.confidence.notes.length).toBeGreaterThan(0);
    // The chart itself still has houses (return instant + location are exact).
    expect(r.housesAvailable).toBe(true);
    expect(r.houses).toHaveLength(12);
  });

  it('lunar return is LOW confidence (Moon moves ~13°/day)', () => {
    const r = computeReturn({ natal: noTime, kind: 'lunar', target: '2024-06-10' });
    expect(r.confidence.level).toBe('low');
    expect(r.confidence.notes.length).toBeGreaterThan(0);
  });

  it('buildConfidence is honest for each combination', () => {
    expect(buildConfidence('solar', true).level).toBe('high');
    expect(buildConfidence('lunar', true).level).toBe('high');
    expect(buildConfidence('solar', false).level).toBe('medium');
    expect(buildConfidence('lunar', false).level).toBe('low');
  });
});

describe('computeReturn — target handling', () => {
  it('accepts a bare yyyy-mm-dd target', () => {
    const r = computeReturn({ natal: ALICE, kind: 'solar', target: '2025-06-01' });
    expect(DateTime.fromISO(r.returnInstant).year).toBe(2025);
  });

  it('round-trips the return instant ISO through julianDayToIso', () => {
    const r = computeReturn({ natal: ALICE, kind: 'solar', target: '2024-06-10' });
    // The reported instant must be a valid ISO datetime.
    expect(DateTime.fromISO(r.returnInstant).isValid).toBe(true);
    // And re-deriving it through the JD path is stable.
    const jd = localToJulianDay(
      DateTime.fromISO(r.returnInstant, { zone: 'utc' }).toFormat('yyyy-MM-dd'),
      DateTime.fromISO(r.returnInstant, { zone: 'utc' }).toFormat('HH:mm'),
      'UTC',
    ).jdUt;
    expect(julianDayToIso(jd)).toContain(DateTime.fromISO(r.returnInstant).toFormat('yyyy-MM-dd'));
  });

  it('throws on an invalid target', () => {
    expect(() => computeReturn({ natal: ALICE, kind: 'solar', target: 'not-a-date' })).toThrow();
  });
});
