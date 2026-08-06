/**
 * Deterministic synastry compatibility scorer.
 *
 * Turns the raw cross-chart aspects from {@link computeSynastry} into a
 * human-readable compatibility read: an overall 0..100 score with a qualitative
 * band, an activity level, per-domain sub-scores, and the top harmonious /
 * frictional contacts with plain, grounded one-liners.
 *
 * Everything here is PURE and DETERMINISTIC — no LLM, no network, no clock. The
 * same aspects always produce the same result, so it is instant and free.
 *
 * The scoring model is grounded in synastry research (planet importance, aspect
 * magnitude, harmony vs. friction polarity, orb decay). Two deliberate
 * departures from folk methods, both because astrological compatibility should
 * REWARD CONNECTION rather than punish it:
 *
 *  1. Friction PENALISES LESS than harmony rewards (a hard aspect is real but
 *     also generative — it creates attraction, magnetism, growth, not just
 *     problems). We discount friction to ~0.47× of harmony's weight.
 *  2. A CHEMISTRY BONUS: contacts between "bond" pairs (Sun↔Moon, Venus↔Mars,
 *     Moon↔Venus, …) lift the score REGARDLESS of aspect polarity — a Venus
 *     square Mars is still chemistry. Scaled by orb tightness + planet weight.
 *
 * And we do NOT regress everything to the mean by dividing the signal away by
 * sqrt(n): a "live" synastry (many tight, significant contacts) should land
 * HIGHER, not get averaged back to 50. See {@link squash} for the calibration.
 */
import type { AspectType, PlanetName } from '@astroapp/shared';
import type { SynastryAspect } from './synastry.js';

/* -------------------------------------------------------------------------- */
/* Public result shapes                                                       */
/* -------------------------------------------------------------------------- */

export type CompatibilityBand = 'rare' | 'strong' | 'workable' | 'growthy' | 'difficult';
export type CompatibilityActivity = 'quiet' | 'moderate' | 'intense';
export type DomainKey = 'romantic' | 'emotional' | 'communication' | 'values' | 'longterm';

export interface CompatAspect {
  a: PlanetName;
  b: PlanetName;
  type: AspectType;
  orb: number;
  /** Average importance weight of the two bodies, `0.4..1.0`. */
  weight: number;
  /** Deterministic, grounded one-line description. */
  text: string;
}

export interface CompatibilityDomain {
  key: DomainKey;
  label: string;
  /** 0..100 sub-score, or `null` when the domain has no qualifying contacts. */
  score: number | null;
  summary: string;
}

export interface CompatibilityResult {
  score: number;
  band: CompatibilityBand;
  bandLabel: string;
  activity: CompatibilityActivity;
  timeLimited: boolean;
  excludedFactors?: string[];
  domains: CompatibilityDomain[];
  harmonies: CompatAspect[];
  frictions: CompatAspect[];
  aspectCount: number;
  /**
   * Optional AI-generated "bigger picture" paragraph synthesising the top
   * harmonies + frictions + band into one grounded human reading. Added by the
   * `/compatibility` endpoint AFTER deterministic scoring; absent if the AI call
   * is unavailable (the deterministic result is never blocked on it).
   */
  synthesis?: string;
}

/* -------------------------------------------------------------------------- */
/* Model constants (transparent, from research)                               */
/* -------------------------------------------------------------------------- */

/** Planet importance weight. Unlisted bodies (asteroids, nodes, etc.) → 0.4. */
const PLANET_WEIGHT: Partial<Record<PlanetName, number>> = {
  Sun: 1.0,
  Moon: 1.0,
  Venus: 0.8,
  Mars: 0.8,
  Mercury: 0.8,
  Jupiter: 0.6,
  Saturn: 0.6,
};
const DEFAULT_PLANET_WEIGHT = 0.4;

function weightOf(p: PlanetName): number {
  return PLANET_WEIGHT[p] ?? DEFAULT_PLANET_WEIGHT;
}

