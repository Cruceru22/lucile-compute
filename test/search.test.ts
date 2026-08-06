/**
 * Configuration search tests (TASK C7).
 *
 * The NEW maths is the coarse-scan + hybrid-root-refine engine. The strongest
 * checks are SELF-CONSISTENCY at each returned instant:
 *   - aspect:  the wrapped separation equals the exact aspect angle (within tol),
 *   - ingress: the body longitude is ≈ the 30° sign boundary, and
 *   - station: the speed is ≈ 0 and FLIPS sign across the instant.
 * Plus a KNOWN-EVENT check (the Sun's ingress into Aries lands near the March
 * equinox), chronological ordering, and the range-cap / truncation behaviour.
 *
 * The underlying astronomy is the already-tested A3 path (Moshier by default),
 * so tolerances are honest Moshier tolerances.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  MAX_RANGE_DAYS,
  MAX_RESULTS,
  refineRoot,
  searchConfigurations,
  type SearchRequest,
  type SearchResult,
} from '../src/search.js';
import {
  ASPECT_ANGLES,
  SIGNS,
  angularSeparation,
  computeBody,
  norm360,
  signFor,
} from '../src/astro.js';
import { constants } from '../src/ephemeris.js';
import { dateTimeToJulianDay } from '../src/time.js';

/**
 * Body longitude + speed at an ISO UTC datetime, via the same compute path.
 * Builds the JD to FULL precision (incl. seconds) from the Luxon instant so the
 * self-consistency checks are not blunted by minute/second rounding.
 */
function bodyAtIso(iso: string, id: number, name: string): { lon: number; speed: number } {
  const jd = dateTimeToJulianDay(DateTime.fromISO(iso, { zone: 'utc' }));
  const p = computeBody(jd, id, name as never);
  return { lon: p.absoluteDegree, speed: p.speed };
}

describe('refineRoot — hybrid Newton/bisection (reused C2 strategy)', () => {
  it('finds a bracketed root of a simple function', () => {
    // f(x) = x - 100.25 has a root at 100.25.
    const r = refineRoot((x) => x - 100.25, 99, 101, 1e-9);
    expect(r.jd).toBeCloseTo(100.25, 8);
    expect(r.residual).toBeLessThan(1e-8);
  });

  it('returns the closer endpoint for a degenerate (non-bracketing) interval', () => {
    const r = refineRoot((x) => x - 200, 100, 150, 1e-9);
    // Both endpoints negative; closer to 0 is 150.
    expect(r.jd).toBe(150);
  });
});

