/**
 * Birth-time RECTIFICATION (TASK D4).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (AND IS NOT)
 * ──────────────────────────────────────────────────────────────────────────
 * Many users do not know their exact birth time. The chart features that depend
 * on the time — the ANGLES (Ascendant / Midheaven), the house cusps, and the
 * timed predictive techniques that move the angles (transits/progressions TO the
 * angles) — are therefore unreliable for them. Rectification is the traditional
 * practice of NARROWING an unknown birth time by checking which candidate time
 * best "fits" known, dated life events.
 *
 * This endpoint is a HEURISTIC AID, not a determination of the true birth time.
 * It scans candidate times across a window the user supplies, scores each by how
 * well the user's dated life events line up with TIME-DEPENDENT techniques, and
 * returns a RANKED list with per-candidate rationale and a single best estimate.
 * A professional rectification weighs far more (multiple house systems, primary
 * directions, the native's physical appearance, prior events, the practitioner's
 * judgement). We are explicit about this in the response (`disclaimer`) and in
 * the app UI. Treat the output as a shortlist to investigate, never as truth.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SCORING HEURISTIC (deterministic, time-only signal)
 * ──────────────────────────────────────────────────────────────────────────
 * Only the birth TIME is being varied — date and place are fixed — so we score
 * purely on what the time changes. Across the window we take candidate times at
 * `stepMinutes` and, for each candidate, compute the natal ANGLES (Asc + MC) and
 * then, for each life event, the BEST (smallest-orb) aspect a slow-moving but
 * angle-relevant predictive contact makes to those angles near the event date:
 *
 *   - SECONDARY-PROGRESSED angles: the progressed Asc/MC for the event date,
 *     checked for a major aspect to the NATAL Sun/Moon/angles (the progressed
 *     MC/Asc crossing a luminary or angle is a classic timing signature). The
 *     progressed angles move ~1°/day of life ⇒ minutes of birth time shift them
 *     materially, which is exactly the signal rectification exploits.
 *   - TRANSITS of the slow bodies (Jupiter…Pluto, plus the Nodes) to the natal
 *     Asc/MC at the event date. Slow transits to an angle are tightly dated and,
 *     because the angle itself moves with the birth time, are diagnostic of it.
 *
 * Each event contributes a score in [0,1] = a smooth orb-decay (1 at exact,
 * 0 at the max orb) of its single best contact, multiplied by the event's
 * `weight` (default 1). The candidate's score is the weighted mean across
 * events, scaled to 0..100. Ties break toward the candidate CLOSEST to the
 * window midpoint (no information ⇒ prefer the user's stated centre).
 *
 * This makes the scorer:
 *   - DETERMINISTIC: same input ⇒ same ranking.
 *   - MONOTONIC in the obvious case: a candidate whose angles are exactly hit by
 *     an event's contact scores strictly higher than one whose angles are far
 *     off for the same event.
 *   - BOUNDED: candidate count and event count are both capped (below), so the
 *     scan is O(candidates × events) with a hard ceiling.
 *
 * ACCURACY NOTE (Moshier): the default backend is Moshier (no `.se1` files), so
 * outer-planet/Chiron precision is ephemeris-limited (arc-seconds–arc-minutes).
 * That is far finer than the rectification orbs (degrees), so it does not affect
 * the ranking; tests use generous tolerances accordingly.
 */
import type { BirthData, PlanetName } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { angularSeparation, ASPECT_ANGLES, computeBody, BODIES, computeHouses } from './astro.js';
import { localToJulianDay, dateTimeToJulianDay } from './time.js';
import { getBackend } from './ephemeris.js';

/** Mean tropical year in days (mirrors progressions.ts). */
const TROPICAL_YEAR_DAYS = 365.242189;

/** Hard caps so the scan is always bounded. */
export const MAX_CANDIDATES = 288; // e.g. a full 24h window at 5-minute steps.
export const MAX_EVENTS = 40;
/** Smallest sensible scan step (minutes); finer would be below the signal. */
export const MIN_STEP_MINUTES = 1;
export const DEFAULT_STEP_MINUTES = 10;

/** Contact orb (degrees) within which an event "hits" an angle. Beyond this the
 *  event contributes 0. Wide enough to be forgiving (rectification is fuzzy),
 *  narrow enough that the smooth decay still discriminates between candidates. */
export const CONTACT_ORB_DEG = 2;

/** Aspect angles we count as a "hit" to an angle (the five majors). */
const MAJOR_ANGLES = Object.values(ASPECT_ANGLES);

/** Slow transiting bodies whose contacts to an angle are tightly dated. */
const SLOW_TRANSIT_BODIES: PlanetName[] = [
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
  'Pluto',
  'NorthNode',
];

