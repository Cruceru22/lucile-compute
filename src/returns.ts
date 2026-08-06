/**
 * Solar & lunar returns (TASK C2).
 *
 * A **return** chart is cast for the exact moment a transiting body returns to
 * its natal ecliptic longitude:
 *
 *  - A **solar return** is the instant each year (near the birthday) when the
 *    transiting Sun reaches the EXACT longitude it held at birth. It frames the
 *    themes of the coming solar year.
 *  - A **lunar return** is the instant (~every 27.3 days) when the transiting
 *    Moon reaches its natal longitude. It frames a single lunar month.
 *
 * The return chart is a NORMAL natal-style chart computed for that instant at a
 * chosen LOCATION (default: the natal location). The location determines the
 * houses / Ascendant; the planetary positions depend only on the instant.
 *
 * This module REUSES the existing A3 compute internals — the planet-longitude
 * calculation (`computeBody`) for the root-find, and the natal builder
 * (`computeNatal`) to turn the resolved instant + location into a full chart,
 * exactly as B5's Davison does. No new astronomy is introduced beyond the
 * one-dimensional root-find.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ROOT-FINDING METHOD + TOLERANCE
 * ──────────────────────────────────────────────────────────────────────────
 * We seek the JD where the WRAPPED angular difference `f(jd) = wrap180(
 * lon(jd) - natalLon )` is zero. `f` is monotonic-and-continuous over the span
 * of one return period as long as the body does not reverse direction across
 * the root (the Sun never does; the Moon never reverses in longitude). We:
 *   1. Seed an initial guess from the target date and the body's MEAN motion
 *      (Sun ≈ 0.9856°/day, Moon ≈ 13.176°/day): step from the target by the
 *      signed wrapped angle / mean-motion to land within ~a day of the root.
 *   2. BRACKET the root by expanding a small interval around the guess (one
 *      mean-motion day each side) until `f` changes sign.
 *   3. Refine with NEWTON's method (derivative = the body's instantaneous
 *      longitude speed from sweph), falling back to BISECTION on the bracket
 *      whenever a Newton step would leave the bracket or stall — a robust
 *      hybrid that always converges.
 * We converge until |f| < {@link ANGLE_TOLERANCE_DEG} (1e-7°, far under one
 * second of time for either body). All angle differences are reduced into
 * (-180, 180] so the 0°/360° wrap is handled correctly.
 */
import type { BirthData, NatalChart, PlanetName } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { computeBody, norm360 } from './astro.js';
import { computeNatal, type NatalChartResponse } from './natal.js';
import { julianDayToIso, localToJulianDay, resolveBirthInstant } from './time.js';
import { constants, getBackend, type EphemerisBackend } from './ephemeris.js';

/** Which body completes the return. */
export type ReturnKind = 'solar' | 'lunar';

/** Mean daily motion in ecliptic longitude (deg/day). */
const MEAN_MOTION: Record<ReturnKind, number> = {
  solar: 360 / 365.256363, // sidereal-ish year; close enough to seed the guess
  lunar: 360 / 27.321661, // sidereal month
};

/** sweph body id + display name for each return kind. */
const RETURN_BODY: Record<ReturnKind, { id: number; name: PlanetName }> = {
  solar: { id: constants.SE_SUN, name: 'Sun' },
  lunar: { id: constants.SE_MOON, name: 'Moon' },
};

/**
 * Convergence tolerance on the angular difference, in degrees. 1e-7° is ~0.36
 * milliarcseconds; at the Moon's speed that is well under a millisecond of time,
 * far finer than the ephemeris accuracy itself.
 */
export const ANGLE_TOLERANCE_DEG = 1e-7;

/** Reduce an angular difference into (-180, 180]. */
export function wrap180(deg: number): number {
  let d = norm360(deg);
  if (d > 180) d -= 360;
  return d;
}

/** Transiting longitude (and instantaneous speed) of the return body at a JD. */
function bodyLongitude(jdUt: number, kind: ReturnKind): { lon: number; speed: number } {
  const { id, name } = RETURN_BODY[kind];
  const pos = computeBody(jdUt, id, name);
  return { lon: pos.absoluteDegree, speed: pos.speed };
}

export interface RootFindResult {
  /** The JD (UT) at which the body is at the natal longitude. */
  jdUt: number;
  /** Iterations used (diagnostic). */
  iterations: number;
  /** Final |angular difference| at the found instant, in degrees. */
  residualDeg: number;
}

/**
 * Find the instant the return body reaches `natalLon`, on or after `jdTarget`
 * (within one return period). Hybrid Newton/bisection on the wrapped angle.
 *
 * @param jdTarget   JD to search from (the return on/after this date).
 * @param natalLon   The natal longitude to return to, in [0, 360).
 * @param kind       Solar or lunar.
 */
