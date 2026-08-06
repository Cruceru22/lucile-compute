/**
 * Life Almanac — a deterministic personal life-transit timeline engine.
 *
 * Given a computed natal chart and a birth date, this assembles the
 * "timeline-worthy" events of a life from birth to ~5 years past `now`. It is
 * fully DETERMINISTIC: no LLM, no randomness. Two families of events are
 * produced:
 *
 *   1. RETURNS & CYCLE PHASES — universal developmental milestones where a slow
 *      planet aspects its OWN natal longitude (Saturn return + the quarter
 *      cycle, Jupiter return, Chiron return, nodal return, the Uranus
 *      mid/quarter-life cycle, etc.). These are framed as `kind: 'return'`
 *      (conjunctions to self) or `kind: 'cycle'` (the square/opposition phases).
 *
 *   2. PERSONALIZED OUTER-PLANET HITS — transiting Saturn/Uranus/Neptune/Pluto/
 *      Chiron making a hard (conj/opp/square) or soft (trine/sextile) aspect to
 *      a personal natal point (Sun, Moon, Asc, MC, Mercury, Venus, Mars).
 *      `kind: 'transit'`.
 *
 * Slow transits typically perfect THREE times (direct → retrograde → direct)
 * within ~1-2 years; we GROUP those passes into a single banded event with
 * `passes`, `startDate`, `endDate` and a peak `exactDate`. Each event carries a
 * significance score (0..100) + tier, the age at exactitude (computed, never
 * hardcoded), past/active flags, and a non-fatalist developmental
 * `question` + `body` paragraph derived from deterministic templates.
 */
import type { NatalChart, PlanetName, AspectType } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { BODIES, computeBody, norm360 } from './astro.js';
import { dateTimeToJulianDay, julianDayToIso } from './time.js';

export interface LifeAlmanacResult {
  birthDate: string;
  generatedAt: string;
  events: AlmanacEvent[];
}

export interface AlmanacEvent {
  id: string;
  kind: 'return' | 'cycle' | 'transit';
  /** e.g. "Saturn Return", "Pluto square Sun". */
  title: string;
  transiting: PlanetName;
  /** The natal point aspected, e.g. "Saturn" (own position) or "Sun"/"Ascendant". */
  natalPoint: string;
  aspect: string;
  startDate: string;
  exactDate: string;
  endDate: string;
  ageAtExact: number;
  passes: number;
  significance: number;
  tier: 1 | 2 | 3;
  isPast: boolean;
  isActive: boolean;
  question: string;
  body: string;
}

/** Years past `now` we extend the timeline to (look-ahead horizon). */
const LOOKAHEAD_YEARS = 5;

/** Slow transiting planets that drive life-transits. Fast bodies are noise here. */
const SLOW_BODIES: PlanetName[] = ['Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron'];

/**
 * Cyclic/return bodies for the "universal milestone" pass. Each is checked
 * against its OWN natal longitude.
 */
const CYCLE_BODIES: PlanetName[] = ['Saturn', 'Jupiter', 'Uranus', 'Chiron', 'NorthNode'];