/** Aspect magnitude — how loud the contact is, regardless of harmony. */
const ASPECT_MAGNITUDE: Record<AspectType, number> = {
  conjunction: 1.0,
  opposition: 0.9,
  square: 0.8,
  trine: 0.7,
  sextile: 0.5,
};

/** Maximum orb (degrees) by the WIDER (more important) planet of the pair. */
function maxOrbFor(a: PlanetName, b: PlanetName): number {
  const orbOf = (p: PlanetName): number => {
    if (p === 'Sun' || p === 'Moon') return 10;
    if (p === 'Venus' || p === 'Mars' || p === 'Mercury') return 7;
    if (p === 'Jupiter' || p === 'Saturn') return 6;
    return 4; // outers, asteroids, nodes
  };
  return Math.max(orbOf(a), orbOf(b));
}

/**
 * A conjunction is harmonious by default, but a few "hard pairs" make it
 * frictional: Mars+Saturn, Mars+Pluto, or Saturn with a Sun/Moon/Venus.
 */
function isHardConjunction(a: PlanetName, b: PlanetName): boolean {
  const pair = new Set<PlanetName>([a, b]);
  const has = (x: PlanetName, y: PlanetName): boolean => pair.has(x) && pair.has(y);
  if (has('Mars', 'Saturn')) return true;
  if (has('Mars', 'Pluto')) return true;
  if (pair.has('Saturn') && (pair.has('Sun') || pair.has('Moon') || pair.has('Venus'))) {
    return true;
  }
  return false;
}

/**
 * "Bond" pairs — the contacts that make two charts feel like a couple. A
 * contact between any of these pairs adds a CHEMISTRY bonus to the score no
 * matter the aspect's polarity: a Venus square Mars is friction *and* chemistry;
 * the pull is real either way. Unordered.
 */
const BOND_PAIRS: ReadonlyArray<readonly [PlanetName, PlanetName]> = [
  ['Sun', 'Moon'],
  ['Venus', 'Mars'],
  ['Moon', 'Venus'],
  ['Moon', 'Moon'],
  ['Sun', 'Venus'],
  ['Sun', 'Sun'],
  ['Mercury', 'Mercury'],
];

