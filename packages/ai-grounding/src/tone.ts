/**
 * Tone-safety guard (TASK D7) — keeps grounded AI astrology SUPPORTIVE and
 * NON-DETERMINISTIC without weakening the anti-hallucination grounding in
 * `index.ts`. The complaint this addresses: fatalistic / fear-mongering /
 * "fixed fate" output ("you are doomed to fail", "nothing you can do",
 * "you will definitely get sick").
 *
 * Everything here is PURE and dependency-free (no `@astroapp/shared` import, no
 * Deno globals), so it can be:
 *   - imported by the canonical package (`index.ts` re-exports it), and
 *   - mirrored BYTE-FOR-BYTE into the Deno Edge Function
 *     (`supabase/functions/ai-interpret/_shared/tone-safety.ts`) with a drift
 *     test, exactly like the chart-fact core.
 *
 * Three exports:
 *   1. `TONE_SAFETY_DIRECTIVE` — appended to the system prompt. Tells the model
 *      to frame placements/transits as tendencies & opportunities, emphasise
 *      agency, and never assert death/doom/medical/financial certainties — while
 *      keeping chart FACTS accurate.
 *   2. `scanTone(text)` — a CONSERVATIVE detector. It flags only phrasing that is
 *      unambiguously fatalistic/deterministic/fear-mongering. Ordinary astrology
 *      ("this transit can bring tension", "you may feel…") MUST pass. Low false
 *      positives is the explicit design goal.
 *   3. `softenTone(text)` — a deterministic rewriter that neutralises the worst
 *      offenders (injects hedges / agency) while PRESERVING the underlying
 *      factual claim. Pure and idempotent.
 *
 * IMPORTANT ordering contract (see interpreter.ts): chart-fact validation runs
 * FIRST, tone softening runs on the FINAL text AFTER it. Softening only rewrites
 * MODAL / fatalistic framing words ("will definitely" → "may"), never planet /
 * sign / house / aspect / retrograde tokens, so it cannot reintroduce a
 * hallucinated chart fact.
 */

/* -------------------------------------------------------------------------- */
/* 1. System-prompt directive                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Directive injected into the system prompt. Kept as a single string so the
 * Edge Function can splice it into the existing prompt array with ONE line.
 * It steers tone WITHOUT touching the anti-hallucination factual rules.
 */