/** Personal natal points eligible as targets for personalized hits. */
const PERSONAL_POINTS: PlanetName[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars'];

/** Hard aspects (the spine of life-transit work). */
const HARD: AspectType[] = ['conjunction', 'opposition', 'square'];
/** Soft aspects (lower rank, supportive). */
const SOFT: AspectType[] = ['trine', 'sextile'];

/** Coarse sampling step (days) for slow planets — keeps the 95y sweep tractable. */
const SLOW_STEP_DAYS = 5;

/** Passes of the same (planet, point, aspect) within this many days group into one band. */
const BAND_DAYS = 18 * 30; // ~18 months

// --- Significance weights (per research) ---

const PLANET_WEIGHT: Partial<Record<PlanetName, number>> = {
  Pluto: 1.0,
  Saturn: 0.95,
  Neptune: 0.85,
  Uranus: 0.85,
  Chiron: 0.85,
  Jupiter: 0.6,
  NorthNode: 0.6,
};

const ASPECT_WEIGHT: Record<AspectType, number> = {
  conjunction: 1.0,
  opposition: 0.9,
  square: 0.85,
  trine: 0.6,
  sextile: 0.45,
};

/** Weight of a natal target point (for personalized hits + cycle targets). */
function targetWeight(point: string): number {
  switch (point) {
    case 'Sun':
    case 'Moon':
      return 1.0;
    case 'Ascendant':
    case 'MC':
      return 0.9;
    case 'Saturn':
      return 0.85;
    case 'Venus':
    case 'Mars':
    case 'Mercury':
      return 0.7;
    default:
      // Other own-position targets (Jupiter, Uranus, Chiron, NorthNode returns):
      // mid weight; the milestone FLOOR carries them regardless.
      return 0.8;
  }
}

/** Floor significance for universal milestones (returns, the big cycle hits). */
const MILESTONE_FLOOR = 85;

/** Map an AspectType to its exact separation angle (degrees). */
const ANGLE: Record<AspectType, number> = {
  conjunction: 0,
  sextile: 60,
  square: 90,
  trine: 120,
  opposition: 180,
};

/** A natal "point" we can aspect: a name + an absolute ecliptic longitude. */
interface NatalPoint {
  name: string;
  lon: number;
}

/**
 * Gather the natal points used as TARGETS for personalized hits: the personal
 * planets always, plus Ascendant + MC only when the chart is timed (houses
 * available).
 */
function personalTargets(natal: NatalChart): NatalPoint[] {
  const byName = new Map(natal.planets.map((p) => [p.name, p]));
  const timed = natal.housesAvailable !== false;
  const pts: NatalPoint[] = [];
  for (const name of PERSONAL_POINTS) {
    // For an UNTIMED chart the Moon sits at a noon fallback (±~6.5° of error),
    // so a transit timed to that Moon would look precise but be WRONG — a
    // personalized life event ("Pluto square your Moon, 2027") off by months to
    // years. Drop the Moon as a target for untimed charts, exactly as we drop
    // the (time-dependent) Ascendant and MC below. The Moon stays a target only
    // when the birth time is known.
    if (name === 'Moon' && !timed) continue;
    const p = byName.get(name);
    if (p) pts.push({ name, lon: p.absoluteDegree });
  }
  if (timed && typeof natal.ascendant === 'number') {
    pts.push({ name: 'Ascendant', lon: natal.ascendant });
  }
  if (timed && typeof natal.midheaven === 'number') {
    pts.push({ name: 'MC', lon: natal.midheaven });
  }
  return pts;
}

/** A raw exact pass before banding. */
interface RawPass {
  transiting: PlanetName;
  natalPoint: string;
  aspect: AspectType;
  exactIso: string;
}

/** sweph body id for a transiting planet name. */
const BODY_ID = new Map(BODIES.map((b) => [b.name, b.id]));

/** Absolute ecliptic longitude of a transiting body at a Julian Day. */
function lonAt(jdUt: number, name: PlanetName): number {
  const id = BODY_ID.get(name);
  if (id === undefined) throw new Error(`no body id for ${name}`);
  return computeBody(jdUt, id, name).absoluteDegree;
}

/**
 * Signed angular distance of the transiting body from an aspect target,
 * wrapped to (-180, 180]. This is `δ(t) = wrap180( lonTransit − lonNatal −
 * offset )`. Crucially — unlike absolute-separation deviation — δ crosses
 * ZERO (changes sign) as the body passes the target, so conjunctions (offset
 * 0) and oppositions (offset 180) are detected as cleanly as squares/trines.
 */
function signedDelta(lonTransit: number, lonNatal: number, offset: number): number {
  let d = norm360(lonTransit - lonNatal - offset);
  if (d > 180) d -= 360;
  return d;
}

/**
 * The longitude offsets that realise an aspect. An aspect of angle `a` is exact
 * when the body leads OR trails the natal point by `a`, so we look for crossings
 * at `+a` and `−a` (the latter only when distinct, i.e. not 0/180).
 */
function offsetsFor(aspect: AspectType): number[] {
  const a = ANGLE[aspect];
  if (a === 0 || a === 180) return [a];
  return [a, 360 - a];
}

/**
 * Refine the exact JD where `signedDelta` crosses zero between two samples via
 * bisection (to < 1 minute).
 */
function refine(
  jdLo: number,
  jdHi: number,
  name: PlanetName,
  natalLon: number,
  offset: number,
): number {
  let lo = jdLo;
  let hi = jdHi;
  let fLo = signedDelta(lonAt(lo, name), natalLon, offset);
  for (let i = 0; i < 50; i++) {
    if (hi - lo < 1 / 1440) break;
    const mid = (lo + hi) / 2;
    const fMid = signedDelta(lonAt(mid, name), natalLon, offset);
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Find every exact pass of `transiting` to natal longitude `natalLon` for the
 * given aspects across [jdFrom, jdTo], by sampling `signedDelta` on a coarse
 * grid and bisecting each sign change. Robust for conj/opp because δ is signed.
 */
function findPasses(
  transiting: PlanetName,
  natalLon: number,
  aspects: AspectType[],
  jdFrom: number,
  jdTo: number,
): { aspect: AspectType; jd: number }[] {
  const out: { aspect: AspectType; jd: number }[] = [];
  for (const aspect of aspects) {
    for (const offset of offsetsFor(aspect)) {
      let jdPrev = jdFrom;
      let fPrev = signedDelta(lonAt(jdPrev, transiting), natalLon, offset);
      for (let jd = jdFrom + SLOW_STEP_DAYS; jd <= jdTo + 1e-9; jd += SLOW_STEP_DAYS) {
        const jdCur = Math.min(jd, jdTo);
        const fCur = signedDelta(lonAt(jdCur, transiting), natalLon, offset);
        // A sign change with a SHORT span means a true crossing (not the ±180
        // wrap discontinuity, which only appears for a stationary-far body).
        if (fPrev !== 0 && Math.sign(fCur) !== Math.sign(fPrev) && Math.abs(fCur - fPrev) < 180) {
          const jdExact = refine(jdPrev, jdCur, transiting, natalLon, offset);
          out.push({ aspect, jd: jdExact });
        }
        jdPrev = jdCur;
        fPrev = fCur;
      }
    }
  }
  return out;
}

/**
 * Skip transiting bodies the active backend cannot compute (e.g. Chiron under
 * the Moshier fallback, which lacks the asteroid ephemeris files). Probe once.
 */
function computable(name: PlanetName, jdProbe: number): boolean {
  try {
    lonAt(jdProbe, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Personalized outer-planet passes: each slow body against each personal target
 * point, for the given aspect set.
 */
function personalPasses(
  targets: NatalPoint[],
  transitingBodies: PlanetName[],
  aspects: AspectType[],
  jdFrom: number,
  jdTo: number,
): RawPass[] {
  const out: RawPass[] = [];
  for (const body of transitingBodies) {
    if (!computable(body, jdFrom)) continue;
    for (const target of targets) {
      for (const hit of findPasses(body, target.lon, aspects, jdFrom, jdTo)) {
        out.push({
          transiting: body,
          natalPoint: target.name,
          aspect: hit.aspect,
          exactIso: julianDayToIso(hit.jd),
        });
      }
    }
  }
  return out;
}

/**
 * Returns + cycle phases: each cycle body checked ONLY against its OWN natal
 * longitude. Conjunction = return; square/opposition = cycle phases. The Node,
 * Jupiter and Chiron carry only their conjunction (return).
 */
function cyclePasses(natal: NatalChart, jdFrom: number, jdTo: number): RawPass[] {
  const byName = new Map(natal.planets.map((p) => [p.name, p]));
  const out: RawPass[] = [];
  // A slow body sits ON its natal degree at birth; for the first months it may
  // retrograde back across that exact point. That is the natal position, NOT a
  // return/cycle phase — so ignore self-aspect passes inside this guard window.
  // The earliest genuine milestone (a Jupiter return) is ~12y, and the earliest
  // square (Saturn waxing) ~7y, so a 3-year guard is safely below all of them.
  const minJd = jdFrom + 3 * 365.25;
  for (const body of CYCLE_BODIES) {
    const self = byName.get(body);
    if (!self || !computable(body, jdFrom)) continue;
    const aspects: AspectType[] =
      body === 'NorthNode' || body === 'Jupiter' || body === 'Chiron'
        ? ['conjunction']
        : ['conjunction', 'square', 'opposition'];
    for (const hit of findPasses(body, self.absoluteDegree, aspects, jdFrom, jdTo)) {
      if (hit.jd < minJd) continue;
      out.push({
        transiting: body,
        natalPoint: body,
        aspect: hit.aspect,
        exactIso: julianDayToIso(hit.jd),
      });
    }
  }
  return out;
}

/** A banded group of passes that perfect within ~18 months. */
interface Band {
  transiting: PlanetName;
  natalPoint: string;
  aspect: AspectType;
  exactIsos: string[]; // sorted ascending
}

/**
 * Group raw passes sharing (transiting, natalPoint, aspect) into bands where
 * consecutive exact passes fall within {@link BAND_DAYS}. A slow transit's
 * direct→retro→direct triple thus collapses into one event with passes=3.
 */
function bandPasses(passes: RawPass[]): Band[] {
  const byKey = new Map<string, RawPass[]>();
  for (const p of passes) {
    const key = `${p.transiting}|${p.natalPoint}|${p.aspect}`;
    const arr = byKey.get(key);
    if (arr) arr.push(p);
    else byKey.set(key, [p]);
  }
  const bands: Band[] = [];
  for (const [key, arr] of byKey) {
    arr.sort((a, b) => a.exactIso.localeCompare(b.exactIso));
    const [transiting, natalPoint, aspect] = key.split('|') as [PlanetName, string, AspectType];
    let current: string[] = [];
    let lastMs = -Infinity;
    for (const p of arr) {
      const ms = Date.parse(p.exactIso);
      if (current.length === 0 || ms - lastMs <= BAND_DAYS * 86_400_000) {
        current.push(p.exactIso);
      } else {
        bands.push({ transiting, natalPoint, aspect, exactIsos: current });
        current = [p.exactIso];
      }
      lastMs = ms;
    }
    if (current.length > 0) bands.push({ transiting, natalPoint, aspect, exactIsos: current });
  }
  return bands;
}

/** Whole-year-aware age in years (decimal) at `whenIso` relative to `birthIso`. */
function ageAt(birthIso: string, whenIso: string): number {
  const birth = DateTime.fromISO(birthIso, { zone: 'utc' });
  const when = DateTime.fromISO(whenIso, { zone: 'utc' });
  const years = when.diff(birth, 'years').years;
  return Math.round(years * 100) / 100;
}

/** Tier from a 0..100 significance score. */
function tierFor(score: number): 1 | 2 | 3 {
  if (score >= 80) return 1;
  if (score >= 60) return 2;
  return 3;
}

/** Whether this band is a universal milestone deserving the significance floor. */
function isMilestone(
  kind: AlmanacEvent['kind'],
  transiting: PlanetName,
  natalPoint: string,
): boolean {
  if (kind === 'return') return true; // any return-to-self conjunction
  if (kind === 'cycle' && transiting === natalPoint) return true; // Saturn/Uranus self-cycle phases
  return false;
}

/** Compute significance 0..100 (with milestone floor) for a band. */
function significanceFor(
  kind: AlmanacEvent['kind'],
  transiting: PlanetName,
  natalPoint: string,
  aspect: AspectType,
): number {
  const pw = PLANET_WEIGHT[transiting] ?? 0.7;
  const tw = targetWeight(natalPoint);
  const aw = ASPECT_WEIGHT[aspect];
  let score = pw * tw * aw * 100;
  if (isMilestone(kind, transiting, natalPoint)) {
    score = Math.max(score, MILESTONE_FLOOR);
  }
  return Math.round(Math.min(100, score));
}

// --- Non-fatalist developmental templates (deterministic) ---

interface Frame {
  theme: string;
  question: string;
  /** Body text intro keyed to the transiting planet's developmental theme. */
  lens: string;
}

function frameFor(transiting: PlanetName): Frame {
  switch (transiting) {
    case 'Saturn':
      return {
        theme: 'commitment and structure',
        question:
          'What in your life is ready to become real, to be tested, pruned, and built to last?',
        lens: 'Saturn asks what deserves your commitment. This is a season of maturing structure: the loose gets tightened, the unearned falls away, and what you actually build now tends to hold.',
      };
    case 'Uranus':
      return {
        theme: 'freedom and awakening',
        question:
          'What wants to break open here, where is your life asking for more authenticity and room to move?',
        lens: 'Uranus is the freedom question. Expect restlessness and sudden clarity about what no longer fits. The invitation is to update an outgrown arrangement on your own terms rather than have it jolt you.',
      };
    case 'Neptune':
      return {
        theme: 'meaning and dissolution',
        question:
          'What are you being asked to release, and where is the fog actually lifting toward something truer?',
        lens: 'Neptune is the meaning question. Edges soften; certainties loosen. It can feel disorienting, but it is also where imagination, compassion, and a more spiritual sense of purpose can come back online.',
      };
    case 'Pluto':
      return {
        theme: 'power and transformation',
        question: 'What is ready to end so that something truer in you can finally live?',
        lens: 'Pluto is the power question. This is deep, slow transformation: an old version of a part of your life composts so a more honest one can grow. You are not losing control, you are renegotiating it.',
      };
    case 'Chiron':
      return {
        theme: 'the wound and its healing',
        question:
          'What old tender place is asking to be tended, and where could your own healing become a gift to others?',
        lens: 'Chiron touches a long-standing sore spot, not to reopen it but to let it be cared for. Working with it tends to turn vulnerability into a kind of competence you can offer others.',
      };
    case 'Jupiter':
      return {
        theme: 'growth and opportunity',
        question: 'Where is the door open right now, what would you grow into if you said yes?',
        lens: 'Jupiter widens the field. This is a window for growth, perspective, and saying yes to the larger version of a plan, while keeping it honest rather than overextended.',
      };
    case 'NorthNode':
      return {
        theme: 'direction and destiny-pull',
        question:
          'Which way is your life quietly leaning, and what would it take to walk toward it on purpose?',
        lens: 'The North Node marks a directional pull. Something in your path is being underlined; following it usually feels both slightly unfamiliar and oddly right.',
      };
    default:
      return {
        theme: 'change',
        question: 'What is this season asking you to grow into?',
        lens: 'A meaningful developmental window opens here.',
      };
  }
}

/** Human label for the natal point (own-position returns read naturally). */
function pointLabel(natalPoint: string): string {
  return natalPoint;
}

/**
 * Build the title for a band. Returns/cycles get named milestones; personalized
 * hits read "Pluto square Sun".
 */
function titleFor(
  kind: AlmanacEvent['kind'],
  transiting: PlanetName,
  natalPoint: string,
  aspect: AspectType,
): string {
  if (kind === 'return') {
    if (transiting === 'NorthNode') return 'Nodal Return';
    return `${transiting} Return`;
  }
  if (kind === 'cycle') {
    // e.g. "Saturn Square Saturn (cycle phase)", "Uranus Opposition (mid-life)".
    if (transiting === 'Uranus' && aspect === 'opposition') return 'Uranus Opposition (mid-life)';
    const a = aspect === 'opposition' ? 'Opposition' : 'Square';
    return `${transiting} ${a} ${transiting}`;
  }
  return `${transiting} ${aspect} ${pointLabel(natalPoint)}`;
}

/**
 * Half-width (in DAYS) of the "active now" orb window around an event's exact
 * date, by transiting body. A single-pass transit has `startDate===endDate===
 * exactDate`, so the naive `now>=start && now<=end` test is a zero-width band
 * that can NEVER be active (true only at the exact millisecond) — so a transit
 * exact TODAY would still read "a quiet stretch", and the journal "what you wrote
 * then" match would be zero-width too. Instead we treat an event as active while
 * the transiting body is within orb of exactitude. These spans approximate how
 * long each (slow) body stays within a ~1° applying/separating orb around the
 * hit: the outer/slower the planet, the wider the window; faster movers (the
 * Node, Jupiter) get tighter windows.
 */
const ORB_DAYS: Partial<Record<PlanetName, number>> = {
  Pluto: 120, // ~4 months either side — Pluto crawls
  Neptune: 90,
  Uranus: 75,
  Saturn: 45,
  Chiron: 45,
  Jupiter: 14,
  NorthNode: 14,
};
/** Fallback half-window for any body without an explicit span above. */
const DEFAULT_ORB_DAYS = 30;

/** Half-width (ms) of the active-orb window for a transiting body. */
function orbWindowMs(transiting: PlanetName): number {
  return (ORB_DAYS[transiting] ?? DEFAULT_ORB_DAYS) * 86_400_000;
}

/** A short, always-bounded body paragraph that names the bodies + aspect + window. */
function bodyFor(
  kind: AlmanacEvent['kind'],
  transiting: PlanetName,
  natalPoint: string,
  aspect: AspectType,
  startDate: string,
  endDate: string,
  passes: number,
): string {
  const frame = frameFor(transiting);
  const startY = startDate.slice(0, 4);
  const endY = endDate.slice(0, 4);
  const window = startY === endY ? `during ${startY}` : `across ${startY}–${endY}`;
  const aspectPhrase =
    kind === 'transit'
      ? `Transiting ${transiting} ${aspect} your natal ${natalPoint}`
      : kind === 'return'
        ? `${transiting} returns to its own natal place`
        : `${transiting} ${aspect}s its own natal place`;
  const passNote =
    passes >= 2
      ? ` It perfects ${passes} times as the planet stations and turns, so it arrives in waves rather than all at once`
      : '';
  return (
    `${aspectPhrase} ${window}. ${frame.lens}` +
    `${passNote}. Treat it as weather, not fate: it is a real window with a clear end, and how it lands depends on the choices you make inside it, there are no predictions here, only an invitation.`
  );
}

/** Deterministic stable id for an event. */
function idFor(
  transiting: PlanetName,
  natalPoint: string,
  aspect: AspectType,
  exactIso: string,
): string {
  return `${transiting}-${aspect}-${natalPoint}-${exactIso.slice(0, 10)}`.toLowerCase();
}

/**
 * Build the full Life Almanac timeline.
 *
 * @param natal    The person's computed natal chart.
 * @param birthIso ISO birth datetime (or date) — used for age computation and
 *                 as the timeline start.
 * @param nowIso   "Now" — the timeline extends to `now` + {@link LOOKAHEAD_YEARS}
 *                 years, and drives the isPast/isActive flags.
 */
export function buildLifeAlmanac(
  natal: NatalChart,
  birthIso: string,
  nowIso: string,
): LifeAlmanacResult {
  const birth = DateTime.fromISO(birthIso, { zone: 'utc' });
  const now = DateTime.fromISO(nowIso, { zone: 'utc' });
  if (!birth.isValid || !now.isValid) {
    throw new Error('Invalid birthIso/nowIso supplied to buildLifeAlmanac.');
  }
  // Single sweep across [birth, now + LOOKAHEAD] in Julian Days.
  const jdFrom = dateTimeToJulianDay(birth);
  const jdTo = dateTimeToJulianDay(now.plus({ years: LOOKAHEAD_YEARS }));

  // 1. Returns + cycle phases (universal milestones).
  const cycleRaw = cyclePasses(natal, jdFrom, jdTo);

  // 2. Personalized outer-planet hits (hard + soft) to personal points.
  const targets = personalTargets(natal);
  const personalRaw = [
    ...personalPasses(targets, SLOW_BODIES, HARD, jdFrom, jdTo),
    ...personalPasses(targets, SLOW_BODIES, SOFT, jdFrom, jdTo),
  ];

  const events: AlmanacEvent[] = [];

  // Band + materialize cycle/return events.
  for (const band of bandPasses(cycleRaw)) {
    events.push(materialize(band, 'cycleish', natal, birthIso, now));
  }
  // Band + materialize personalized transits.
  for (const band of bandPasses(personalRaw)) {
    events.push(materialize(band, 'transit', natal, birthIso, now));
  }

  events.sort((a, b) => a.exactDate.localeCompare(b.exactDate));
  return {
    birthDate: birthIso,
    generatedAt: nowIso,
    events,
  };
}

/**
 * Turn a band into a finished AlmanacEvent. `forcedKind` is 'transit' for
 * personalized hits, or 'cycleish' for the universal pass (resolved here to
 * 'return' for conjunctions-to-self and 'cycle' for square/opposition-to-self).
 */
function materialize(
  band: Band,
  forcedKind: 'transit' | 'cycleish',
  _natal: NatalChart,
  birthIso: string,
  now: DateTime,
): AlmanacEvent {
  const passes = band.exactIsos.length;
  const startDate = band.exactIsos[0]!;
  const endDate = band.exactIsos[passes - 1]!;
  // Peak = middle pass (the triple's retrograde perfection is the deepest).
  const exactDate = band.exactIsos[Math.floor((passes - 1) / 2)]!;

  let kind: AlmanacEvent['kind'];
  if (forcedKind === 'transit') {
    kind = 'transit';
  } else {
    kind = band.aspect === 'conjunction' ? 'return' : 'cycle';
  }

  const significance = significanceFor(kind, band.transiting, band.natalPoint, band.aspect);
  const tier = tierFor(significance);
  const ageAtExact = ageAt(birthIso, exactDate);

  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  const nowMs = now.toMillis();
  // ORB-BASED active window. The DURATION BAND [startDate, endDate] visual is
  // kept for multi-pass events (the direct→retro→direct triple), but `isActive`
  // — and the band used for journal matching — is computed from an orb window so
  // a single-pass event (zero-width band) can still light up when it's exact
  // today. We widen the band by the body's orb half-window on each side; for a
  // single hit this becomes exactDate ± orb, for a triple it's the whole span ±
  // orb so the in-between separations are covered too.
  const exactMs = Date.parse(exactDate);
  const orbMs = orbWindowMs(band.transiting);
  const activeStartMs = Math.min(startMs, exactMs) - orbMs;
  const activeEndMs = Math.max(endMs, exactMs) + orbMs;
  const isActive = nowMs >= activeStartMs && nowMs <= activeEndMs;
  // Past once `now` has cleared the active (orb) window — so an event mid-orb is
  // ACTIVE, not PAST (keeps past/active mutually exclusive).
  const isPast = activeEndMs < nowMs;

  const frame = frameFor(band.transiting);

  return {
    id: idFor(band.transiting, band.natalPoint, band.aspect, exactDate),
    kind,
    title: titleFor(kind, band.transiting, band.natalPoint, band.aspect),
    transiting: band.transiting,
    natalPoint: band.natalPoint,
    aspect: band.aspect,
    startDate,
    exactDate,
    endDate,
    ageAtExact,
    passes,
    significance,
    tier,
    isPast,
    isActive,
    question: frame.question,
    body: bodyFor(kind, band.transiting, band.natalPoint, band.aspect, startDate, endDate, passes),
  };
}
