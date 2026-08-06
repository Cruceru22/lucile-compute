/**
 * Configuration search engine (TASK C7) — an Astro-Seek-style scan of the
 * ephemeris over a date range for astrological configurations.
 *
 * Three query kinds (a discriminated union, Zod-validated in `schemas.ts`):
 *
 *  - **aspect**:  a transiting aspect between two bodies. We scan with a coarse
 *    step, watch the WRAPPED angular SEPARATION minus the exact aspect angle,
 *    and refine each sign-change to the exact instant of exactitude.
 *  - **ingress**: a body entering a sign — its ecliptic longitude crosses a 30°
 *    multiple. We watch the longitude relative to each boundary and refine to
 *    the exact crossing.
 *  - **station**: a planet's retrograde / direct stations — its longitude SPEED
 *    changes sign. We watch the speed and refine to the instant speed ≈ 0.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SCAN + REFINE METHOD
 * ──────────────────────────────────────────────────────────────────────────
 * For every kind we define a continuous scalar function f(jd) whose ROOT marks
 * the event, sample it on a coarse grid (a per-kind step chosen so the fastest
 * relevant body cannot skip a root), detect sign changes between adjacent
 * samples, and refine each bracketed root with the SAME robust hybrid
 * Newton/bisection root-finder C2 introduced ({@link refineRoot} below mirrors
 * `findReturnInstant`'s inner loop: Newton using an analytic/finite-difference
 * derivative, falling back to bisection whenever a step would leave the bracket
 * or stall). Convergence is to {@link ANGLE_TOLERANCE_DEG} on the (angular or
 * speed) residual — far finer than the Moshier ephemeris itself.
 *
 * BOUNDING. The scan is bounded three ways so it can never run unboundedly:
 *   1. RANGE cap — the `[from, to)` span is limited to {@link MAX_RANGE_DAYS}
 *      (≈ 30 years); a longer request is rejected by the schema.
 *   2. STEP size — a fixed per-kind grid step (days) keeps the sample count
 *      linear in the span (≈ span / step).
 *   3. RESULT cap — at most {@link MAX_RESULTS} hits are returned; if the scan
 *      would exceed that we stop early and set `truncated: true`.
 */
import type { AspectType, PlanetName, ZodiacSign } from '@astroapp/shared';
import { ASPECT_ANGLES, BODIES, computeBody, norm360, SIGNS } from './astro.js';
import { wrap180 } from './returns.js';
import { julianDayToIso, localToJulianDay } from './time.js';
import { DateTime } from 'luxon';

/** Convergence tolerance, in degrees (angular residual) or deg/day (speed). */
export const ANGLE_TOLERANCE_DEG = 1e-7;

/**
 * Maximum search span, in days (~30 years). Long enough for the slow outer
 * planets' cycles while keeping any scan bounded. Enforced by the schema.
 */
export const MAX_RANGE_DAYS = 366 * 30;

/** Maximum hits returned; beyond this the scan stops and flags `truncated`. */
export const MAX_RESULTS = 500;

/** Coarse scan step (days) per kind. Small enough not to skip a root. */
const STEP_DAYS = {
  /** Aspects: the Moon moves ~13°/day, so even a sextile window is days wide;
   *  half-day steps comfortably bracket every crossing without skipping. */
  aspect: 0.5,
  /** Ingress: same fast-Moon concern — half-day steps bracket each 30° crossing. */
  ingress: 0.5,
  /** Stations: speed changes slowly near zero; a 1-day grid brackets the flip. */
  station: 1,
} as const;

/** sweph body id for a chart body name. */
function bodyId(name: PlanetName): number {
  const b = BODIES.find((x) => x.name === name);
  if (!b) throw new Error(`Unknown body: ${name}`);
  return b.id;
}

/** Longitude (+ speed) of a body at a JD, via the same path C2 uses. */
function bodyAt(jdUt: number, name: PlanetName): { lon: number; speed: number } {
  const pos = computeBody(jdUt, bodyId(name), name);
  return { lon: pos.absoluteDegree, speed: pos.speed };
}

