/**
 * Life Almanac engine tests (pure, deterministic — no LLM, no network).
 *
 * We compute a real natal chart for a known timed birth and assert the
 * structural + significance + timing guarantees the engine promises:
 *   - a Saturn Return appears near age ~29 with high (floored) significance,
 *   - slow transits group their direct→retro→direct triple into ONE banded
 *     event (passes >= 2, with start < end spanning the band),
 *   - a personalized Pluto→Sun hard hit ranks tier 1,
 *   - ages are COMPUTED from the birth date (the Saturn return is ~29, not a
 *     hardcoded constant),
 *   - isPast / isActive flags are correct for a chosen "now".
 */
import { describe, it, expect } from 'vitest';
import { computeNatal } from '../src/natal.js';
import { buildLifeAlmanac } from '../src/lifeAlmanac.js';
import type { BirthData } from '@astroapp/shared';

const PERSON: BirthData = {
  date: '1990-06-15',
  time: '14:30',
  timeKnown: true,
  lat: 38.7223,
  lon: -9.1393,
  tzIana: 'Europe/Lisbon',
  houseSystem: 'placidus',
};

const BIRTH_ISO = '1990-06-15T14:30:00+01:00';
// A fixed "now" so isPast/isActive are deterministic.
const NOW_ISO = '2024-06-15T00:00:00Z';