export const TONE_SAFETY_DIRECTIVE: string = [
  'TONE & SAFETY (these shape HOW you write, they never change the chart FACTS,',
  'which remain governed by the anti-hallucination rules and the ground truth):',
  '- Be supportive and empowering. Frame placements, transits, and aspects as',
  '  tendencies, themes, and OPPORTUNITIES, not as fixed fate or guaranteed',
  '  outcomes.',
  '- Astrology describes potentials, not certainties. Prefer "can", "may",',
  '  "tends to", "this is an invitation to" over "will definitely", "is destined',
  '  to", "you are doomed to".',
  "- Emphasise the person's AGENCY and choices. The chart is a map, not a verdict;",
  '  the reader always has room to respond, grow, and decide.',
  '- NEVER predict death, doom, disaster, or irreversible ruin. NEVER state medical',
  '  diagnoses/outcomes or financial certainties (e.g. "you will get sick", "you',
  '  will go bankrupt"). Encourage consulting qualified professionals for medical,',
  '  legal, or financial questions.',
  '- Avoid fear-mongering and absolute determinism ("nothing you can do", "there is',
  '  no escape", "it is inevitable"). Acknowledge challenge honestly, but pair it',
  '  with constructive, agency-forward framing.',
  '- Keep all of this WITHOUT diluting factual accuracy about the chart: the signs,',
  '  houses, aspects, and retrograde states you cite must still be exactly correct.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* 2. scanTone — conservative fatalism / determinism / fear detector          */
/* -------------------------------------------------------------------------- */

/** A category of tone problem, for logging / targeted handling. */
export type ToneIssueKind =
  | 'determinism' // "you will definitely", "destined to", "it is inevitable"
  | 'doom' // "you are doomed", "destined to fail", "your life will be ruined"
  | 'no-agency' // "nothing you can do", "there is no escape", "powerless to change"
  | 'medical' // "you will get sick", "you will develop <disease>"
  | 'financial'; // "you will go bankrupt", "you will definitely lose all your money"

/** One flagged span of fatalistic / deterministic / fear phrasing. */
export interface ToneIssue {
  kind: ToneIssueKind;
  /** The exact matched substring (for logging / tests). */
  match: string;
  /** Index of the match within the scanned text. */
  index: number;
}

/** Result of {@link scanTone}. `ok` is true when no issue was flagged. */
export interface ToneScanResult {
  issues: ToneIssue[];
  ok: boolean;
}

/**
 * Each rule is a deliberately NARROW regex targeting phrasing that is
 * fatalistic/deterministic regardless of surrounding context. We avoid bare
 * words ("death", "fail", "loss", "definitely") because they appear constantly
 * in legitimate, hedged astrology ("a sense of loss", "Saturn asks you to face
 * the fear of failure"). Instead we require the DETERMINISTIC FRAME — a
 * second-person subject bound to an absolute future/verdict — so normal hedged
 * prose does not trip.
 *
 * Design principle: prefer a MISS (let a borderline phrase through) over a
 * FALSE POSITIVE (flagging ordinary astrology). The directive + softenTone are
 * the belt; this scanner is suspenders for the egregious cases.
 */
interface ToneRule {
  kind: ToneIssueKind;
  re: RegExp;
}

// "you/your <…> will (definitely/certainly/surely/inevitably) …" — absolute
// future framing aimed at the reader. The adverb is what makes it deterministic;
// plain "you will feel calmer" is fine and is NOT matched.
const DETERMINISM_RULES: ToneRule[] = [
  {
    kind: 'determinism',
    re: /\byou\s+(?:will|are\s+going\s+to)\s+(?:definitely|certainly|surely|inevitably|undoubtedly|for\s+sure)\b/gi,
  },
  // "(you/this) is/are destined to", "fated to", "doomed to" + verb.
  {
    kind: 'determinism',
    re: /\b(?:you\s+are|you're|this\s+is|it\s+is|it's)\s+(?:destined|fated|predestined|doomed)\s+to\b/gi,
  },
  // "it is inevitable that you", "your <…> is inevitable / unavoidable / set in stone".
  {
    kind: 'determinism',
    re: /\b(?:is|are|will\s+be)\s+(?:inevitable|unavoidable|set\s+in\s+stone|written\s+in\s+the\s+stars\s+with\s+no)\b/gi,
  },
];

const DOOM_RULES: ToneRule[] = [
  // "you are doomed", "you're doomed".
  { kind: 'doom', re: /\byou(?:\s+are|'re)\s+doomed\b/gi },
  // "destined/fated/doomed to fail|fall|lose|suffer|be alone|ruin".
  {
    kind: 'doom',
    re: /\b(?:destined|fated|doomed)\s+to\s+(?:fail|fall|lose|suffer|be\s+alone|be\s+ruined|ruin)\b/gi,
  },
  // "your life will be ruined/destroyed/over", "your future is hopeless".
  {
    kind: 'doom',
    re: /\byour\s+(?:life|future|marriage|career|relationship)\s+(?:will\s+be|is)\s+(?:ruined|destroyed|over|hopeless|finished)\b/gi,
  },
];

const NO_AGENCY_RULES: ToneRule[] = [
  // "(there is) nothing you can do", "nothing you can do about it".
  { kind: 'no-agency', re: /\b(?:there\s+is\s+)?nothing\s+you\s+can\s+do\b/gi },
  // "there is no escape", "no escaping (this/your fate)", "no way to change/avoid".
  {
    kind: 'no-agency',
    re: /\b(?:there\s+is\s+)?no\s+(?:escape|escaping|way\s+to\s+(?:change|avoid|stop))\b/gi,
  },
  // "you are powerless", "you have no choice/control", "you cannot change your fate".
  {
    kind: 'no-agency',
    re: /\byou\s+(?:are\s+powerless|have\s+no\s+(?:choice|control|say)|cannot\s+change\s+(?:your\s+)?(?:fate|destiny))\b/gi,
  },
];

const MEDICAL_RULES: ToneRule[] = [
  // "you will (definitely/certainly/) get sick / become ill / develop <X> /
  //  fall ill / have a <heart attack/stroke/…>", absolute medical prediction.
  {
    kind: 'medical',
    // `you will` OR the contraction `you'll` (straight or curly apostrophe):
    // matching only the expanded form let "you'll definitely get sick" through
    // untouched, which is the phrasing a model most often produces.
    //
    // The condition list is CLOSED. It previously ended in `develop <any word>`
    // and a bare `have a stroke`, which flagged ordinary supportive astrology
    // ("you will develop a stronger sense of boundaries", "a stroke of luck") as
    // a medical prediction — the exact false-positive class this module's own
    // docs say must never happen.
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely\s+|certainly\s+|surely\s+|inevitably\s+)?(?:get\s+(?:sick|ill)|become\s+(?:sick|ill)|fall\s+ill|develop\s+(?:a\s+|an\s+)?(?:illness|disease|cancer|tumou?r|condition)|have\s+(?:a\s+|an\s+)?(?:heart\s+attack|stroke\s+(?!of\b)|cancer|illness|disease))\b/gi,
  },
];

const FINANCIAL_RULES: ToneRule[] = [
  // "you will (definitely/) go bankrupt / lose all your money / be broke / lose
  //  everything", absolute financial prediction.
  {
    kind: 'financial',
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely\s+|certainly\s+|surely\s+|inevitably\s+|undoubtedly\s+)?(?:go\s+bankrupt|be\s+broke|lose\s+(?:all\s+(?:your\s+)?money|everything|all\s+your\s+savings))\b/gi,
  },
];

const ALL_RULES: ToneRule[] = [
  ...DETERMINISM_RULES,
  ...DOOM_RULES,
  ...NO_AGENCY_RULES,
  ...MEDICAL_RULES,
  ...FINANCIAL_RULES,
];

/**
 * Scan model prose for fatalistic / deterministic / fear-mongering framing.
 * Conservative by design (see the rule notes): ordinary hedged astrology passes.
 * Returns every matched span (sorted by position) and `ok` = no matches.
 */
export function scanTone(text: string): ToneScanResult {
  const issues: ToneIssue[] = [];
  for (const rule of ALL_RULES) {
    // Each `re` carries the global flag; clone via matchAll to avoid lastIndex
    // state leaking between calls.
    for (const m of text.matchAll(rule.re)) {
      if (m.index === undefined) continue;
      issues.push({ kind: rule.kind, match: m[0], index: m.index });
    }
  }
  issues.sort((a, b) => a.index - b.index);
  return { issues, ok: issues.length === 0 };
}

/* -------------------------------------------------------------------------- */
/* 3. softenTone, deterministic, fact-preserving rewriter                     */
/* -------------------------------------------------------------------------- */

/**
 * An ordered list of surgical rewrites. Each one targets a fatalistic FRAME and
 * replaces it with a hedged, agency-forward equivalent. Crucially, NONE of these
 * touches a planet / sign / house / aspect / retrograde token, so softening can
 * never reintroduce a hallucinated chart fact, it only changes modality and
 * adds agency.
 *
 * Order matters: more specific patterns run before the generic determinism
 * adverb strip, so e.g. "you will definitely get sick" is handled by the medical
 * rule (which also removes the false certainty) rather than half-rewritten.
 *
 * Replacements are CASE-INSENSITIVE matches but emit fixed lowercase-friendly
 * text; we re-capitalise at sentence start in a final pass.
 */
interface Rewrite {
  re: RegExp;
  to: string;
}

const REWRITES: Rewrite[] = [
  // --- Medical / financial absolute predictions → soft potential + agency. --
  {
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely\s+|certainly\s+|surely\s+|inevitably\s+|undoubtedly\s+)?get\s+sick\b/gi,
    to: 'this period may invite you to pay closer attention to your wellbeing (for health concerns, consult a qualified professional)',
  },
  {
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely\s+|certainly\s+|surely\s+|inevitably\s+|undoubtedly\s+)?(?:go\s+bankrupt|be\s+broke)\b/gi,
    to: 'this period may call for extra care with your finances (for financial decisions, consult a qualified professional)',
  },
  {
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely\s+|certainly\s+|surely\s+|inevitably\s+|undoubtedly\s+)?lose\s+(?:all\s+(?:your\s+)?money|everything|all\s+your\s+savings)\b/gi,
    to: 'this period may call for extra care with what you value (for financial decisions, consult a qualified professional)',
  },

  // --- Doom verdicts → challenge + agency. ---------------------------------
  {
    re: /\byou(?:\s+are|'re)\s+doomed\s+to\s+(fail|fall|lose|suffer|be\s+alone|be\s+ruined|ruin)\b/gi,
    to: 'you may face challenges around $1, and you have real room to respond and grow',
  },
  {
    re: /\byou(?:\s+are|'re)\s+doomed\b/gi,
    to: 'you may face challenges here, and you have real room to grow',
  },
  {
    re: /\b(?:you\s+are|you're|this\s+is|it\s+is|it's)\s+(?:destined|fated|predestined|doomed)\s+to\s+(fail|fall|lose|suffer|be\s+alone|be\s+ruined|ruin)\b/gi,
    to: 'there can be a tendency toward $1 here, and you have real room to shape how it unfolds',
  },
  {
    re: /\byour\s+(life|future|marriage|career|relationship)\s+(?:will\s+be|is)\s+(?:ruined|destroyed|over|hopeless|finished)\b/gi,
    to: 'your $1 may meet real challenges here, and you have agency in how you respond',
  },

  // --- No-agency framing → restored agency. --------------------------------
  {
    re: /\b(?:there\s+is\s+)?nothing\s+you\s+can\s+do(?:\s+about\s+it)?\b/gi,
    to: 'there is room for you to choose how you respond',
  },
  {
    re: /\b(?:there\s+is\s+)?no\s+(?:escape|escaping)(?:\s+(?:this|your\s+fate))?\b/gi,
    to: 'there is room to work with this consciously',
  },
  {
    re: /\bno\s+way\s+to\s+(change|avoid|stop)\s+(it|this)\b/gi,
    to: 'space to work with $2 consciously',
  },
  { re: /\byou(?:\s+are|['’]re)\s+powerless\b/gi, to: 'you have more agency than it may feel' },
  {
    re: /\byou\s+have\s+no\s+(?:choice|control|say)\b/gi,
    to: 'you have meaningful choices here',
  },
  {
    re: /\byou\s+cannot\s+change\s+(?:your\s+)?(?:fate|destiny)\b/gi,
    to: 'you can shape how these themes play out',
  },

  // --- Generic determinism frames → hedged potential. ----------------------
  {
    re: /\b(?:you\s+are|you're|this\s+is|it\s+is|it's)\s+(?:destined|fated|predestined)\s+to\b/gi,
    to: 'there can be a pull toward',
  },
  {
    re: /\b(is|are|will\s+be)\s+(?:inevitable|unavoidable|set\s+in\s+stone)\b/gi,
    to: '$1 a strong theme, though not fixed,',
  },
  // "you will definitely/certainly/… <verb>" → "you may <verb>". Strips the
  // false certainty while keeping the (already fact-validated) clause.
  {
    re: /\byou(?:\s+will|['’]ll)\s+(?:definitely|certainly|surely|inevitably|undoubtedly|for\s+sure)\b/gi,
    to: 'you may well',
  },
  {
    re: /\byou(?:\s+are|['’]re)\s+going\s+to\s+(?:definitely|certainly|surely|inevitably|undoubtedly|for\s+sure)\b/gi,
    to: 'you may well',
  },
];

/** Capitalise the first letter after a sentence boundary, to tidy rewrites. */
function recapitalizeSentences(text: string): string {
  return text.replace(
    /(^|[.!?]\s+)([a-z])/g,
    (_full, lead: string, ch: string) => lead + ch.toUpperCase(),
  );
}

/**
 * Deterministically rewrite the worst fatalistic / deterministic offenders into
 * hedged, agency-forward phrasing, PRESERVING the underlying factual claim.
 *
 * Pure and idempotent: running it twice yields the same output (the rewrites map
 * fatalistic frames to neutral frames that the rules no longer match). It never
 * edits chart-fact tokens, so it cannot undo `validateText`/`repairText`.
 */
export function softenTone(text: string): string {
  let out = text;
  for (const { re, to } of REWRITES) {
    out = out.replace(re, to);
  }
  return recapitalizeSentences(out);
}