/* -------------------------------------------------------------------------- */
/* Result + request shapes (defined locally; shared package is not modified)   */
/* -------------------------------------------------------------------------- */

export type SearchKind = 'aspect' | 'ingress' | 'station';

/** One search hit, common across kinds. Sorted chronologically by `datetime`. */
export interface SearchResult {
  kind: SearchKind;
  /** Exact instant of the configuration (ISO UTC). */
  datetime: string;
  /** The body/bodies involved. */
  bodies: PlanetName[];
  /** Kind-specific detail (exact longitude, sign, aspect, direction…). */
  details: SearchResultDetails;
}

export type SearchResultDetails =
  | {
      kind: 'aspect';
      aspect: AspectType;
      /** Exact aspect angle (0/60/90/120/180). */
      angle: number;
      /** Longitudes of a and b at exactitude. */
      lonA: number;
      lonB: number;
    }
  | {
      kind: 'ingress';
      /** Sign entered. */
      sign: ZodiacSign;
      /** The body's longitude at the crossing (≈ the 30° boundary). */
      longitude: number;
      /** Direct (forward) or retrograde ingress. */
      direction: 'direct' | 'retrograde';
    }
  | {
      kind: 'station';
      /** 'retrograde' = turning retrograde (speed + → −); 'direct' = − → +. */
      station: 'retrograde' | 'direct';
      /** The body's longitude at the station. */
      longitude: number;
    };

export interface SearchResponse {
  kind: SearchKind;
  /** Echo of the resolved scan window (ISO UTC). */
  from: string;
  to: string;
  results: SearchResult[];
  count: number;
  /** True when the result cap was hit and later events were dropped. */
  truncated: boolean;
  /** Scan diagnostics (transparency). */
  scan: {
    stepDays: number;
    rangeDays: number;
    maxResults: number;
    toleranceDeg: number;
  };
}

/** The validated request (mirrors `searchRequestSchema` in schemas.ts). */
export type SearchRequest =
  | {
      kind: 'aspect';
      a: PlanetName;
      b: PlanetName;
      aspect: AspectType;
      from: string;
      to: string;
    }
  | {
      kind: 'ingress';
      body: PlanetName;
      /** Optional: only ingresses INTO this sign; omitted ⇒ all sign ingresses. */
      sign?: ZodiacSign;
      from: string;
      to: string;
    }
  | {
      kind: 'station';
      body: PlanetName;
      from: string;
      to: string;
    };

/* -------------------------------------------------------------------------- */
/* Root refinement — the C2 hybrid Newton/bisection, reused for any f(jd)       */
/* -------------------------------------------------------------------------- */

/**
 * Refine a root of `f` known to be bracketed in `[lo, hi]` (f(lo)*f(hi) ≤ 0).
 * Hybrid Newton + bisection, exactly the strategy `findReturnInstant` uses:
 * Newton with a finite-difference derivative, falling back to bisection whenever
 * a step leaves the bracket, the derivative is degenerate, or it stalls. The
 * caller supplies `f` (continuous across the bracket) and the tolerance on |f|.
 */
export function refineRoot(
  f: (jd: number) => number,
  lo: number,
  hi: number,
  tol: number = ANGLE_TOLERANCE_DEG,
): { jd: number; residual: number; iterations: number } {
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  // Degenerate bracket: return the closer endpoint.
  if (fa * fb > 0) {
    const jd = Math.abs(fa) <= Math.abs(fb) ? a : b;
    return { jd, residual: Math.min(Math.abs(fa), Math.abs(fb)), iterations: 0 };
  }

  let jd = (a + b) / 2;
  let iterations = 0;
  const MAX_ITERS = 100;
  // Finite-difference step for the derivative (~1 minute of time).
  const H = 1 / 1440;
  for (; iterations < MAX_ITERS; iterations++) {
    const fx = f(jd);
    if (Math.abs(fx) < tol) break;

    // Maintain the bracket.
    if (fa * fx <= 0) {
      b = jd;
      fb = fx;
    } else {
      a = jd;
      fa = fx;
    }

    // Newton step with a centred finite-difference derivative.
    const deriv = (f(jd + H) - f(jd - H)) / (2 * H);
    let next = deriv !== 0 ? jd - fx / deriv : Number.NaN;
    if (!Number.isFinite(next) || next <= a || next >= b) {
      next = (a + b) / 2; // bisection fallback
    }
    if (next === jd) break;
    jd = next;
  }
  return { jd, residual: Math.abs(f(jd)), iterations };
}

