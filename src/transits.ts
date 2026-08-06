/**
 * Transit computation: find the EXACT datetimes at which a transiting body
 * forms a major aspect to a natal body within a date window.
 *
 * Approach: for each (transiting body, natal body, aspect) triple we sample
 * the signed deviation `f(t) = signedSeparation(t) - aspectAngle` on a daily
 * grid across the window. When `f` changes sign between two samples the aspect
 * is exact in that interval; we then bisect to refine the exact instant to
 * within a minute. We report each exactitude as a TransitEvent.
 */
import type { NatalChart, PlanetName, TransitEvent, AspectType } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { ASPECT_ANGLES, BODIES, computeBody, norm360 } from './astro.js';
import { dateTimeToJulianDay, julianDayToIso } from './time.js';

/** Bodies considered as transiting (all chart bodies). */
const TRANSITING = BODIES;

/**
 * Signed angular distance of the transiting body from an aspect target, wrapped
 * to (-180, 180]: `δ = wrap180(lonTransit − lonNatal − offset)`. Zero ⇒ exact.
 *
 * This MUST be the signed form, not `|separation| − angle`. Absolute separation
 * lies in [0, 180], so `absSep − 0 ≥ 0` always and `absSep − 180 ≤ 0` always:
 * neither ever changes sign, and the bracketing test below could therefore NEVER
 * detect a conjunction or an opposition — the two most significant aspects there
 * are. `lifeAlmanac.ts` and `search.ts` already use this signed form; this module
 * was the one that was never migrated.
 */
function signedDelta(lonTransit: number, lonNatal: number, offset: number): number {
  let d = norm360(lonTransit - lonNatal - offset);
  if (d > 180) d -= 360;
  return d;
}

/**
 * The longitude offsets that realise an aspect. An aspect of angle `a` is exact
 * when the body leads OR trails the natal point by `a`, so both `+a` and `−a`
 * are scanned — except for 0 and 180, which are their own mirror.
 */
function offsetsFor(aspectAngle: number): number[] {
  if (aspectAngle === 0 || aspectAngle === 180) return [aspectAngle];
  return [aspectAngle, 360 - aspectAngle];
}

/** Longitude of a transiting body at a Julian Day. */
function lonAt(jdUt: number, id: number, name: PlanetName): number {
  return computeBody(jdUt, id, name).absoluteDegree;
}

/**
 * Refine the exact instant of an aspect via bisection between two Julian Days
 * where the signed deviation changes sign. Returns the JD of exactitude.
 */