describe('aspect search — self-consistency', () => {
  // Sun conjunct Mercury over 2024 (several inferior conjunctions a year).
  const req: SearchRequest = {
    kind: 'aspect',
    a: 'Sun',
    b: 'Mercury',
    aspect: 'conjunction',
    from: '2024-01-01',
    to: '2025-01-01',
  };
  const res = searchConfigurations(req);

  it('returns at least one hit', () => {
    expect(res.count).toBeGreaterThan(0);
    expect(res.kind).toBe('aspect');
  });

  it('at every hit the separation equals 0° (conjunction) within tolerance', () => {
    for (const r of res.results) {
      const sun = bodyAtIso(r.datetime, constants.SE_SUN, 'Sun');
      const mer = bodyAtIso(r.datetime, constants.SE_MERCURY, 'Mercury');
      const sep = angularSeparation(sun.lon, mer.lon);
      expect(sep).toBeLessThan(1e-3);
    }
  });

  it('results are sorted chronologically', () => {
    const times = res.results.map((r) => Date.parse(r.datetime));
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it('detects both configurations of a non-conjunction aspect (Sun square Moon)', () => {
    // The Sun–Moon square occurs ~twice per lunar month (first & last quarter).
    const sq = searchConfigurations({
      kind: 'aspect',
      a: 'Sun',
      b: 'Moon',
      aspect: 'square',
      from: '2024-01-01',
      to: '2024-03-01',
    });
    expect(sq.count).toBeGreaterThanOrEqual(3);
    for (const r of sq.results) {
      const sun = bodyAtIso(r.datetime, constants.SE_SUN, 'Sun');
      const moon = bodyAtIso(r.datetime, constants.SE_MOON, 'Moon');
      const sep = angularSeparation(sun.lon, moon.lon);
      expect(Math.abs(sep - ASPECT_ANGLES.square)).toBeLessThan(1e-2);
    }
  });

  it('finds the Mars–Jupiter conjunction of 2024 (known: ~Aug 14 2024)', () => {
    const mj = searchConfigurations({
      kind: 'aspect',
      a: 'Mars',
      b: 'Jupiter',
      aspect: 'conjunction',
      from: '2024-01-01',
      to: '2025-01-01',
    });
    expect(mj.count).toBe(1);
    const dt = DateTime.fromISO(mj.results[0]!.datetime, { zone: 'utc' });
    expect(dt.year).toBe(2024);
    expect(dt.month).toBe(8);
    expect(dt.day).toBeGreaterThanOrEqual(13);
    expect(dt.day).toBeLessThanOrEqual(15);
  });
});

describe('ingress search — self-consistency + known event', () => {
  it('Sun ingress into Aries lands near the March equinox (~Mar 20)', () => {
    const res = searchConfigurations({
      kind: 'ingress',
      body: 'Sun',
      sign: 'Aries',
      from: '2024-01-01',
      to: '2026-01-01',
    });
    // Two years → two Aries ingresses, both ~Mar 20.
    expect(res.count).toBe(2);
    for (const r of res.results) {
      const dt = DateTime.fromISO(r.datetime, { zone: 'utc' });
      expect(dt.month).toBe(3);
      expect(dt.day).toBeGreaterThanOrEqual(19);
      expect(dt.day).toBeLessThanOrEqual(21);
      // Self-consistency: longitude is ≈ 0° Aries (a 30° boundary).
      const lon = bodyAtIso(r.datetime, constants.SE_SUN, 'Sun').lon;
      expect(Math.min(norm360(lon), 360 - norm360(lon))).toBeLessThan(1e-2);
      const d = r.details;
      expect(d.kind === 'ingress' && d.sign).toBe('Aries');
    }
  });

  it('all-sign ingresses of the Sun over a year are ~12, each on a 30° boundary', () => {
    const res = searchConfigurations({
      kind: 'ingress',
      body: 'Sun',
      from: '2024-01-01',
      to: '2025-01-01',
    });
    expect(res.count).toBeGreaterThanOrEqual(11);
    expect(res.count).toBeLessThanOrEqual(13);
    for (const r of res.results) {
      const lon = norm360(bodyAtIso(r.datetime, constants.SE_SUN, 'Sun').lon);
      const dist = Math.abs((lon % 30) - (lon % 30 > 15 ? 30 : 0));
      expect(dist).toBeLessThan(1e-2);
    }
  });
});

describe('station search — self-consistency', () => {
  it('Mercury over a year yields ~3 retrograde + ~3 direct stations, speed flips at each', () => {
    const res = searchConfigurations({
      kind: 'station',
      body: 'Mercury',
      from: '2024-01-01',
      to: '2025-01-01',
    });
    const retro = res.results.filter(
      (r) => r.details.kind === 'station' && r.details.station === 'retrograde',
    );
    const direct = res.results.filter(
      (r) => r.details.kind === 'station' && r.details.station === 'direct',
    );
    // Mercury stations ~3 times retrograde and ~3 times direct per year.
    expect(retro.length).toBeGreaterThanOrEqual(2);
    expect(direct.length).toBeGreaterThanOrEqual(2);
    expect(res.count).toBeGreaterThanOrEqual(5);

    for (const r of res.results) {
      // Speed ≈ 0 at the station.
      const here = bodyAtIso(r.datetime, constants.SE_MERCURY, 'Mercury');
      expect(Math.abs(here.speed)).toBeLessThan(5e-3);
      // Speed FLIPS sign across the instant (±1 day).
      const before = bodyAtIso(
        DateTime.fromISO(r.datetime, { zone: 'utc' }).minus({ days: 2 }).toISO()!,
        constants.SE_MERCURY,
        'Mercury',
      );
      const after = bodyAtIso(
        DateTime.fromISO(r.datetime, { zone: 'utc' }).plus({ days: 2 }).toISO()!,
        constants.SE_MERCURY,
        'Mercury',
      );
      expect(Math.sign(before.speed)).not.toBe(Math.sign(after.speed));
      if (r.details.kind === 'station' && r.details.station === 'retrograde') {
        expect(before.speed).toBeGreaterThan(0);
        expect(after.speed).toBeLessThan(0);
      } else {
        expect(before.speed).toBeLessThan(0);
        expect(after.speed).toBeGreaterThan(0);
      }
    }
  });

  it('the Sun never stations (always direct)', () => {
    const res = searchConfigurations({
      kind: 'station',
      body: 'Sun',
      from: '2024-01-01',
      to: '2025-01-01',
    });
    expect(res.count).toBe(0);
  });
});

describe('bounding — range cap, step, result cap', () => {
  it('rejects a range beyond the cap', () => {
    expect(() =>
      searchConfigurations({
        kind: 'station',
        body: 'Mercury',
        from: '1900-01-01',
        to: '2000-01-01', // 100y > 30y cap
      }),
    ).toThrow(/range too large/i);
  });

  it('accepts a range AT the cap boundary', () => {
    const from = DateTime.fromObject({ year: 2000, month: 1, day: 1 }, { zone: 'utc' });
    const to = from.plus({ days: MAX_RANGE_DAYS - 1 });
    const res = searchConfigurations({
      kind: 'station',
      body: 'Mercury',
      from: from.toISODate()!,
      to: to.toISODate()!,
    });
    expect(res.scan.rangeDays).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      searchConfigurations({ kind: 'station', body: 'Mars', from: '2025-01-01', to: '2024-01-01' }),
    ).toThrow();
  });

  it('truncates at the result cap and flags it (Moon ingresses are very frequent)', () => {
    // The Moon ingresses a new sign every ~2.3 days → over ~30 years that is far
    // more than MAX_RESULTS, so the scan must stop early and flag truncation.
    const from = DateTime.fromObject({ year: 1995, month: 1, day: 1 }, { zone: 'utc' });
    const to = from.plus({ days: MAX_RANGE_DAYS - 1 });
    const res = searchConfigurations({
      kind: 'ingress',
      body: 'Moon',
      from: from.toISODate()!,
      to: to.toISODate()!,
    });
    expect(res.truncated).toBe(true);
    expect(res.count).toBe(MAX_RESULTS);
  });

  it('echoes the scan diagnostics', () => {
    const res = searchConfigurations({
      kind: 'aspect',
      a: 'Sun',
      b: 'Mercury',
      aspect: 'conjunction',
      from: '2024-01-01',
      to: '2024-06-01',
    });
    expect(res.scan.stepDays).toBeGreaterThan(0);
    expect(res.scan.maxResults).toBe(MAX_RESULTS);
    expect(res.scan.toleranceDeg).toBeGreaterThan(0);
  });
});

describe('scan step does not skip a fast-Moon root', () => {
  // The Moon ingresses a new sign every ~2.3 days — the fastest root the engine
  // must catch. The 0.5-day ingress step has to bracket EVERY 30° crossing. If
  // the step were too coarse it would silently miss a crossing, which shows up
  // as a GAP: two consecutive Moon ingresses that jump more than one sign. Over
  // a 30-day window the Moon (always direct) advances exactly one sign per
  // ingress, so we assert strict +1 (mod 12) sign progression with no gaps.
  it('consecutive Moon ingresses advance exactly one sign (no skipped crossing)', () => {
    const res = searchConfigurations({
      kind: 'ingress',
      body: 'Moon',
      from: '2024-01-01',
      to: '2024-01-31',
    });
    // ~30 days / 2.3 days per sign ≈ 12–14 ingresses.
    expect(res.count).toBeGreaterThanOrEqual(11);
    expect(res.truncated).toBe(false);

    const signIdx = (s: string) => SIGNS.indexOf(s as never);
    let prevIdx: number | null = null;
    for (const r of res.results) {
      expect(r.details.kind).toBe('ingress');
      if (r.details.kind !== 'ingress') continue;
      // Self-consistency: the refined crossing longitude is on a 30° boundary,
      // and that boundary opens the reported sign. (We use the engine's own
      // root longitude — re-deriving from the second-truncated ISO can land a
      // hair on the previous-sign side of an exact boundary.)
      const frac = norm360(r.details.longitude) % 30;
      expect(Math.min(frac, 30 - frac)).toBeLessThan(1e-2);
      expect(signFor(norm360(r.details.longitude) + 1e-6)).toBe(r.details.sign);
      // And re-deriving from the reported instant lands within a hair of it.
      const lon = norm360(bodyAtIso(r.datetime, constants.SE_MOON, 'Moon').lon);
      const f2 = lon % 30;
      expect(Math.min(f2, 30 - f2)).toBeLessThan(0.2);

      const idx = signIdx(r.details.sign);
      if (prevIdx !== null) {
        // Exactly one sign forward — a skipped crossing would be a +2 jump.
        expect((idx - prevIdx + 12) % 12, `gap after sign index ${prevIdx}`).toBe(1);
      }
      prevIdx = idx;
    }
  });

  it('finds a known fast Moon–Sun conjunction (the New Moon of 2024-01-11)', () => {
    // The Moon laps the Sun once a ~29.5-day synodic month; the conjunction is
    // exact within hours and is the fastest aspect root. Over a short window the
    // 0.5-day aspect step must still catch it.
    const res = searchConfigurations({
      kind: 'aspect',
      a: 'Moon',
      b: 'Sun',
      aspect: 'conjunction',
      from: '2024-01-08',
      to: '2024-01-14',
    });
    expect(res.count).toBe(1);
    const dt = DateTime.fromISO(res.results[0]!.datetime, { zone: 'utc' });
    expect(dt.month).toBe(1);
    expect(dt.day).toBeGreaterThanOrEqual(10);
    expect(dt.day).toBeLessThanOrEqual(12);
    // Self-consistency at the found instant.
    const moon = bodyAtIso(res.results[0]!.datetime, constants.SE_MOON, 'Moon');
    const sun = bodyAtIso(res.results[0]!.datetime, constants.SE_SUN, 'Sun');
    expect(angularSeparation(moon.lon, sun.lon)).toBeLessThan(1e-3);
  });
});

describe('result shape', () => {
  it('each result has a kind, ISO datetime, bodies, and details', () => {
    const res = searchConfigurations({
      kind: 'aspect',
      a: 'Venus',
      b: 'Mars',
      aspect: 'trine',
      from: '2024-01-01',
      to: '2025-01-01',
    });
    for (const r of res.results as SearchResult[]) {
      expect(r.kind).toBe('aspect');
      expect(DateTime.fromISO(r.datetime).isValid).toBe(true);
      expect(r.bodies).toEqual(['Venus', 'Mars']);
      expect(r.details.kind).toBe('aspect');
    }
  });
});