/* -------------------------------------------------------------------------- */
/* Time-window resolution                                                      */
/* -------------------------------------------------------------------------- */

/** Parse a bare `yyyy-mm-dd` or ISO datetime into a UT Julian Day. */
function toJd(value: string): { jd: number; iso: string } {
  const dt = DateTime.fromISO(value.length <= 10 ? `${value}T00:00` : value, { zone: 'utc' });
  if (!dt.isValid) {
    throw new Error(`Invalid date: ${value} (${dt.invalidReason})`);
  }
  const jd = localToJulianDay(dt.toFormat('yyyy-MM-dd'), dt.toFormat('HH:mm'), 'UTC').jdUt;
  return { jd, iso: dt.toISO({ suppressMilliseconds: true }) ?? value };
}

/** Resolve + validate the `[from, to)` window, enforcing the range cap. */
function resolveWindow(from: string, to: string): { jdFrom: number; jdTo: number; days: number } {
  const a = toJd(from);
  const b = toJd(to);
  if (b.jd <= a.jd) {
    throw new Error('`to` must be after `from`.');
  }
  const days = b.jd - a.jd;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(
      `Search range too large: ${days.toFixed(0)} days exceeds the ${MAX_RANGE_DAYS}-day cap.`,
    );
  }
  return { jdFrom: a.jd, jdTo: b.jd, days };
}

/* -------------------------------------------------------------------------- */
/* The scan engine                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generic coarse-grid scan: sample `f` from `jdFrom` to `jdTo` in `step`-day
 * increments, and for every sign change between adjacent samples refine the
 * bracketed root and hand it to `onRoot`. Returns when the window is exhausted
 * or `onRoot` signals the result cap is reached (returns `false`).
 *
 * Roots exactly AT a sample (f === 0) are handled by the ≤ sign test so they are
 * not missed nor double-counted (the refine on the bracket converges to them).
 */
function scan(
  jdFrom: number,
  jdTo: number,
  step: number,
  f: (jd: number) => number,
  onRoot: (jd: number) => boolean,
): void {
  let prevJd = jdFrom;
  let prevF = f(prevJd);
  for (let jd = jdFrom + step; jd <= jdTo + 1e-9; jd += step) {
    const curJd = Math.min(jd, jdTo);
    const curF = f(curJd);
    // A sign change (or a sample landing on the root) brackets a root.
    if (prevF === 0 || prevF * curF < 0) {
      const root = refineRoot(f, prevJd, curJd);
      // Only accept roots strictly inside the window (dedupe boundary touches).
      if (root.jd >= jdFrom - 1e-9 && root.jd <= jdTo + 1e-9) {
        if (!onRoot(root.jd)) return;
      }
    }
    prevJd = curJd;
    prevF = curF;
    if (curJd >= jdTo) break;
  }
}

/**
 * ASPECT scan. `f(jd) = wrap180(separation(jd) − angle)` where `separation` is
 * the wrapped signed longitude difference of b relative to a, folded so that the
 * function is continuous and crosses zero exactly at the aspect. For a non-zero,
 * non-180 aspect there are TWO geometric configurations (b ahead of / behind a);
 * we detect both by scanning the signed difference against +angle and −angle.
 */