function refineExact(
  jdLo: number,
  jdHi: number,
  id: number,
  name: PlanetName,
  natalLon: number,
  offset: number,
): number {
  let lo = jdLo;
  let hi = jdHi;
  let fLo = signedDelta(lonAt(lo, id, name), natalLon, offset);
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    const fMid = signedDelta(lonAt(mid, id, name), natalLon, offset);
    if (Math.abs(hi - lo) < 1 / 1440) break; // < 1 minute
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export interface TransitOptions {
  /** Sampling step in days (default 1). */
  stepDays?: number;
  /**
   * Restrict which TRANSITING bodies are considered. Useful for an annual
   * forecast where only the slow, theme-defining planets (Jupiter..Pluto +
   * Chiron/Node) matter and the fast Moon/inner planets are noise.
   */
  transitingBodies?: PlanetName[];
}

/**
 * Compute exact transit events between `from` and `to` (inclusive of the
 * window endpoints), comparing every transiting body against every natal
 * planet for all five major aspects.
 *
 * @param natal  Previously computed natal chart (provides natal longitudes).
 * @param fromIso ISO datetime (UTC or with offset) window start.
 * @param toIso   ISO datetime window end.
 */
export function computeTransits(
  natal: NatalChart,
  fromIso: string,
  toIso: string,
  opts: TransitOptions = {},
): TransitEvent[] {
  // Clamp the sampling step defensively. The schema already bounds `stepDays` to
  // [0.01, 366], but `computeTransits` is also called directly (annual forecast,
  // tests) and must never trust an out-of-range step: a sub-millisecond step would
  // run tens of millions of synchronous `swe_calc` calls and pin the event loop.
  const STEP_MIN = 0.01;
  const STEP_MAX = 366;
  const step = Math.min(Math.max(opts.stepDays ?? 1, STEP_MIN), STEP_MAX);
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const to = DateTime.fromISO(toIso, { zone: 'utc' });
  if (!from.isValid || !to.isValid || to <= from) {
    throw new Error('Invalid transit window: `to` must be a valid datetime after `from`.');
  }

  const jdFrom = dateTimeToJulianDay(from);
  const jdTo = dateTimeToJulianDay(to);

  // Hard cap the TOTAL synchronous work before scanning, so a (valid-but-
  // pathological) tiny step, wide window, OR oversized natal.planets array can't
  // blow up into an unbounded synchronous compute. The real cost is the triple
  // loop below: `samples × transiting bodies × natal planets × aspects`. The
  // grid (`span/step`) and the natal-planet count are both attacker-influenced on
  // the free single-day path, so bound their product; transiting bodies (≤ ~17)
  // and aspects (5) are bounded constants folded into the budget. Reject rather
  // than silently truncate.
  const MAX_SAMPLES = 100_000;
  const samples = (jdTo - jdFrom) / step;
  const work = samples * Math.max(1, natal.planets.length);
  if (samples > MAX_SAMPLES || work > MAX_SAMPLES) {
    throw new Error(
      `Transit request too large: ${Math.ceil(samples)} samples × ${natal.planets.length} natal bodies exceeds the work cap. Widen \`stepDays\`, narrow the window, or reduce the chart.`,
    );
  }
  const aspectTypes = Object.keys(ASPECT_ANGLES) as AspectType[];
  const events: TransitEvent[] = [];

  // Skip transiting bodies the active backend cannot compute (e.g. Chiron under
  // Moshier, which has no `seas_*.se1` file). Probe once at the window start.
  const allow = opts.transitingBodies ? new Set(opts.transitingBodies) : null;
  const transiting = TRANSITING.filter((t) => {
    if (allow && !allow.has(t.name)) return false;
    try {
      lonAt(jdFrom, t.id, t.name);
      return true;
    } catch {
      return false;
    }
  });

  for (const t of transiting) {
    for (const natalPlanet of natal.planets) {
      for (const aspect of aspectTypes) {
        const angle = ASPECT_ANGLES[aspect];
        // Scan BOTH offsets that realise the aspect (leading and trailing), which
        // the old absolute-separation form collapsed into one.
        for (const offset of offsetsFor(angle)) {
          let jdPrev = jdFrom;
          let fPrev = signedDelta(lonAt(jdPrev, t.id, t.name), natalPlanet.absoluteDegree, offset);
          for (let jd = jdFrom + step; jd <= jdTo + 1e-9; jd += step) {
            const jdCur = Math.min(jd, jdTo);
            const fCur = signedDelta(
              lonAt(jdCur, t.id, t.name),
              natalPlanet.absoluteDegree,
              offset,
            );
            // A sign change over a SHORT span is a true crossing; a jump of ~360
            // is just δ wrapping across the ±180 seam, not an aspect.
            if (
              fPrev !== 0 &&
              Math.sign(fCur) !== Math.sign(fPrev) &&
              Math.abs(fCur - fPrev) < 180
            ) {
              const jdExact = refineExact(
                jdPrev,
                jdCur,
                t.id,
                t.name,
                natalPlanet.absoluteDegree,
                offset,
              );
              if (jdExact >= jdFrom - 1e-9 && jdExact <= jdTo + 1e-9) {
                events.push({
                  transitingPlanet: t.name,
                  natalPlanet: natalPlanet.name,
                  aspect,
                  exactAt: julianDayToIso(jdExact),
                  orb: 0,
                });
              }
            }
            jdPrev = jdCur;
            fPrev = fCur;
          }
        }
      }
    }
  }

  events.sort((a, b) => a.exactAt.localeCompare(b.exactAt));
  return events;
}
