/**
 * Electional reason codes + the strength of the two cautions.
 *
 * Two things are pinned here:
 *
 *   1. Every verdict carries machine-readable `reasonCodes` alongside the
 *      English `reasons`. The mobile UI renders the codes; the prose exists
 *      only for non-UI consumers. A verdict that emits prose without a code
 *      would silently reintroduce English-in-every-locale.
 *   2. Mercury retrograde alone must NOT reach the `avoid` tier. It is a
 *      weeks-long background condition, not an instant, and Today treats it as
 *      a footnote — the two screens must not disagree about the same sky.
 *      Void-of-course, which is narrow and computable, still caps into `avoid`.
 */
import { describe, expect, it } from 'vitest';

import { buildElectional } from '../src/electional.js';

/** `days` days from `from` for one location, so every factor shows up. */
function table(from: string, days: number) {
  return buildElectional({ from, days, lat: 41.88, lon: -87.63, tzIana: 'America/Chicago' }).days;
}

describe('reason codes', () => {
  it('emits a code for every prose reason', () => {
    for (const day of table('2026-08-01', 28)) {
      for (const verdict of day.verdicts) {
        expect(
          verdict.reasonCodes.length,
          `${day.date}/${verdict.activity}: ${verdict.reasons.length} reasons but ${verdict.reasonCodes.length} codes`,
        ).toBe(verdict.reasons.length);
      }
    }
  });

  it('only emits codes the client knows how to render', () => {
    const known = new Set([
      'phaseWaxingFavoured',
      'phaseWaningFavoured',
      'phaseMismatch',
      'dayRulerFavoured',
      'mercuryRetrograde',
      'voidOfCourse',
    ]);
    for (const day of table('2026-01-01', 90)) {
      for (const verdict of day.verdicts) {
        for (const reason of verdict.reasonCodes) {
          expect(known.has(reason.code), `unknown reason code: ${reason.code}`).toBe(true);
        }
      }
    }
  });

  it('supplies the params its strings interpolate', () => {
    for (const day of table('2026-01-01', 59)) {
      for (const verdict of day.verdicts) {
        for (const reason of verdict.reasonCodes) {
          if (reason.code === 'phaseMismatch') {
            expect(reason.params?.actual).toBeTruthy();
            expect(reason.params?.wanted).toBeTruthy();
          }
          if (reason.code === 'dayRulerFavoured') {
            expect(reason.params?.ruler).toBeTruthy();
            expect(reason.params?.weekday).toBeTruthy();
          }
        }
      }
    }
  });
});

describe('the strength of the cautions', () => {
  it('never lets Mercury retrograde ALONE reach the avoid tier', () => {
    let sawMercuryOnly = false;
    for (const day of table('2026-01-01', 365)) {
      for (const verdict of day.verdicts) {
        const codes = verdict.reasonCodes.map((r) => r.code);
        if (codes.includes('mercuryRetrograde') && !codes.includes('voidOfCourse')) {
          sawMercuryOnly = true;
          expect(
            verdict.tier,
            `${day.date}/${verdict.activity} scored ${verdict.score} on Mercury Rx alone`,
          ).not.toBe('avoid');
        }
      }
    }
    // The assertion above is vacuous if no such day exists in a whole year.
    expect(sawMercuryOnly, 'no Mercury-retrograde day found in 2026').toBe(true);
  });

  it('still lets void-of-course cap into avoid', () => {
    let sawVoid = false;
    for (const day of table('2026-01-01', 181)) {
      for (const verdict of day.verdicts) {
        const codes = verdict.reasonCodes.map((r) => r.code);
        if (codes.includes('voidOfCourse')) {
          sawVoid = true;
          expect(verdict.score).toBeLessThanOrEqual(30);
        }
      }
    }
    expect(sawVoid, 'no void-of-course day found in six months').toBe(true);
  });
});