function scanAspect(
  jdFrom: number,
  jdTo: number,
  a: PlanetName,
  b: PlanetName,
  aspect: AspectType,
  push: (jd: number) => boolean,
): void {
  const angle = ASPECT_ANGLES[aspect];
  // Signed wrapped difference (b − a) in (-180, 180].
  const signedDiff = (jd: number): number => wrap180(bodyAt(jd, b).lon - bodyAt(jd, a).lon);

  // For each target offset we want |signedDiff| ≈ angle. Track f = signedDiff −
  // target so a sign change brackets the exact contact. 0 and 180 have a single
  // target; 60/90/120 have ±angle (the two-sided configurations).
  const targets = angle === 0 || angle === 180 ? [angle] : [angle, -angle];
  // Collect roots from each target into one chronological stream, but respect the
  // shared result cap across targets via the `push` callback.
  for (const target of targets) {
    const f = (jd: number): number => wrap180(signedDiff(jd) - target);
    let stop = false;
    scan(jdFrom, jdTo, STEP_DAYS.aspect, f, (jd) => {
      const ok = push(jd);
      if (!ok) stop = true;
      return ok;
    });
    if (stop) return;
  }
}

/**
 * INGRESS scan. We watch the body's longitude relative to the NEAREST 30°
 * boundary via a continuous sawtooth: f(jd) = wrap180(lon(jd) − boundaryOf(jd)),
 * where `boundaryOf` is the multiple of 30° at the start of the current degree
 * window. Simpler + robust: scan the wrapped distance into the current sign and
 * detect when the body crosses a 30° line by sign-changes of `wrap180(lon − k)`
 * for the boundary k it is approaching. We implement it by tracking the sign
 * index and refining the exact crossing whenever it changes between samples.
 */
function scanIngress(
  jdFrom: number,
  jdTo: number,
  body: PlanetName,
  targetSign: ZodiacSign | undefined,
  push: (
    jd: number,
    signEntered: ZodiacSign,
    lon: number,
    direction: 'direct' | 'retrograde',
  ) => boolean,
): void {
  const lonAt = (jd: number): number => bodyAt(jd, body).lon;
  const signIdxAt = (jd: number): number => Math.floor(norm360(lonAt(jd)) / 30) % 12;

  let prevJd = jdFrom;
  let prevIdx = signIdxAt(prevJd);
  const step = STEP_DAYS.ingress;
  for (let jd = jdFrom + step; jd <= jdTo + 1e-9; jd += step) {
    const curJd = Math.min(jd, jdTo);
    const curIdx = signIdxAt(curJd);
    if (curIdx !== prevIdx) {
      // The body crossed one (occasionally more, for fast Moon over a long step —
      // but 0.5d is < one sign for every body) 30° boundary in (prevJd, curJd].
      // The boundary it crossed is the longitude k = 30 * (entered index) when
      // moving direct, or 30 * (prev index) when retrograde. Refine on f = the
      // wrapped distance to the boundary line that separates the two indices.
      const boundaryDeg = boundaryBetween(prevIdx, curIdx);
      const f = (j: number): number => wrap180(lonAt(j) - boundaryDeg);
      const root = refineRoot(f, prevJd, curJd);
      const enteredIdx = signIdxAt(root.jd + 1e-4) === curIdx ? curIdx : signIdxAt(root.jd + 1e-4);
      const enteredSign = SIGNS[((enteredIdx % 12) + 12) % 12] as ZodiacSign;
      const direction = bodyAt(root.jd, body).speed >= 0 ? 'direct' : 'retrograde';
      if (!targetSign || enteredSign === targetSign) {
        if (!push(root.jd, enteredSign, norm360(lonAt(root.jd)), direction)) return;
      }
    }
    prevJd = curJd;
    prevIdx = curIdx;
    if (curJd >= jdTo) break;
  }
}

/**
 * The 30° boundary longitude separating two adjacent sign indices. Adjacent
 * indices `i`→`j` (mod 12) share the line at 30 * max-when-direct; we pick the
 * boundary that lies between them. For a direct step i→i+1 the line is 30*(i+1);
 * for retrograde i→i-1 it is 30*i. We compute it from which index is "higher" in
 * the crossing direction.
 */
function boundaryBetween(prevIdx: number, curIdx: number): number {
  // Direct motion (e.g. 2 → 3, or 11 → 0): boundary = 30 * curIdx (the line the
  // body just stepped past, with wrap 0 handled by norm360 in the caller's f).
  const forward = (prevIdx + 1) % 12 === curIdx;
  if (forward) return norm360(30 * curIdx);
  // Retrograde (e.g. 3 → 2, or 0 → 11): boundary = 30 * prevIdx.
  return norm360(30 * prevIdx);
}