function isBondPair(a: PlanetName, b: PlanetName): boolean {
  return BOND_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** Polarity: +1 harmony, −1 friction. */
function polarityOf(a: PlanetName, b: PlanetName, type: AspectType): 1 | -1 {
  switch (type) {
    case 'trine':
    case 'sextile':
      return 1;
    case 'square':
    case 'opposition':
      return -1;
    case 'conjunction':
      return isHardConjunction(a, b) ? -1 : 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Per-aspect scoring                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Friction is real but generative — discount its weight relative to harmony so
 * a rich, mixed synastry isn't dragged down to neutral by its hard aspects.
 * 0.47 ≈ "a square costs about half of what an equally-tight trine earns."
 */
const FRICTION_WEIGHT = 0.47;

/**
 * Chemistry bonus per qualifying bond-pair contact, applied on top of the
 * signed contribution. Polarity-blind: a Venus–Mars square still magnetises.
 * Tuned (with {@link squash}'s gains) so a couple with two or three tight bond
 * contacts gets a clear, but not runaway, lift.
 */
const CHEMISTRY_GAIN = 0.55;

interface ScoredAspect {
  a: PlanetName;
  b: PlanetName;
  type: AspectType;
  orb: number;
  weight: number;
  orbDecay: number;
  /**
   * Signed POLARITY contribution after the friction discount: positive =
   * harmony, negative = (discounted) friction. Drives the harmony/friction
   * split and the top-lists.
   */
  contribution: number;
  /** Polarity-blind chemistry lift (>= 0); non-zero only for bond pairs. */
  chemistry: number;
}

function scoreAspect(asp: SynastryAspect): ScoredAspect {
  const wA = weightOf(asp.a);
  const wB = weightOf(asp.b);
  const avgWeight = (wA + wB) / 2;
  const maxOrb = maxOrbFor(asp.a, asp.b);
  const orbDecay = Math.max(0, 1 - asp.orb / maxOrb);
  const polarity = polarityOf(asp.a, asp.b, asp.type);
  const magnitude = ASPECT_MAGNITUDE[asp.type];
  // Harmony at full strength; friction discounted — hard aspects hurt less than
  // soft aspects help.
  const polarityScale = polarity > 0 ? 1 : FRICTION_WEIGHT;
  const contribution = polarity * polarityScale * magnitude * avgWeight * orbDecay;
  // Chemistry is polarity-blind: any aspect between a bond pair magnetises.
  const chemistry = isBondPair(asp.a, asp.b)
    ? CHEMISTRY_GAIN * magnitude * avgWeight * orbDecay
    : 0;
  return {
    a: asp.a,
    b: asp.b,
    type: asp.type,
    orb: asp.orb,
    weight: avgWeight,
    orbDecay,
    contribution,
    chemistry,
  };
}

/* -------------------------------------------------------------------------- */
/* Squash / calibration                                                       */
/* -------------------------------------------------------------------------- */

/** A scored set's aggregate signal, split for transparency. */
interface Signal {
  harmony: number;
  friction: number; // already discounted (FRICTION_WEIGHT), reported positive
  chemistry: number;
}

function aggregate(scored: ScoredAspect[]): Signal {
  let harmony = 0;
  let friction = 0;
  let chemistry = 0;
  for (const s of scored) {
    if (s.contribution >= 0) harmony += s.contribution;
    else friction += -s.contribution;
    chemistry += s.chemistry;
  }
  return { harmony, friction, chemistry };
}

/**
 * Map an aggregate {harmony, friction, chemistry} signal to a 0..100 score.
 *
 * Philosophy: REWARD CONNECTION. A "live" synastry — many tight, significant
 * contacts — should land high, not regress to 50. So we do NOT divide the
 * signal away by sqrt(n). Instead:
 *
 *   warmth = harmony + chemistry − friction        (friction already discounted)
 *   score  = BASE + SPAN * tanh(warmth / SCALE)
 *
 *  - BASE = 62 recenters the neutral point well above the old 50: an average,
 *    decently-connected couple should *feel* good, not lukewarm.
 *  - tanh saturates gently, so adding more warm contacts keeps lifting the score
 *    (density rewarded) without ever hitting a fake 100.
 *  - A LIVENESS floor pulls a sparse/contact-less pairing down toward the low
 *    50s/40s (an empty synastry isn't a warm 62 — there's simply nothing there);
 *    it ramps in only when total contact is tiny, so it never touches a real,
 *    busy chart.
 *  - SPAN = 38 and the POS/NEG scales (5.5 / 3.2) are tuned so the targets land:
 *
 * Worked example (all tight, both times known) — a real loving couple:
 *   Sun–Moon trine     : harmony 1.0·0.7·1.0·~0.95 ≈ 0.67, chem 0.55·… ≈ 0.37
 *   Venus–Mars trine    : harmony 0.7·0.8·~0.94      ≈ 0.53, chem        ≈ 0.29
 *   Moon–Venus sextile  : harmony 0.5·0.9·~0.93      ≈ 0.42, chem        ≈ 0.23
 *   Venus–Mars square   : friction 0.47·0.8·0.8·~0.9 ≈ 0.27, chem        ≈ 0.32
 *   Sun–Saturn square   : friction 0.47·0.8·0.8·~0.9 ≈ 0.27, chem         0
 *     harmony ≈ 1.62, chemistry ≈ 1.21, friction ≈ 0.54
 *     warmth  ≈ 1.62 + 1.21 − 0.54 = 2.29
 *     score   ≈ 62 + 38·tanh(2.29 / 5.5) ≈ 62 + 38·0.395 ≈ 77  → 'strong'
 *   (add one more warm bond contact and it clears ~82.)
 *
 * A Mars–Saturn / Saturn-on-luminary hostile chart drives warmth strongly
 * negative (little/no chemistry to offset) → low 40s / high 30s → 'growthy'/
 * 'difficult'. A contact-less or sparse pairing sits near BASE-ish but with tiny
 * warmth, landing mid-50s — and crucially BELOW an otherwise-identical pairing
 * that has a Venus–Mars square (whose chemistry lifts it).
 *
 * Clamped to [38, 97] — never a fake 100, never a cruel 0.
 */
const SCORE_BASE = 62;
const SCORE_SPAN = 38;
/**
 * Asymmetric saturation. Positive warmth saturates GENTLY (a generous reward
 * curve — many warm contacts keep lifting the score). Negative warmth saturates
 * a bit FASTER, so a genuinely hostile chart can still reach the 'difficult'
 * band even after friction has been discounted — otherwise the discount would
 * make <45 unreachable.
 */
const SCORE_SCALE_POS = 5.5;
const SCORE_SCALE_NEG = 3.2;
const SCORE_MIN = 38;
const SCORE_MAX = 97;

/**
 * When a pairing has almost no contact at all, it isn't a warm BASE — there's
 * nothing to be warm about. `liveness` ramps 0→1 over the first ~1.2 units of
 * total (unsigned) contact; below that, the score is pulled toward
 * {@link SPARSE_FLOOR}. A normal busy chart has total ≫ 1.2 → liveness = 1 →
 * no effect.
 */
const SPARSE_FLOOR = 50;
const LIVENESS_SCALE = 1.2;

function squash(sig: Signal): number {
  const warmth = sig.harmony + sig.chemistry - sig.friction;
  const scale = warmth >= 0 ? SCORE_SCALE_POS : SCORE_SCALE_NEG;
  const raw = SCORE_BASE + SCORE_SPAN * Math.tanh(warmth / scale);
  const total = sig.harmony + sig.friction + sig.chemistry;
  const liveness = Math.min(1, total / LIVENESS_SCALE);
  const lifted = SPARSE_FLOOR + (raw - SPARSE_FLOOR) * liveness;
  return Math.round(Math.max(SCORE_MIN, Math.min(SCORE_MAX, lifted)));
}

/** Score an arbitrary scored set (whole chart or one domain) with one curve. */
function scoreOf(scored: ScoredAspect[]): number {
  return squash(aggregate(scored));
}

/* -------------------------------------------------------------------------- */
/* Bands                                                                      */
/* -------------------------------------------------------------------------- */

const BAND_LABELS: Record<CompatibilityBand, string> = {
  rare: 'A rare resonance',
  strong: 'Strong harmony, with edges to work on',
  workable: 'Workable, with real differences',
  growthy: 'Growth-heavy, more friction than ease',
  difficult: 'Difficult, a lot to navigate',
};

function bandFor(score: number): CompatibilityBand {
  // Shifted up to match the recalibrated, more generous distribution.
  if (score >= 87) return 'rare';
  if (score >= 72) return 'strong';
  if (score >= 58) return 'workable';
  if (score >= 45) return 'growthy';
  return 'difficult';
}

/* -------------------------------------------------------------------------- */
/* Grounded text                                                              */
/* -------------------------------------------------------------------------- */

/** One-word role of each body, used to build plain, non-fatalist sentences. */
const ROLE: Partial<Record<PlanetName, string>> = {
  Sun: 'identity',
  Moon: 'emotional safety',
  Venus: 'affection and values',
  Mars: 'drive and chemistry',
  Mercury: 'communication',
  Jupiter: 'growth',
  Saturn: 'commitment and limits',
};

function roleOf(p: PlanetName): string {
  return ROLE[p] ?? p;
}

const ASPECT_VERB: Record<AspectType, string> = {
  conjunction: 'conjunct',
  sextile: 'sextile',
  square: 'square',
  trine: 'trine',
  opposition: 'opposite',
};

/**
 * Aspect "family" for copy purposes. Conjunctions read with their resolved
 * polarity (a Mars–Saturn conjunction is hard); soft/hard otherwise.
 */
type AspectFamily = 'soft' | 'hard';

function familyOf(s: ScoredAspect): AspectFamily {
  return s.contribution >= 0 ? 'soft' : 'hard';
}

/**
 * Pair-and-family specific copy. Each line has two beats: the DYNAMIC, then how
 * it concretely shows up in daily life. Keyed by the unordered planet pair so
 * order doesn't matter; we look up the canonical key in {@link pairKey}. Plain,
 * specific, names the bodies, never fatalist.
 */
const PAIR_TEXT: Record<string, Record<AspectFamily, string>> = {
  'Sun|Moon': {
    soft: 'Who you are and what they need fit together, being yourself is what makes them feel safe. Day to day, you settle each other rather than set each other off.',
    hard: 'Your sense of self and their emotional needs pull in different directions, what feels natural to you can unsettle them. It asks you to read the room and check in, not just assume.',
  },
  'Venus|Mars': {
    soft: 'Desire and affection move in sync, you reach for each other without second-guessing. Attraction stays easy and mutual, in bed and in the small daily gestures.',
    hard: 'Strong pull with friction, attraction runs hot but timing and tempo clash. One of you wants to chase while the other wants to be courted; naming the mismatch keeps the heat from turning into sulking.',
  },
  'Moon|Venus': {
    soft: 'Tenderness comes naturally, care and affection speak the same language here. You comfort each other in the way each actually wants to be comforted.',
    hard: 'You love and you soothe, but not always in the same currency, one reaches for closeness while the other reaches for a gift or a fix. Spelling out what "feeling loved" means avoids quiet disappointment.',
  },
  'Moon|Moon': {
    soft: 'Your emotional rhythms match, you tend to need quiet and closeness at the same moments. Home feels instinctive; you rarely have to explain a mood.',
    hard: 'You feel things at different tempos, one recharges in company while the other needs to withdraw. Giving each other room without reading it as rejection is the daily work.',
  },
  'Sun|Venus': {
    soft: 'You simply enjoy each other, warmth and appreciation flow without effort. Compliments land, affection is easy, and being together feels pleasant rather than loaded.',
    hard: 'You light each other up but tastes and values can scrape, what one finds charming the other finds much. A little generosity about each other’s style keeps fondness from souring.',
  },
  'Sun|Sun': {
    soft: 'Your core selves point the same way, you back each other’s direction instead of competing for it. Shared purpose comes easily; you feel like teammates.',
    hard: 'Two strong wills, two different paths, you each want to lead from your own centre. It’s vitalising when you channel it together and draining when it becomes a contest.',
  },
  'Mercury|Mercury': {
    soft: 'You think and talk on the same wavelength, conversation flows and you finish each other’s thoughts. Plans and logistics sort themselves out with little friction.',
    hard: 'You process and explain things differently, one is fast and blunt, the other careful, and wires cross. Slowing down to actually hear each other turns the static into real exchange.',
  },
  'Sun|Mars': {
    soft: 'There’s drive and spark between you, you energise each other’s ambitions. You make a motivating, get-up-and-go pair.',
    hard: 'Lots of energy, easily lit, passion and irritation share a fuse. Channel it into doing things together rather than at each other.',
  },
  'Moon|Mars': {
    soft: 'Feelings and action align, they move to protect what you need, and it lands. You feel looked after and spurred on at once.',
    hard: 'Heat meets sensitivity, one’s bluntness can bruise the other’s mood fast. Softening the delivery, not the honesty, keeps small sparks from becoming rows.',
  },
  'Venus|Venus': {
    soft: 'You value and enjoy the same things, beauty, pleasure and affection look alike to you both. Date nights and small luxuries are effortless common ground.',
    hard: 'You both love deeply but want different things from love, different tastes, different love-languages. Curiosity about each other’s style beats trying to convert it.',
  },
  'Venus|Saturn': {
    soft: 'Affection here has staying power, you take each other seriously and build something durable. Commitment feels like safety, not a cage.',
    hard: 'Love and duty tangle, one of you can feel held back or held to account in matters of affection. Naming the fear of not-enough turns coldness back into care.',
  },
  'Moon|Saturn': {
    soft: 'You offer each other steady ground, feelings are met with reliability. It’s the comfort of someone who actually shows up.',
    hard: 'Warmth meets restraint, one needs reassurance the other finds hard to voice, and it can read as distance. Small, deliberate gestures of care close the gap.',
  },
  'Sun|Saturn': {
    soft: 'You lend each other backbone, respect and responsibility run both ways. You help each other grow up well.',
    hard: 'One can feel judged or reined in by the other, authority and identity rub. Letting support feel like support, not correction, is the work.',
  },
  'Moon|Mercury': {
    soft: 'Heart and head connect, you can put feelings into words with each other. Talking things through actually helps rather than escalates.',
    hard: 'One leads with feeling, the other with logic, and each can feel unheard. Pausing to name the emotion before debating the point keeps talks from going cold.',
  },
  'Mercury|Venus': {
    soft: 'Talking and affection blend, sweet words come easily and land well. You flirt and smooth things over with the same ease.',
    hard: 'You express warmth in different keys, one through words, one through tone, and signals get missed. Saying the kind thing out loud, plainly, helps.',
  },
};

/** Canonical, order-independent key for the pair table. */
function pairKey(a: PlanetName, b: PlanetName): string {
  return [a, b].sort().join('|');
}

/**
 * A grounded two-beat line for a contact. Prefers the pair-and-family specific
 * copy; falls back to a role-based sentence (still names both bodies and the
 * aspect) for pairs not in the table. Never fatalist.
 */
function aspectText(s: ScoredAspect): string {
  const specific = PAIR_TEXT[pairKey(s.a, s.b)]?.[familyOf(s)];
  if (specific) return specific;

  // Role-based fallback — still specific to the bodies and the aspect family.
  const head = `Your ${s.a} ${ASPECT_VERB[s.type]} their ${s.b}`;
  const ra = roleOf(s.a);
  const rb = roleOf(s.b);
  if (familyOf(s) === 'soft') {
    return `${head}, ${ra} meets ${rb} with ease, so this part of the bond tends to flow on its own.`;
  }
  return `${head}, ${ra} and ${rb} pull against each other here, so it rewards a bit of awareness and timing rather than running on autopilot.`;
}

function toCompatAspect(s: ScoredAspect): CompatAspect {
  return {
    a: s.a,
    b: s.b,
    type: s.type,
    orb: s.orb,
    weight: Number(s.weight.toFixed(3)),
    text: aspectText(s),
  };
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                    */
/* -------------------------------------------------------------------------- */

const DOMAIN_LABELS: Record<DomainKey, string> = {
  romantic: 'Romance & chemistry',
  emotional: 'Emotional connection',
  communication: 'Communication',
  values: 'Shared values',
  longterm: 'Long-term & commitment',
};

/** Does an unordered planet pair match one of the given {x, y} pairs? */
function matchesPair(
  a: PlanetName,
  b: PlanetName,
  pairs: ReadonlyArray<[PlanetName, PlanetName]>,
): boolean {
  return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

const DOMAIN_PAIRS: Record<DomainKey, ReadonlyArray<[PlanetName, PlanetName]>> = {
  romantic: [
    ['Venus', 'Mars'],
    ['Sun', 'Moon'],
    ['Venus', 'Sun'],
    ['Mars', 'Moon'],
  ],
  emotional: [
    ['Moon', 'Moon'],
    ['Moon', 'Venus'],
    ['Moon', 'Sun'],
  ],
  communication: [
    ['Mercury', 'Mercury'],
    ['Mercury', 'Moon'],
    ['Mercury', 'Venus'],
  ],
  values: [
    ['Venus', 'Jupiter'],
    ['Venus', 'Venus'],
    ['Sun', 'Jupiter'],
  ],
  longterm: [
    ['Saturn', 'Sun'],
    ['Saturn', 'Moon'],
    ['Saturn', 'Venus'],
    ['Saturn', 'Saturn'],
  ],
};

/** What a domain measures, in plain words — used to give the summary meaning. */
const DOMAIN_GIST: Record<DomainKey, string> = {
  romantic: 'how attraction and chemistry actually flow between you',
  emotional: 'how safe and understood you feel with each other',
  communication: 'how easily you talk, think, and sort things out',
  values: 'how much you enjoy and want the same things',
  longterm: 'how solid and committed this feels over time',
};

/**
 * A specific, non-boilerplate domain summary: names the strongest driving
 * contact, says whether it eases or stretches the domain, and ties it to what
 * the domain measures.
 */
function domainSummary(key: DomainKey, inDomain: ScoredAspect[]): string {
  const ranked = [...inDomain].sort(
    (x, y) => Math.abs(y.contribution) + y.chemistry - (Math.abs(x.contribution) + x.chemistry),
  );
  const top = ranked[0];
  // `domainFor` only calls this with a non-empty list, but keep a typed guard.
  if (!top) return 'No strong contacts here.';
  const driver = `${top.a} ${ASPECT_VERB[top.type]} ${top.b}`;
  const gist = DOMAIN_GIST[key];
  const softCount = inDomain.filter((s) => familyOf(s) === 'soft').length;
  const hardCount = inDomain.length - softCount;
  if (familyOf(top) === 'soft') {
    const extra = hardCount > 0 ? ', with a little to work through too' : '';
    return `${driver} carries ${gist}, and it leans easy${extra}.`;
  }
  const extra = softCount > 0 ? ', though there’s warmth to lean on' : '';
  return `${driver} shapes ${gist}, and it asks for effort here${extra}.`;
}

function domainFor(key: DomainKey, scored: ScoredAspect[]): CompatibilityDomain {
  const pairs = DOMAIN_PAIRS[key];
  const inDomain = scored.filter((s) => matchesPair(s.a, s.b, pairs));
  const label = DOMAIN_LABELS[key];
  if (inDomain.length === 0) {
    return { key, label, score: null, summary: 'No strong contacts here.' };
  }
  // Same recalibrated curve as the overall score — sub-scores aren't stuck low.
  const score = scoreOf(inDomain);
  const summary = domainSummary(key, inDomain);
  return { key, label, score, summary };
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

function activityFor(scored: ScoredAspect[]): CompatibilityActivity {
  const strong = scored.filter((s) => s.orbDecay > 0.5 && s.weight >= 0.8).length;
  if (strong >= 5) return 'intense';
  if (strong >= 2) return 'moderate';
  return 'quiet';
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function scoreCompatibility(
  aspects: SynastryAspect[],
  opts: { timeKnownA: boolean; timeKnownB: boolean },
): CompatibilityResult {
  const timeLimited = !opts.timeKnownA || !opts.timeKnownB;

  // Unknown time makes only THAT side's Moon unreliable (the Moon moves ~13°/day,
  // so its sign/degree depends on the birth time). Filter PER SIDE: drop an aspect
  // touching side A's Moon only when A's time is unknown, and side B's Moon only
  // when B's time is unknown. Dropping BOTH charts' Moon aspects when only one side
  // lacks a time needlessly discards the known side's perfectly reliable Moon
  // contacts. In a SynastryAspect, `a` is side A's body and `b` is side B's body.
  // (Houses/angles aren't present in these aspects anyway, but we name them for the
  // client's disclaimer.)
  const usable = aspects.filter(
    (asp) => !(asp.a === 'Moon' && !opts.timeKnownA) && !(asp.b === 'Moon' && !opts.timeKnownB),
  );

  const scored = usable.map(scoreAspect);

  const score = scoreOf(scored);
  const band = bandFor(score);

  // Top harmonies / frictions, each sorted by |contribution| desc, top 4.
  const harmonies = scored
    .filter((s) => s.contribution > 0)
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
    .slice(0, 4)
    .map(toCompatAspect);
  const frictions = scored
    .filter((s) => s.contribution < 0)
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
    .slice(0, 4)
    .map(toCompatAspect);

  const domains: CompatibilityDomain[] = (
    ['romantic', 'emotional', 'communication', 'values', 'longterm'] as DomainKey[]
  ).map((key) => domainFor(key, scored));

  const result: CompatibilityResult = {
    score,
    band,
    bandLabel: BAND_LABELS[band],
    activity: activityFor(scored),
    timeLimited,
    domains,
    harmonies,
    frictions,
    aspectCount: scored.length,
  };
  if (timeLimited) {
    result.excludedFactors = ['the Moon', 'houses', 'angles'];
  }
  return result;
}
