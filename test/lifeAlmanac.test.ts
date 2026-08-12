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
import {
  almanacFingerprint,
  applyNow,
  buildLifeAlmanac,
  horizonOf,
  needsRecompute,
} from '../src/lifeAlmanac.js';
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

/**
 * The cached-almanac path: rows in `life_almanac_cache` store the timeline as
 * computed on some earlier day, and `applyNow` is what keeps them honest as
 * time passes. If these break, a cached almanac silently shows last year's
 * "happening now".
 */
describe('applyNow — re-deriving time-relative flags on a cached timeline', () => {
  const birth: BirthData = {
    date: '1990-05-21',
    time: '12:00',
    timeKnown: true,
    lat: 38.7223,
    lon: -9.1393,
    tzIana: 'Europe/Lisbon',
    houseSystem: 'placidus',
  };
  const natal = computeNatal(birth);
  const built = buildLifeAlmanac(natal, birth.date, '2020-01-01T00:00:00.000Z');

  it('leaves the events themselves untouched — only the flags move', () => {
    const shifted = applyNow(built, '2030-01-01T00:00:00.000Z');
    expect(shifted.events).toHaveLength(built.events.length);
    for (const [i, e] of shifted.events.entries()) {
      const original = built.events[i]!;
      expect(e.id).toBe(original.id);
      expect(e.exactDate).toBe(original.exactDate);
      expect(e.startDate).toBe(original.startDate);
      expect(e.endDate).toBe(original.endDate);
      expect(e.significance).toBe(original.significance);
    }
  });

  it('agrees with a freshly computed almanac for the same "now"', () => {
    // The whole premise of the cache: re-flagging an old sweep must give the
    // same answer as paying for a new one.
    const now = '2024-06-01T00:00:00.000Z';
    const fresh = buildLifeAlmanac(natal, birth.date, now);
    const reflagged = applyNow(built, now);

    for (const e of fresh.events) {
      const cached = reflagged.events.find((c) => c.id === e.id);
      // The 2020 sweep reaches to 2025, so every 2024-relevant event exists in
      // both; anything beyond the old horizon is legitimately absent.
      if (!cached) continue;
      expect(cached.isActive, `isActive mismatch for ${e.id}`).toBe(e.isActive);
      expect(cached.isPast, `isPast mismatch for ${e.id}`).toBe(e.isPast);
    }
  });

  it('marks everything past once "now" is far beyond the timeline', () => {
    const far = applyNow(built, '2200-01-01T00:00:00.000Z');
    expect(far.events.every((e) => e.isPast)).toBe(true);
    expect(far.events.some((e) => e.isActive)).toBe(false);
  });

  it('keeps past and active mutually exclusive', () => {
    const shifted = applyNow(built, '2024-06-01T00:00:00.000Z');
    expect(shifted.events.some((e) => e.isPast && e.isActive)).toBe(false);
  });

  it('restamps generatedAt to the moment asked for', () => {
    expect(applyNow(built, '2024-06-01T00:00:00.000Z').generatedAt).toBe(
      '2024-06-01T00:00:00.000Z',
    );
  });

  it('rejects an unparseable now', () => {
    expect(() => applyNow(built, 'not-a-date')).toThrow(/Invalid nowIso/);
  });
});

/**
 * The fingerprint is what stops the cache serving a stale person.
 *
 * `life_almanac_cache` is keyed by `birth_data_id`, and that id SURVIVES an
 * edit — correcting a birth time or flipping tropical/sidereal rewrites the
 * chart in place. Without a fingerprint the cache would hand back the pre-edit
 * timeline forever, and it would look completely plausible.
 */