export function findReturnInstant(
  jdTarget: number,
  natalLon: number,
  kind: ReturnKind,
): RootFindResult {
  const meanMotion = MEAN_MOTION[kind];

  // f(jd): signed wrapped difference between transiting and natal longitude.
  const f = (jd: number): number => wrap180(bodyLongitude(jd, kind).lon - natalLon);

  // 1. Seed: how far (in mean-motion days) is the body, AT THE TARGET, from the
  //    natal longitude going FORWARD? Step forward by that amount so the guess
  //    is the NEXT return on/after the target.
  const diffAtTarget = norm360(natalLon - bodyLongitude(jdTarget, kind).lon); // [0,360)
  const guess = jdTarget + diffAtTarget / meanMotion;

  // 2. Bracket the root around the guess. One mean-motion day each side usually
  //    brackets it; expand a few times if not (robust to the eccentric Moon).
  const period = 360 / meanMotion;
  let lo = guess - 1.5;
  let hi = guess + 1.5;
  let flo = f(lo);
  let fhi = f(hi);
  let expand = 0;
  while (flo * fhi > 0 && expand < 8) {
    lo -= period * 0.1;
    hi += period * 0.1;
    flo = f(lo);
    fhi = f(hi);
    expand += 1;
  }

  // 3. Hybrid Newton + bisection. Start from the guess.
  let jd = guess;
  let iterations = 0;
  const MAX_ITERS = 100;
  for (; iterations < MAX_ITERS; iterations++) {
    const { lon, speed } = bodyLongitude(jd, kind);
    const fx = wrap180(lon - natalLon);
    if (Math.abs(fx) < ANGLE_TOLERANCE_DEG) break;

    // Maintain the bracket so we can fall back to bisection.
    if (flo * fx <= 0) {
      hi = jd;
      fhi = fx;
    } else {
      lo = jd;
      flo = fx;
    }

    // Newton step using the instantaneous speed (deg/day); guard against a tiny
    // or zero derivative.
    let next = speed !== 0 ? jd - fx / speed : Number.NaN;
    // Bisection fallback when Newton leaves the bracket or is invalid.
    if (!Number.isFinite(next) || next <= lo || next >= hi) {
      next = (lo + hi) / 2;
    }
    if (next === jd) break;
    jd = next;
  }

  return {
    jdUt: jd,
    iterations,
    residualDeg: Math.abs(wrap180(bodyLongitude(jd, kind).lon - natalLon)),
  };
}

/** A chosen return location (defaults to the natal location). */
export interface ReturnLocation {
  lat: number;
  lon: number;
  tzIana: string;
}

/**
 * Confidence flags for a return chart. The return chart's OWN houses are always
 * valid (the return instant + location are known once computed); these flags
 * concern how reliably we located the return INSTANT given the natal data.
 */
export interface ReturnConfidence {
  /** Natal birth time was known (the natal longitude is exact). */
  natalTimeKnown: boolean;
  /** Overall confidence in the resolved return instant. */
  level: 'high' | 'medium' | 'low';
  /** Plain-language caveats (empty when high confidence). */
  notes: string[];
}

/**
 * A return chart response. Reuses the {@link NatalChart} shape (so the same
 * client renderer/interpreters work) and adds the discriminant `kind`, the
 * resolved return instant + location, the root-find diagnostics, and the
 * confidence flags. Defined locally — the shared package is not modified.
 */
export interface ReturnChart extends NatalChart {
  kind: 'solar_return' | 'lunar_return';
  /** The natal longitude the body returned to (transparency). */
  natalLongitude: number;
  /** The exact UTC instant of the return (ISO). */
  returnInstant: string;
  /** The location the chart was cast for (houses/Asc come from here). */
  location: ReturnLocation;
  /** Whether the location defaulted to the natal place. */
  usedNatalLocation: boolean;
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
  housesAvailable: boolean;
  /** Root-find diagnostics. */
  rootFind: {
    method: 'newton-bisection-hybrid';
    toleranceDeg: number;
    iterations: number;
    residualDeg: number;
  };
  confidence: ReturnConfidence;
}

export interface ComputeReturnInput {
  natal: BirthData;
  kind: ReturnKind;
  /** Date (yyyy-mm-dd, or ISO datetime) the return is on/after. */
  target: string;
  /** Optional location; defaults to the natal location when omitted. */
  location?: ReturnLocation;
}

/**
 * Compute a solar or lunar return chart.
 *
 * Steps:
 *   1. Read the natal body longitude (Sun/Moon) from the natal instant. We use
 *      the natal positions REGARDLESS of whether the birth time is known — the
 *      Sun/Moon longitude is well-defined from the date alone, with a small
 *      uncertainty when the time is unknown (reflected in the confidence flags).
 *   2. Root-find the JD where the transiting body reaches that natal longitude,
 *      on/after the target date.
 *   3. Build a NORMAL natal chart for that UTC instant at the chosen location by
 *      synthesising a UTC-zoned BirthData and calling {@link computeNatal} — the
 *      same reuse pattern as the Davison chart.
 *
 * @throws if the target date cannot be parsed.
 */