/** Natal points a progressed/transiting angle contact is scored against. */
const TARGET_NATAL_BODIES: PlanetName[] = ['Sun', 'Moon'];

export interface RectifyEvent {
  /** `yyyy-mm-dd` date the life event occurred. */
  date: string;
  /** Free-text kind (e.g. "moved home", "career change"); echoed back. */
  kind: string;
  /** Relative importance multiplier (default 1). */
  weight?: number;
}

export interface RectifyWindow {
  /** Earliest candidate birth time `HH:mm` (24h). */
  earliest: string;
  /** Latest candidate birth time `HH:mm` (24h). Must be > earliest (no wrap). */
  latest: string;
}

export interface RectifyRequest {
  /** Approximate birth data. Place + date are fixed; the TIME is what we scan. */
  birth: BirthData;
  window: RectifyWindow;
  stepMinutes?: number;
  events: RectifyEvent[];
}

/** Per-event explanation of why a candidate scored as it did. */
export interface CandidateEventHit {
  date: string;
  kind: string;
  /** The strongest contact found for this event at this candidate time. */
  technique: 'progressed-angle' | 'transit-to-angle' | null;
  /** Human description, e.g. "progressed MC trine natal Sun". */
  description: string;
  /** Orb of the best contact, degrees (lower = tighter). null if no contact. */
  orbDeg: number | null;
  /** This event's contribution to the candidate score, 0..1 (pre-weight). */
  fit: number;
}

export interface RectifyCandidate {
  /** Candidate birth time `HH:mm`. */
  time: string;
  /** Candidate score, 0..100 (higher = better event fit). */
  score: number;
  /** Natal Ascendant longitude at this candidate time (degrees). */
  ascendant: number;
  /** Natal Midheaven longitude at this candidate time (degrees). */
  midheaven: number;
  /** One short sentence summarising why this time ranked where it did. */
  rationale: string;
  /** Per-event detail behind the score. */
  hits: CandidateEventHit[];
}

export interface RectifyResponse {
  /** Candidates ranked best-first. */
  candidates: RectifyCandidate[];
  /** The top-ranked candidate (convenience), or null when no ranking is possible. */
  best: RectifyCandidate | null;
  scan: {
    earliest: string;
    latest: string;
    stepMinutes: number;
    candidateCount: number;
    eventCount: number;
    contactOrbDeg: number;
    ephemerisBackend: 'swiss' | 'moshier';
  };
  /** Honest, user-facing caveat. Always present. */
  disclaimer: string;
  /** When events is empty: no ranking is possible; this explains why. */
  message?: string;
}

const DISCLAIMER =
  'Rectification is an informed estimate, not a certainty. This tool scans candidate ' +
  'birth times and ranks them by how well your dated life events line up with ' +
  'time-sensitive techniques (the chart angles and slow predictive contacts to them). ' +
  'It is an aid to narrow the field, treat the top candidates as a shortlist to ' +
  'investigate with a professional, never as your confirmed birth time.';