describe('Life Almanac', () => {
  const natal = computeNatal(PERSON);
  const almanac = buildLifeAlmanac(natal, BIRTH_ISO, NOW_ISO);

  it('produces a sorted, non-empty timeline with the documented shape', () => {
    expect(almanac.birthDate).toBe(BIRTH_ISO);
    expect(almanac.generatedAt).toBe(NOW_ISO);
    expect(almanac.events.length).toBeGreaterThan(0);
    for (let i = 1; i < almanac.events.length; i++) {
      expect(almanac.events[i]!.exactDate >= almanac.events[i - 1]!.exactDate).toBe(true);
    }
    for (const e of almanac.events) {
      expect(['return', 'cycle', 'transit']).toContain(e.kind);
      expect([1, 2, 3]).toContain(e.tier);
      expect(e.significance).toBeGreaterThanOrEqual(0);
      expect(e.significance).toBeLessThanOrEqual(100);
      expect(e.passes).toBeGreaterThanOrEqual(1);
      // Band ordering invariant.
      expect(e.startDate <= e.exactDate).toBe(true);
      expect(e.exactDate <= e.endDate).toBe(true);
      // Non-fatalist framing present + bounded.
      expect(e.question.length).toBeGreaterThan(0);
      expect(e.body).toMatch(/weather, not fate/);
      // Names the real bodies + aspect.
      expect(e.body.toLowerCase()).toContain(e.transiting.toLowerCase());
    }
  });

  it('includes a Saturn Return at age ~29 with floored high significance', () => {
    const saturnReturns = almanac.events.filter(
      (e) => e.kind === 'return' && e.transiting === 'Saturn',
    );
    expect(saturnReturns.length).toBeGreaterThanOrEqual(1);
    const first = saturnReturns.reduce((a, b) => (a.exactDate < b.exactDate ? a : b));
    // Age is COMPUTED, not hardcoded — Saturn's period is ~29.4y.
    expect(first.ageAtExact).toBeGreaterThan(27.5);
    expect(first.ageAtExact).toBeLessThan(31);
    // Universal milestone floor.
    expect(first.significance).toBeGreaterThanOrEqual(85);
    expect(first.tier).toBe(1);
    expect(first.title).toBe('Saturn Return');
    expect(first.natalPoint).toBe('Saturn');
    expect(first.aspect).toBe('conjunction');
  });

  it('groups a slow transit triple-pass into ONE banded event (passes >= 2)', () => {
    // Some slow transit in this 39-year window perfects 3x (direct/retro/direct).
    const multi = almanac.events.filter((e) => e.passes >= 2);
    expect(multi.length).toBeGreaterThan(0);
    const triple = multi.find((e) => e.passes === 3) ?? multi[0]!;
    // A real band spans time: first exact strictly before last exact.
    expect(Date.parse(triple.startDate)).toBeLessThan(Date.parse(triple.endDate));
    // Exact (peak) sits inside the band.
    expect(Date.parse(triple.exactDate)).toBeGreaterThanOrEqual(Date.parse(triple.startDate));
    expect(Date.parse(triple.exactDate)).toBeLessThanOrEqual(Date.parse(triple.endDate));
    // Band width is within the ~18-month grouping horizon plus refinement slack.
    const widthDays = (Date.parse(triple.endDate) - Date.parse(triple.startDate)) / 86_400_000;
    expect(widthDays).toBeLessThanOrEqual(600);
    if (triple.passes === 3) expect(triple.body).toMatch(/perfects 3 times/);
  });

  it('ranks a personalized Pluto→Sun hard hit as tier 1', () => {
    const plutoSun = almanac.events.filter(
      (e) =>
        e.kind === 'transit' &&
        e.transiting === 'Pluto' &&
        e.natalPoint === 'Sun' &&
        ['conjunction', 'opposition', 'square'].includes(e.aspect),
    );
    // This cohort/chart yields at least one hard Pluto–Sun contact in the window.
    expect(plutoSun.length).toBeGreaterThanOrEqual(1);
    for (const e of plutoSun) {
      // Pluto(1.0) x Sun(1.0) x hard(>=0.85) => >= 85 => tier 1.
      expect(e.significance).toBeGreaterThanOrEqual(80);
      expect(e.tier).toBe(1);
    }
  });

  it('computes ages from the birth date (not hardcoded) and they increase with time', () => {
    for (const e of almanac.events) {
      const expected = (Date.parse(e.exactDate) - Date.parse(BIRTH_ISO)) / (365.25 * 86_400_000);
      // ageAtExact is within rounding of the true elapsed years.
      expect(Math.abs(e.ageAtExact - expected)).toBeLessThan(0.2);
      expect(e.ageAtExact).toBeGreaterThanOrEqual(0);
    }
  });

  it('sets isPast / isActive from the per-planet ORB window (not a zero-width band)', () => {
    const nowMs = Date.parse(NOW_ISO);
    const DAY = 86_400_000;
    // Mirror lifeAlmanac's ORB_DAYS half-windows so the assertion stays meaningful.
    const ORB_DAYS: Record<string, number> = {
      Pluto: 120,
      Neptune: 90,
      Uranus: 75,
      Saturn: 45,
      Chiron: 45,
      Jupiter: 14,
      NorthNode: 14,
    };
    for (const e of almanac.events) {
      const start = Date.parse(e.startDate);
      const end = Date.parse(e.endDate);
      const exact = Date.parse(e.exactDate);
      const orb = (ORB_DAYS[e.transiting] ?? 30) * DAY;
      const activeStart = Math.min(start, exact) - orb;
      const activeEnd = Math.max(end, exact) + orb;
      expect(e.isActive).toBe(nowMs >= activeStart && nowMs <= activeEnd);
      expect(e.isPast).toBe(activeEnd < nowMs);
      // Past and active are mutually exclusive.
      expect(e.isPast && e.isActive).toBe(false);
    }
    // There must be at least one already-past event (e.g. the Saturn Return at ~29
    // for a 1990 birth, viewed from 2024).
    expect(almanac.events.some((e) => e.isPast)).toBe(true);
  });

  it('makes a single-pass event ACTIVE when now sits within its orb window', () => {
    // Build an almanac whose "now" is the exact date of a single-pass event; the
    // old zero-width formula (now>=start && now<=end with start===end===exact)
    // was true only at the precise millisecond, so a transit exact "today" never
    // lit up. With the orb window it must be ACTIVE (and not PAST).
    const single = almanac.events.find((e) => e.passes === 1);
    expect(single).toBeDefined();
    const at = buildLifeAlmanac(natal, BIRTH_ISO, single!.exactDate);
    const same = at.events.find((e) => e.id === single!.id);
    expect(same).toBeDefined();
    expect(same!.isActive).toBe(true);
    expect(same!.isPast).toBe(false);
  });
});