export function computeReturn(input: ComputeReturnInput): ReturnChart {
  const { natal, kind, target } = input;

  // 1. Natal body longitude. Resolve the natal instant (noon fallback for
  //    unknown time, exactly like the natal endpoint) and read the body.
  const natalResolved = resolveBirthInstant(natal.date, natal.time, natal.timeKnown, natal.tzIana);
  const natalLongitude = bodyLongitude(natalResolved.resolved.jdUt, kind).lon;

  // Target → JD (UT). Accept a bare date (treated as 00:00 UTC) or an ISO
  // datetime. We search for the return on/after this instant.
  const targetDt = DateTime.fromISO(target.length <= 10 ? `${target}T00:00` : target, {
    zone: 'utc',
  });
  if (!targetDt.isValid) {
    throw new Error(`Invalid target date for return: ${target} (${targetDt.invalidReason})`);
  }
  const jdTarget = localToJulianDay(
    targetDt.toFormat('yyyy-MM-dd'),
    targetDt.toFormat('HH:mm'),
    'UTC',
  ).jdUt;

  // 2. Root-find the return instant.
  const root = findReturnInstant(jdTarget, natalLongitude, kind);
  const returnIso = julianDayToIso(root.jdUt);

  // 3. Build the return chart for the resolved instant + chosen location.
  const usedNatalLocation = input.location === undefined;
  const location: ReturnLocation = input.location ?? {
    lat: natal.lat,
    lon: natal.lon,
    tzIana: natal.tzIana,
  };

  // Express the return instant as a UTC-zoned BirthData so computeNatal
  // reproduces exactly this instant; houses come from the chosen location.
  //
  // `tzIana` MUST be 'UTC' here. `date`/`time` below are a UTC wall-clock
  // reading, but computeNatal → localToJulianDay interprets them as LOCAL time
  // in whatever zone it is handed. Passing `location.tzIana` therefore re-read
  // the instant in the display zone and shifted the chart by the full UTC
  // offset — 64° of Ascendant error for America/New_York, i.e. more than two
  // signs, while the Sun/Moon moved little enough to look plausible. It was
  // invisible in tests because they only relocate between zones sharing an
  // offset. `relationship.ts` (Davison) already gets this right.
  const dt = DateTime.fromISO(returnIso, { zone: 'utc' });
  const returnBirth: BirthData = {
    // NOTE: localToJulianDay parses only HH:mm and zeroes seconds, so the chart
    // is still cast up to 59s after the root-found instant (~0.25° of Ascendant).
    date: dt.toFormat('yyyy-MM-dd'),
    time: dt.toFormat('HH:mm'),
    timeKnown: true, // the return instant is exact by construction
    lat: location.lat,
    lon: location.lon,
    tzIana: 'UTC',
    houseSystem: natal.houseSystem,
  };
  const chart: NatalChartResponse = computeNatal(returnBirth);

  const confidence = buildConfidence(kind, natal.timeKnown);

  return {
    kind: kind === 'solar' ? 'solar_return' : 'lunar_return',
    natalLongitude,
    returnInstant: returnIso,
    location,
    usedNatalLocation,
    planets: chart.planets,
    houses: chart.houses,
    aspects: chart.aspects,
    ascendant: chart.housesAvailable ? chart.ascendant : null,
    midheaven: chart.housesAvailable ? chart.midheaven : null,
    houseSystem: chart.houseSystem,
    computedAt: chart.computedAt,
    timeKnown: true,
    housesAvailable: chart.housesAvailable,
    ephemerisBackend: getBackend(),
    unavailableBodies: chart.unavailableBodies,
    rootFind: {
      method: 'newton-bisection-hybrid',
      toleranceDeg: ANGLE_TOLERANCE_DEG,
      iterations: root.iterations,
      residualDeg: root.residualDeg,
    },
    confidence,
  };
}

/**
 * Honest confidence flags.
 *
 * - When the natal birth TIME is known, the natal Sun/Moon longitude is exact,
 *   so the resolved return instant is high confidence for both kinds.
 * - When the natal time is UNKNOWN we computed the natal longitude at local
 *   noon. The Sun moves ~1°/day, so its natal longitude is uncertain by up to
 *   ~±0.5° → the solar return instant is uncertain by up to ~half a day. That is
 *   acceptable for the slow Sun (positions barely shift), so we flag it MEDIUM.
 *   The Moon moves ~13°/day, so an unknown natal time makes the NATAL Moon
 *   longitude uncertain by up to ~±6.5°, which shifts the lunar return instant
 *   by up to ~half a day and can move the fast Moon noticeably → LOW confidence.
 */
export function buildConfidence(kind: ReturnKind, natalTimeKnown: boolean): ReturnConfidence {
  if (natalTimeKnown) {
    return { natalTimeKnown: true, level: 'high', notes: [] };
  }
  if (kind === 'solar') {
    return {
      natalTimeKnown: false,
      level: 'medium',
      notes: [
        'Birth time unknown, the natal Sun longitude was taken at local noon, so the solar-return moment is uncertain by up to about half a day. The Sun moves slowly, so positions are still reliable.',
      ],
    };
  }
  return {
    natalTimeKnown: false,
    level: 'low',
    notes: [
      'Birth time unknown, the natal Moon longitude can be off by several degrees (the Moon moves ~13°/day), so this lunar return moment is low-confidence. Add a birth time for an accurate lunar return.',
    ],
  };
}