describe('almanacFingerprint — cache invalidation', () => {
  const birth: BirthData = {
    date: '1990-05-21',
    time: '12:00',
    timeKnown: true,
    lat: 38.7223,
    lon: -9.1393,
    tzIana: 'Europe/Lisbon',
    houseSystem: 'placidus',
  };
  const natal = computeNatal(birth);
  const base = almanacFingerprint(natal, birth.date);

  it('is stable across calls for identical inputs', () => {
    expect(almanacFingerprint(computeNatal(birth), birth.date)).toBe(base);
  });

  it('changes when the birth TIME is corrected', () => {
    const corrected = computeNatal({ ...birth, time: '14:05' });
    expect(almanacFingerprint(corrected, birth.date)).not.toBe(base);
  });

  it('changes when the birth PLACE moves', () => {
    const elsewhere = computeNatal({
      ...birth,
      lat: 51.5072,
      lon: -0.1276,
      tzIana: 'Europe/London',
    });
    expect(almanacFingerprint(elsewhere, birth.date)).not.toBe(base);
  });

  it('changes when the birth DATE changes', () => {
    const other = { ...birth, date: '1990-05-22' };
    expect(almanacFingerprint(computeNatal(other), other.date)).not.toBe(base);
  });

  it('changes when the birth time goes from known to unknown', () => {
    const untimed = computeNatal({ ...birth, timeKnown: false });
    expect(almanacFingerprint(untimed, birth.date)).not.toBe(base);
  });

  it('changes when a planet longitude moves, even slightly', () => {
    // Stands in for a zodiac switch (sidereal shifts every longitude by the
    // ayanamsa) — the id and birth date are identical, only the chart moved.
    const shifted = {
      ...natal,
      planets: natal.planets.map((p, i) =>
        i === 0 ? { ...p, absoluteDegree: p.absoluteDegree + 24 } : p,
      ),
    };
    expect(almanacFingerprint(shifted, birth.date)).not.toBe(base);
  });

  it('is insensitive to the ORDER planets arrive in', () => {
    // Same chart, different array order, must stay one cache entry.
    const reversed = { ...natal, planets: [...natal.planets].reverse() };
    expect(almanacFingerprint(reversed, birth.date)).toBe(base);
  });

  it('is insensitive to float noise below 1e-6 degrees', () => {
    const jittered = {
      ...natal,
      planets: natal.planets.map((p) => ({ ...p, absoluteDegree: p.absoluteDegree + 1e-9 })),
    };
    expect(almanacFingerprint(jittered, birth.date)).toBe(base);
  });
});

/**
 * The cache-freshness rule. Getting this wrong is quiet in both directions: too
 * strict and the cache never hits (we are back to a full sweep per open); too
 * loose and the timeline's far tail silently runs out.
 */
describe('cache horizon', () => {
  it('a sweep written today reaches five years out', () => {
    expect(horizonOf('2026-08-08T00:00:00.000Z')).toBe('2031-08-08');
  });

  it('accepts a cache written today', () => {
    const now = '2026-08-08T00:00:00.000Z';
    expect(needsRecompute(horizonOf(now), now)).toBe(false);
  });

  it('still accepts a cache written eleven months ago', () => {
    // The whole point: someone opening the screen daily must not pay for a
    // fresh sweep every day just because the tail thinned by a few weeks.
    expect(needsRecompute(horizonOf('2025-09-08T00:00:00.000Z'), '2026-08-08T00:00:00.000Z')).toBe(
      false,
    );
  });

  it('rebuilds a cache written over a year ago', () => {
    expect(needsRecompute(horizonOf('2025-06-08T00:00:00.000Z'), '2026-08-08T00:00:00.000Z')).toBe(
      true,
    );
  });

  it('rebuilds when the stored horizon is already in the past', () => {
    expect(needsRecompute('2020-01-01', '2026-08-08T00:00:00.000Z')).toBe(true);
  });

  it('rebuilds rather than trusting an unparseable horizon', () => {
    // Date.parse -> NaN, and NaN < x is false, so a naive implementation would
    // treat garbage as FRESH and serve it forever. Assert the safe direction.
    expect(needsRecompute('not-a-date', '2026-08-08T00:00:00.000Z')).toBe(true);
  });
});