/** Parse `HH:mm` to minutes-since-midnight, or throw. */
function hhmmToMinutes(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:mm 24h).`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Format minutes-since-midnight back to `HH:mm`. */
function minutesToHhmm(mins: number): string {
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Generate the candidate times (minutes-since-midnight) across `[earliest,
 * latest]` inclusive at `step`. Window WRAP is not allowed (latest must be after
 * earliest). The count is capped at {@link MAX_CANDIDATES}; if the window+step
 * would exceed the cap we throw (the schema also rejects this, but we guard here
 * so the function is safe standalone).
 */
export function generateCandidates(earliest: string, latest: string, step: number): number[] {
  const lo = hhmmToMinutes(earliest);
  const hi = hhmmToMinutes(latest);
  if (hi <= lo) {
    throw new Error('Invalid window: `latest` must be after `earliest` (no overnight wrap).');
  }
  if (step < MIN_STEP_MINUTES) {
    throw new Error(`stepMinutes must be >= ${MIN_STEP_MINUTES}.`);
  }
  const out: number[] = [];
  for (let m = lo; m <= hi; m += step) {
    out.push(m);
    if (out.length > MAX_CANDIDATES) {
      throw new Error(
        `Window + step yields more than ${MAX_CANDIDATES} candidates; widen the step or narrow the window.`,
      );
    }
  }
  return out;
}

/** Smooth orb decay: 1 at exact, linearly to 0 at `maxOrb`, clamped. */
function orbFit(orbDeg: number, maxOrb: number): number {
  if (orbDeg >= maxOrb) return 0;
  return 1 - orbDeg / maxOrb;
}

/** Best (smallest) orb of any major aspect between two longitudes, or null. */
function bestAngleOrb(lonA: number, lonB: number, maxOrb: number): number | null {
  let best: number | null = null;
  for (const angle of MAJOR_ANGLES) {
    const sep = angularSeparation(lonA, lonB);
    const orb = Math.abs(sep - angle);
    if (orb <= maxOrb && (best === null || orb < best)) best = orb;
  }
  return best;
}

/** Aspect name for a separation→angle, for the rationale text. */
function aspectNameFor(lonA: number, lonB: number): string {
  const sep = angularSeparation(lonA, lonB);
  let bestName = 'aspect';
  let bestOrb = Infinity;
  const names: Record<number, string> = {
    [ASPECT_ANGLES.conjunction]: 'conjunct',
    [ASPECT_ANGLES.sextile]: 'sextile',
    [ASPECT_ANGLES.square]: 'square',
    [ASPECT_ANGLES.trine]: 'trine',
    [ASPECT_ANGLES.opposition]: 'opposition',
  };
  for (const angle of MAJOR_ANGLES) {
    const orb = Math.abs(sep - angle);
    if (orb < bestOrb) {
      bestOrb = orb;
      bestName = names[angle] ?? 'aspect';
    }
  }
  return bestName;
}

/** A natal angle pair (Asc/MC) computed for one candidate time. */
interface CandidateAngles {
  ascendant: number;
  midheaven: number;
}

/**
 * Resolve the JD (UT) + UTC ISO for a candidate birth time on the birth
 * date/place. Both come from the same `localToJulianDay` authority so the
 * progressed-angle span and the natal angles agree.
 */
function candidateInstant(birth: BirthData, hhmm: string): { jdUt: number; utc: string } {
  const r = localToJulianDay(birth.date, hhmm, birth.tzIana);
  return { jdUt: r.jdUt, utc: r.utc };
}

/**
 * Score one event against a candidate's natal angles + birth instant. Returns
 * the single STRONGEST contact (progressed-angle or transit-to-angle) and its
 * fit in [0,1]. We take the best of the two techniques so each event votes once.
 */
function scoreEvent(
  birth: BirthData,
  candidate: { jdUt: number; utc: string },
  angles: CandidateAngles,
  natalLuminaries: { name: PlanetName; lon: number }[],
  event: RectifyEvent,
): CandidateEventHit {
  const target = DateTime.fromISO(event.date, { zone: 'utc' });
  if (!target.isValid) {
    return {
      date: event.date,
      kind: event.kind,
      technique: null,
      description: 'invalid date',
      orbDeg: null,
      fit: 0,
    };
  }

  let bestFit = 0;
  let bestOrb: number | null = null;
  let bestTechnique: CandidateEventHit['technique'] = null;
  let bestDescription = 'no time-sensitive contact within orb';

  // ---- Technique 1: secondary-progressed angles to natal luminaries. ----
  // Day-for-a-year: advance the birth instant by ageYears DAYS, recompute the
  // angles for that progressed instant at the birth place. The age span uses the
  // candidate's resolved UTC instant so a different candidate TIME shifts the
  // progressed angles (the signal rectification exploits).
  const birthInstant = DateTime.fromISO(candidate.utc, { zone: 'utc' });
  const elapsedDays = birthInstant.isValid ? target.diff(birthInstant, 'days').days : NaN;
  const ageYears = elapsedDays / TROPICAL_YEAR_DAYS;
  if (Number.isFinite(ageYears) && ageYears > 0) {
    const jdProgressed = candidate.jdUt + ageYears; // 1 JD = 1 day
    try {
      const ph = computeHouses(jdProgressed, birth.lat, birth.lon, birth.houseSystem);
      for (const progAngle of [
        { label: 'progressed MC', lon: ph.midheaven },
        { label: 'progressed Ascendant', lon: ph.ascendant },
      ]) {
        for (const lum of natalLuminaries) {
          const orb = bestAngleOrb(progAngle.lon, lum.lon, CONTACT_ORB_DEG);
          if (orb === null) continue;
          const fit = orbFit(orb, CONTACT_ORB_DEG);
          if (fit > bestFit) {
            bestFit = fit;
            bestOrb = orb;
            bestTechnique = 'progressed-angle';
            bestDescription = `${progAngle.label} ${aspectNameFor(
              progAngle.lon,
              lum.lon,
            )} natal ${lum.name}`;
          }
        }
      }
    } catch {
      // High-latitude degenerate houses etc. — skip this technique for the event.
    }
  }

  // ---- Technique 2: slow transits to the natal angles at the event date. ----
  const jdEvent = dateTimeToJulianDay(target);
  for (const bodyName of SLOW_TRANSIT_BODIES) {
    const body = BODIES.find((b) => b.name === bodyName);
    if (!body) continue;
    let lonT: number;
    try {
      lonT = computeBody(jdEvent, body.id, body.name).absoluteDegree;
    } catch {
      continue; // body unavailable under the active backend
    }
    for (const ang of [
      { label: 'Ascendant', lon: angles.ascendant },
      { label: 'Midheaven', lon: angles.midheaven },
    ]) {
      const orb = bestAngleOrb(lonT, ang.lon, CONTACT_ORB_DEG);
      if (orb === null) continue;
      const fit = orbFit(orb, CONTACT_ORB_DEG);
      if (fit > bestFit) {
        bestFit = fit;
        bestOrb = orb;
        bestTechnique = 'transit-to-angle';
        bestDescription = `transiting ${bodyName} ${aspectNameFor(lonT, ang.lon)} natal ${ang.label}`;
      }
    }
  }

  return {
    date: event.date,
    kind: event.kind,
    technique: bestTechnique,
    description: bestDescription,
    orbDeg: bestOrb,
    fit: bestFit,
  };
}

/**
 * Run the rectification scan. Pure compute over the (validated) request.
 *
 * For each candidate time we compute the natal angles once and the natal
 * luminary longitudes (these barely move within a day, so we read them at the
 * candidate instant), then score every event and combine into a weighted-mean
 * score. Candidates are returned ranked best-first, ties broken toward the
 * window midpoint.
 */
export function computeRectification(req: RectifyRequest): RectifyResponse {
  const step = req.stepMinutes ?? DEFAULT_STEP_MINUTES;

  const scanBase = {
    earliest: req.window.earliest,
    latest: req.window.latest,
    stepMinutes: step,
    contactOrbDeg: CONTACT_ORB_DEG,
    ephemerisBackend: getBackend(),
  };

  // No events ⇒ no signal ⇒ no ranking. Return an honest message.
  if (req.events.length === 0) {
    return {
      candidates: [],
      best: null,
      scan: { ...scanBase, candidateCount: 0, eventCount: 0 },
      disclaimer: DISCLAIMER,
      message:
        'Add at least one dated life event. Rectification works by checking which ' +
        'candidate birth time best fits your real, dated events, with none, there is ' +
        'nothing to rank against.',
    };
  }

  const candidateMins = generateCandidates(req.window.earliest, req.window.latest, step);
  const midpoint = (hhmmToMinutes(req.window.earliest) + hhmmToMinutes(req.window.latest)) / 2;
  const weightSum = req.events.reduce((s, e) => s + (e.weight ?? 1), 0) || 1;

  const candidates: RectifyCandidate[] = candidateMins.map((mins) => {
    const hhmm = minutesToHhmm(mins);
    const candidate = candidateInstant(req.birth, hhmm);

    // Natal angles at this candidate time.
    let ascendant = 0;
    let midheaven = 0;
    try {
      const h = computeHouses(candidate.jdUt, req.birth.lat, req.birth.lon, req.birth.houseSystem);
      ascendant = h.ascendant;
      midheaven = h.midheaven;
    } catch {
      // Degenerate houses (polar) — angles unusable; leave at 0 (scores ~0).
    }

    // Natal luminaries at the candidate instant (used by the progressed-angle
    // technique). Fast enough that minute-level shifts don't matter; computed
    // once per candidate.
    const natalLuminaries = TARGET_NATAL_BODIES.map((name) => {
      const body = BODIES.find((b) => b.name === name);
      const lon = body ? computeBody(candidate.jdUt, body.id, body.name).absoluteDegree : 0;
      return { name, lon };
    });

    const hits = req.events.map((event) =>
      scoreEvent(req.birth, candidate, { ascendant, midheaven }, natalLuminaries, event),
    );

    const weighted =
      hits.reduce((s, hit, i) => s + hit.fit * (req.events[i]?.weight ?? 1), 0) / weightSum;
    const score = Math.round(weighted * 1000) / 10; // 0..100, one decimal.

    const fitting = hits.filter((h) => h.technique !== null);
    const rationale =
      fitting.length === 0
        ? 'No time-sensitive event contacts within orb at this time.'
        : `${fitting.length}/${hits.length} events fit; strongest: ${
            [...fitting].sort((a, b) => (a.orbDeg ?? 99) - (b.orbDeg ?? 99))[0]?.description
          }.`;

    return { time: hhmm, score, ascendant, midheaven, rationale, hits };
  });

  // Rank best-first; tie-break toward the window midpoint.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = Math.abs(hhmmToMinutes(a.time) - midpoint);
    const db = Math.abs(hhmmToMinutes(b.time) - midpoint);
    return da - db;
  });

  return {
    candidates,
    best: candidates[0] ?? null,
    scan: {
      ...scanBase,
      candidateCount: candidates.length,
      eventCount: req.events.length,
    },
    disclaimer: DISCLAIMER,
  };
}