/**
 * STATION scan. f(jd) = speed(jd). A sign change of the longitude speed marks a
 * station; we refine to speed ≈ 0. The station is 'retrograde' when speed goes
 * + → − (the planet turns retrograde) and 'direct' when − → +.
 */
function scanStation(
  jdFrom: number,
  jdTo: number,
  body: PlanetName,
  push: (jd: number, station: 'retrograde' | 'direct', lon: number) => boolean,
): void {
  const speedAt = (jd: number): number => bodyAt(jd, body).speed;
  const f = (jd: number): number => speedAt(jd);
  let prevJd = jdFrom;
  let prevSpeed = speedAt(prevJd);
  const step = STEP_DAYS.station;
  for (let jd = jdFrom + step; jd <= jdTo + 1e-9; jd += step) {
    const curJd = Math.min(jd, jdTo);
    const curSpeed = speedAt(curJd);
    if (prevSpeed === 0 || prevSpeed * curSpeed < 0) {
      const root = refineRoot(f, prevJd, curJd);
      const station: 'retrograde' | 'direct' = prevSpeed > 0 ? 'retrograde' : 'direct';
      if (!push(root.jd, station, norm360(bodyAt(root.jd, body).lon))) return;
    }
    prevJd = curJd;
    prevSpeed = curSpeed;
    if (curJd >= jdTo) break;
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run a configuration search. Resolves + caps the window, dispatches on `kind`,
 * collects up to {@link MAX_RESULTS} hits (flagging `truncated` if more exist),
 * and returns them sorted chronologically.
 */
export function searchConfigurations(req: SearchRequest): SearchResponse {
  const { jdFrom, jdTo, days } = resolveWindow(req.from, req.to);

  const results: SearchResult[] = [];
  let truncated = false;
  const stepDays = STEP_DAYS[req.kind];

  /** Push a result; return false (stop the scan) once the cap is hit. */
  const capReached = (): boolean => {
    if (results.length >= MAX_RESULTS) {
      truncated = true;
      return true;
    }
    return false;
  };

  if (req.kind === 'aspect') {
    scanAspect(jdFrom, jdTo, req.a, req.b, req.aspect, (jd) => {
      if (capReached()) return false;
      const lonA = norm360(bodyAt(jd, req.a).lon);
      const lonB = norm360(bodyAt(jd, req.b).lon);
      results.push({
        kind: 'aspect',
        datetime: julianDayToIso(jd),
        bodies: [req.a, req.b],
        details: {
          kind: 'aspect',
          aspect: req.aspect,
          angle: ASPECT_ANGLES[req.aspect],
          lonA,
          lonB,
        },
      });
      return true;
    });
  } else if (req.kind === 'ingress') {
    scanIngress(jdFrom, jdTo, req.body, req.sign, (jd, sign, lon, direction) => {
      if (capReached()) return false;
      results.push({
        kind: 'ingress',
        datetime: julianDayToIso(jd),
        bodies: [req.body],
        details: { kind: 'ingress', sign, longitude: lon, direction },
      });
      return true;
    });
  } else {
    scanStation(jdFrom, jdTo, req.body, (jd, station, lon) => {
      if (capReached()) return false;
      results.push({
        kind: 'station',
        datetime: julianDayToIso(jd),
        bodies: [req.body],
        details: { kind: 'station', station, longitude: lon },
      });
      return true;
    });
  }

  // Aspect scans interleave two targets, so sort the final stream chronologically.
  results.sort((x, y) => Date.parse(x.datetime) - Date.parse(y.datetime));

  return {
    kind: req.kind,
    from: julianDayToIso(jdFrom),
    to: julianDayToIso(jdTo),
    results,
    count: results.length,
    truncated,
    scan: {
      stepDays,
      rangeDays: days,
      maxResults: MAX_RESULTS,
      toleranceDeg: ANGLE_TOLERANCE_DEG,
    },
  };
}
