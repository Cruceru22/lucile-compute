/**
 * @astroapp/ai-grounding
 *
 * PURE, dependency-free anti-hallucination core for the AI interpretation layer
 * (TASK A8). The DETERMINISTIC engine (A3, Swiss Ephemeris) computes the chart;
 * the LLM ONLY interprets it. This module is the contract that keeps the LLM
 * honest. It has three jobs, all pure and unit-testable with NO network:
 *
 *   1. chart2txt   — serialize a `NatalChart` into a compact, unambiguous
 *                    GROUND-TRUTH block. This is the LLM's ONLY source of chart
 *                    facts; it is injected into the system prompt verbatim.
 *   2. fact tools  — the lookup functions (`get_planet`, `get_house`,
 *                    `get_aspect`, `list_aspects`, `get_angles`) the model calls
 *                    via tool-use to FETCH facts rather than invent them. Each is
 *                    backed by the deterministic chart JSON.
 *   3. validation  — parse the factual assertions out of model prose
 *                    ("<Planet> in <Sign>", "<Planet> in House <n>",
 *                    "<Planet> <aspect> <Planet>", retrograde claims) and verify
 *                    each against the chart. Mismatches are caught and reported
 *                    so the orchestrator can strip/correct them — un-validated
 *                    chart facts NEVER reach the user.
 *
 * The Deno `ai-interpret` Edge Function cannot import the pnpm/tsc workspace, so
 * it carries a MIRROR of this file
 * (`supabase/functions/ai-interpret/_shared/ai-grounding.ts`) that is
 * byte-for-byte identical below the import line. A drift test runs the SAME
 * cases through both — see `apps/mobile/src/features/ai/aiGrounding.test.ts`.
 */
import type {
  Aspect,
  AspectType,
  House,
  NatalChart,
  Planet,
  PlanetName,
  ZodiacSign,
} from '@astroapp/shared';

// Re-export the chart types this module operates on, so consumers (the compute
// service, tests) can import them alongside the grounding API from one place.
// This does NOT alter `@astroapp/shared`'s own exports.
export type { Aspect, AspectType, House, NatalChart, Planet, PlanetName, ZodiacSign };

// Tone-safety guard (TASK D7) — supportive / non-fatalist framing. PURE and
// independent of the chart-fact core below; lives in its own file so the Deno
// mirror stays a clean byte-for-byte copy. Re-exported here for package
// consumers (`import { scanTone } from '@astroapp/ai-grounding'`).
export {
  TONE_SAFETY_DIRECTIVE,
  scanTone,
  softenTone,
  type ToneIssue,
  type ToneIssueKind,
  type ToneScanResult,
} from './tone.js';

/* -------------------------------------------------------------------------- */
/* Shared constants                                                           */
/* -------------------------------------------------------------------------- */

/** The twelve signs in zodiacal order; index 0 = Aries. Used for parsing. */
export const ZODIAC_SIGNS: readonly ZodiacSign[] = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
];

/** All recognised body/point names. */
export const PLANET_NAMES: readonly PlanetName[] = [
  'Sun',
  'Moon',
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
  'Pluto',
  'Chiron',
  'NorthNode',
  'Lilith',
  'Ceres',
  'Pallas',
  'Juno',
  'Vesta',
];

/** The five Ptolemaic aspect types. */
export const ASPECT_TYPES: readonly AspectType[] = [
  'conjunction',
  'sextile',
  'square',
  'trine',
  'opposition',
];

/**
 * Human aliases the model may write for a body. Keys are lowercase; we also
 * accept the canonical name itself (handled in `parsePlanetName`). "Node" maps
 * to the North Node, "Black Moon Lilith" to Lilith.
 */
const PLANET_ALIASES: Readonly<Record<string, PlanetName>> = {
  sun: 'Sun',
  moon: 'Moon',
  mercury: 'Mercury',
  venus: 'Venus',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
  uranus: 'Uranus',
  neptune: 'Neptune',
  pluto: 'Pluto',
  chiron: 'Chiron',
  lilith: 'Lilith',
  'black moon lilith': 'Lilith',
  'north node': 'NorthNode',
  northnode: 'NorthNode',
  node: 'NorthNode',
  'true node': 'NorthNode',
  ceres: 'Ceres',
  pallas: 'Pallas',
  'pallas athena': 'Pallas',
  juno: 'Juno',
  vesta: 'Vesta',
};

/* -------------------------------------------------------------------------- */
/* Small formatters (pure)                                                    */
/* -------------------------------------------------------------------------- */

/** Format a within-sign degree `[0,30)` as `18°22′` (degrees + arcminutes). */
export function formatDegreeMinutes(degreeInSign: number): string {
  const whole = Math.floor(degreeInSign);
  const minutes = Math.round((degreeInSign - whole) * 60);
  if (minutes === 60) {
    const next = whole + 1;
    // A carry out of 29° means the position has rolled into the NEXT sign, so
    // "30°00′" would be an impossible degree. `signAndDegree` rounds to the
    // arcminute before splitting, so the paired path never reaches this; clamp
    // for any direct caller rather than emit a position that cannot exist.
    return next >= 30 ? '0°00′' : `${next}°00′`;
  }
  return `${whole}°${minutes.toString().padStart(2, '0')}′`;
}

/**
 * Sign + degree-within-sign for an absolute ecliptic longitude `[0,360)`.
 *
 * Rounds to the arcminute BEFORE splitting into sign + degree, because that is
 * the precision the output is formatted at. Splitting first meant a longitude
 * within 30″ under a sign boundary — e.g. 119.9958° = Cancer 29°59′45″ — printed
 * as "30°00′ Cancer", a degree that does not exist, instead of "0°00′ Leo".
 */
export function signAndDegree(absoluteDegree: number): { sign: ZodiacSign; degree: number } {
  const norm = ((absoluteDegree % 360) + 360) % 360;
  const rounded = (Math.round(norm * 60) / 60) % 360;
  const index = Math.floor(rounded / 30) % 12;
  const sign = ZODIAC_SIGNS[index] ?? 'Aries';
  return { sign, degree: rounded - index * 30 };
}

/**
 * Whether a chart angle is actually present. Guards `undefined` (a chart
 * round-tripped through JSON/DB that dropped the key) as well as `null`, and
 * rejects non-finite values — `signAndDegree(NaN)` would otherwise fall through
 * to `ZODIAC_SIGNS[NaN] ?? 'Aries'` and assert an Ascendant in Aries that does
 * not exist. Fabricating a chart fact is the one thing this module must never do.
 */
function angleAvailable(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/* -------------------------------------------------------------------------- */
/* chart2txt — the ground-truth serialization                                 */
/* -------------------------------------------------------------------------- */

/** Options for {@link chart2txt}. */
export interface Chart2TxtOptions {
  /** Optional label for the chart (e.g. a person's name). Defaults to "Subject". */
  label?: string;
}

/**
 * Serialize a `NatalChart` into a compact, unambiguous ground-truth block for
 * the LLM prompt. Every planet's sign+degree+house+retrograde, the house cusps,
 * the angles (Asc/MC), the aspects with orbs, and the computation meta-flags.
 * Deterministic and stable: the SAME chart always produces the SAME text.
 *
 * This is the LLM's ONLY source of chart facts.
 */
export function chart2txt(chart: NatalChart, options: Chart2TxtOptions = {}): string {
  const label = options.label ?? 'Subject';
  const lines: string[] = [];

  lines.push(`### GROUND-TRUTH CHART: ${label}`);
  lines.push(`House system: ${chart.houseSystem}`);
  lines.push(`Computed at: ${chart.computedAt}`);

  // --- Meta / accuracy caveats (the model must respect these). -------------
  const meta: string[] = [];
  if (chart.timeKnown === false) meta.push('birth time UNKNOWN');
  if (chart.housesAvailable === false) meta.push('houses/Ascendant/MC NOT available');
  if (chart.usedNoonFallback) meta.push('positions use a noon fallback for the unknown time');
  if (chart.preTzDatabaseEra) meta.push('born before 1970, time-zone history approximate');
  if (chart.ephemerisBackend) meta.push(`ephemeris backend: ${chart.ephemerisBackend}`);
  if (chart.unavailableBodies && chart.unavailableBodies.length > 0) {
    meta.push(`unavailable bodies: ${chart.unavailableBodies.join(', ')}`);
  }
  lines.push(`Meta: ${meta.length > 0 ? meta.join('; ') : 'none'}`);

  // --- Angles. -------------------------------------------------------------
  lines.push('');
  lines.push('## Angles');
  if (!angleAvailable(chart.ascendant) && !angleAvailable(chart.midheaven)) {
    lines.push('Ascendant: unavailable (birth time unknown)');
    lines.push('Midheaven: unavailable (birth time unknown)');
  } else {
    if (angleAvailable(chart.ascendant)) {
      const asc = signAndDegree(chart.ascendant);
      lines.push(`Ascendant: ${formatDegreeMinutes(asc.degree)} ${asc.sign}`);
    } else {
      lines.push('Ascendant: unavailable');
    }
    if (chart.midheaven !== null) {
      const mc = signAndDegree(chart.midheaven);
      lines.push(`Midheaven: ${formatDegreeMinutes(mc.degree)} ${mc.sign}`);
    } else {
      lines.push('Midheaven: unavailable');
    }
  }

  // --- Planets. ------------------------------------------------------------
  lines.push('');
  lines.push('## Planets');
  for (const p of chart.planets) {
    const retro = p.retrograde ? ' [retrograde]' : '';
    const house = p.house > 0 ? ` in House ${p.house}` : '';
    lines.push(`${p.name}: ${formatDegreeMinutes(p.degree)} ${p.sign}${house}${retro}`);
  }

  // --- Houses. -------------------------------------------------------------
  lines.push('');
  lines.push('## Houses (cusps)');
  if (chart.houses.length === 0) {
    lines.push('unavailable (birth time unknown)');
  } else {
    for (const h of chart.houses) {
      const sd = signAndDegree(h.cuspDegree);
      lines.push(`House ${h.number}: ${formatDegreeMinutes(sd.degree)} ${h.sign}`);
    }
  }

  // --- Aspects. ------------------------------------------------------------
  lines.push('');
  lines.push('## Aspects');
  if (chart.aspects.length === 0) {
    lines.push('none');
  } else {
    for (const a of chart.aspects) {
      const motion = a.applying ? 'applying' : 'separating';
      lines.push(`${a.a} ${a.type} ${a.b} (orb ${a.orb.toFixed(2)}°, ${motion})`);
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Fact tools — the lookups the model calls instead of inventing              */
/* -------------------------------------------------------------------------- */

/** A normalised, JSON-safe planet fact returned by `get_planet`. */
export interface PlanetFact {
  name: PlanetName;
  sign: ZodiacSign;
  degree: number;
  degreeFormatted: string;
  house: number;
  retrograde: boolean;
  absoluteDegree: number;
}

/** A normalised house fact returned by `get_house`. */
export interface HouseFact {
  number: number;
  sign: ZodiacSign;
  cuspDegree: number;
  degreeFormatted: string;
}

/** A normalised aspect fact returned by `get_aspect` / `list_aspects`. */
export interface AspectFact {
  a: PlanetName;
  b: PlanetName;
  type: AspectType;
  orb: number;
  applying: boolean;
}

/** Angles fact returned by `get_angles`. */
export interface AnglesFact {
  ascendant: { sign: ZodiacSign; degree: number; degreeFormatted: string } | null;
  midheaven: { sign: ZodiacSign; degree: number; degreeFormatted: string } | null;
  available: boolean;
}

function planetToFact(p: Planet): PlanetFact {
  return {
    name: p.name,
    sign: p.sign,
    degree: p.degree,
    degreeFormatted: formatDegreeMinutes(p.degree),
    house: p.house,
    retrograde: p.retrograde,
    absoluteDegree: p.absoluteDegree,
  };
}

function houseToFact(h: House): HouseFact {
  const sd = signAndDegree(h.cuspDegree);
  return {
    number: h.number,
    sign: h.sign,
    cuspDegree: h.cuspDegree,
    degreeFormatted: formatDegreeMinutes(sd.degree),
  };
}

/**
 * The fact-lookup tools, all reading ONLY from the deterministic chart. These
 * back the LLM tool-use blocks: the model asks `get_planet("Mars")` and gets the
 * real placement, so it never has to guess. Lookups are name-tolerant (aliases,
 * case-insensitive) but return `null` for anything not in the chart.
 */
export class ChartFactTools {
  constructor(private readonly chart: NatalChart) {}

  /** Look up a body by (possibly aliased) name. */
  getPlanet(name: string): PlanetFact | null {
    const canonical = parsePlanetName(name);
    if (!canonical) return null;
    const planet = this.chart.planets.find((p) => p.name === canonical);
    return planet ? planetToFact(planet) : null;
  }

  /** Look up a house cusp by number `1..12`. */
  getHouse(numberInput: number): HouseFact | null {
    if (!Number.isInteger(numberInput) || numberInput < 1 || numberInput > 12) return null;
    const house = this.chart.houses.find((h) => h.number === numberInput);
    return house ? houseToFact(house) : null;
  }

  /**
   * Look up the aspect between two bodies, regardless of argument order. Returns
   * `null` when the two bodies form no aspect in the chart (an honest "no").
   */
  getAspect(a: string, b: string): AspectFact | null {
    const ca = parsePlanetName(a);
    const cb = parsePlanetName(b);
    if (!ca || !cb) return null;
    const match = this.chart.aspects.find(
      (asp) => (asp.a === ca && asp.b === cb) || (asp.a === cb && asp.b === ca),
    );
    return match ? aspectToFact(match) : null;
  }

  /** All aspects in the chart. */
  listAspects(): AspectFact[] {
    return this.chart.aspects.map(aspectToFact);
  }

  /** The Ascendant and Midheaven (or `available: false` when unknown-time). */
  getAngles(): AnglesFact {
    const asc = this.chart.ascendant;
    const mc = this.chart.midheaven;
    // `angleAvailable` (not `!== null`) so a chart that lost these keys in a
    // JSON/DB round-trip, or carries a non-finite value, reports unavailable
    // instead of asserting a fabricated Aries angle to the model.
    const ascOk = angleAvailable(asc);
    const mcOk = angleAvailable(mc);
    return {
      ascendant: ascOk
        ? {
            ...signAndDegree(asc),
            degreeFormatted: formatDegreeMinutes(signAndDegree(asc).degree),
          }
        : null,
      midheaven: mcOk
        ? {
            ...signAndDegree(mc),
            degreeFormatted: formatDegreeMinutes(signAndDegree(mc).degree),
          }
        : null,
      available: ascOk || mcOk,
    };
  }
}

function aspectToFact(a: Aspect): AspectFact {
  return { a: a.a, b: a.b, type: a.type, orb: a.orb, applying: a.applying };
}

/* -------------------------------------------------------------------------- */
/* Parsing helpers (shared by validation + tools)                             */
/* -------------------------------------------------------------------------- */

/** Resolve a (possibly aliased / cased) body name to its canonical form. */
export function parsePlanetName(raw: string): PlanetName | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  // Canonical names (incl. NorthNode) match case-insensitively.
  const canonical = PLANET_NAMES.find((n) => n.toLowerCase() === lower);
  if (canonical) return canonical;
  return PLANET_ALIASES[lower] ?? null;
}

/** Resolve a (possibly cased) sign name to its canonical form. */
export function parseSign(raw: string): ZodiacSign | null {
  const lower = raw.trim().toLowerCase();
  return ZODIAC_SIGNS.find((s) => s.toLowerCase() === lower) ?? null;
}

/** Resolve a (possibly cased) aspect word to its canonical type. */
export function parseAspectType(raw: string): AspectType | null {
  const lower = raw.trim().toLowerCase();
  return ASPECT_TYPES.find((t) => t === lower) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Claim extraction + validation — catches fabricated chart facts             */
/* -------------------------------------------------------------------------- */

/** A factual claim parsed out of model prose. */
export type Claim =
  | { kind: 'placement'; planet: PlanetName; sign: ZodiacSign; raw: string }
  | { kind: 'house'; planet: PlanetName; house: number; raw: string }
  | { kind: 'aspect'; a: PlanetName; b: PlanetName; type: AspectType; raw: string }
  | { kind: 'retrograde'; planet: PlanetName; retrograde: boolean; raw: string };

/** A validation verdict for one claim. */
export interface ClaimVerdict {
  claim: Claim;
  /** True when the claim matches the deterministic chart. */
  valid: boolean;
  /** What the chart actually says (for correction / logging). */
  expected?: string;
}

const PLANET_WORD = '(?:North Node|Black Moon Lilith|True Node|[A-Z][a-z]+)';
const SIGN_WORD = ZODIAC_SIGNS.join('|');
const ASPECT_WORD = ASPECT_TYPES.join('|');

/**
 * Extract the verifiable factual assertions from a block of model prose. We are
 * deliberately CONSERVATIVE: we only match the unambiguous, structured forms
 * (the ones that can be checked against the chart). Interpretive language is
 * left untouched. Patterns handled:
 *
 *   - placement:   "Mars in Aries"            (planet in sign)
 *   - house:       "Mars in House 5" / "...in the 5th house"
 *   - aspect:      "Mars square Venus"
 *   - retrograde:  "Mars is retrograde" / "Mars retrograde" / "Mars is direct"
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];

  // House FIRST (so "Mars in House 5" isn't mis-read as a placement).
  const houseRe = new RegExp(
    `(${PLANET_WORD})\\s+(?:is\\s+)?in\\s+(?:the\\s+)?(?:House\\s+(\\d{1,2})|(\\d{1,2})(?:st|nd|rd|th)\\s+house)`,
    'g',
  );
  const houseSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(houseRe)) {
    const planet = parsePlanetName(m[1] ?? '');
    const houseStr = m[2] ?? m[3];
    const house = houseStr ? Number.parseInt(houseStr, 10) : NaN;
    if (planet && Number.isFinite(house)) {
      claims.push({ kind: 'house', planet, house, raw: m[0] });
      if (m.index !== undefined) houseSpans.push([m.index, m.index + m[0].length]);
    }
  }

  // Placement: "<Planet> in <Sign>". Skip spans already claimed as houses.
  const placementRe = new RegExp(`(${PLANET_WORD})\\s+(?:is\\s+)?in\\s+(${SIGN_WORD})`, 'g');
  for (const m of text.matchAll(placementRe)) {
    if (m.index !== undefined && houseSpans.some(([s, e]) => m.index! >= s && m.index! < e)) {
      continue;
    }
    const planet = parsePlanetName(m[1] ?? '');
    const sign = parseSign(m[2] ?? '');
    if (planet && sign) claims.push({ kind: 'placement', planet, sign, raw: m[0] });
  }

  // Aspect: "<Planet> <aspect> <Planet>".
  const aspectRe = new RegExp(`(${PLANET_WORD})\\s+(${ASPECT_WORD})\\s+(${PLANET_WORD})`, 'g');
  for (const m of text.matchAll(aspectRe)) {
    const a = parsePlanetName(m[1] ?? '');
    const type = parseAspectType(m[2] ?? '');
    const b = parsePlanetName(m[3] ?? '');
    if (a && b && type) claims.push({ kind: 'aspect', a, b, type, raw: m[0] });
  }

  // Retrograde / direct.
  const retroRe = new RegExp(`(${PLANET_WORD})\\s+(?:is\\s+)?(retrograde|direct)`, 'gi');
  for (const m of text.matchAll(retroRe)) {
    const planet = parsePlanetName(m[1] ?? '');
    const word = (m[2] ?? '').toLowerCase();
    if (planet) {
      claims.push({ kind: 'retrograde', planet, retrograde: word === 'retrograde', raw: m[0] });
    }
  }

  return claims;
}

/** Verify a single extracted claim against the deterministic chart. */
export function verifyClaim(claim: Claim, tools: ChartFactTools): ClaimVerdict {
  switch (claim.kind) {
    case 'placement': {
      const fact = tools.getPlanet(claim.planet);
      if (!fact) return { claim, valid: false, expected: `${claim.planet} is not in the chart` };
      return {
        claim,
        valid: fact.sign === claim.sign,
        expected: `${claim.planet} is in ${fact.sign}`,
      };
    }
    case 'house': {
      const fact = tools.getPlanet(claim.planet);
      if (!fact) return { claim, valid: false, expected: `${claim.planet} is not in the chart` };
      if (fact.house <= 0) {
        return { claim, valid: false, expected: `${claim.planet} has no house (unknown time)` };
      }
      return {
        claim,
        valid: fact.house === claim.house,
        expected: `${claim.planet} is in House ${fact.house}`,
      };
    }
    case 'aspect': {
      const fact = tools.getAspect(claim.a, claim.b);
      if (!fact) {
        return { claim, valid: false, expected: `${claim.a} and ${claim.b} form no aspect` };
      }
      return {
        claim,
        valid: fact.type === claim.type,
        expected: `${claim.a} ${fact.type} ${claim.b}`,
      };
    }
    case 'retrograde': {
      const fact = tools.getPlanet(claim.planet);
      if (!fact) return { claim, valid: false, expected: `${claim.planet} is not in the chart` };
      return {
        claim,
        valid: fact.retrograde === claim.retrograde,
        expected: `${claim.planet} is ${fact.retrograde ? 'retrograde' : 'direct'}`,
      };
    }
  }
}

/** The structured result of validating a block of model output. */
export interface ValidationResult {
  /** All claims parsed out of the text. */
  claims: ClaimVerdict[];
  /** Only the claims that did NOT match the chart (fabrications). */
  violations: ClaimVerdict[];
  /** True when no fabricated chart fact was found. */
  ok: boolean;
}

/**
 * Validate a block of model output against the chart: extract every checkable
 * factual claim and verify it. The orchestrator uses `violations` to strip or
 * re-prompt; `ok === false` means at least one fabricated chart fact was caught
 * and the raw text must NOT be returned to the user unrepaired.
 */
export function validateText(text: string, chart: NatalChart): ValidationResult {
  const tools = new ChartFactTools(chart);
  const claims = extractClaims(text).map((c) => verifyClaim(c, tools));
  const violations = claims.filter((v) => !v.valid);
  return { claims, violations, ok: violations.length === 0 };
}

/**
 * Repair model output by appending a correction note for each caught
 * fabrication. We do NOT silently rewrite the prose (that risks corrupting
 * meaning); instead we surface the authoritative fact so the rendered answer is
 * never left asserting a falsehood unchallenged. The orchestrator may also
 * re-prompt; this is the always-safe fallback.
 */
export function repairText(text: string, result: ValidationResult): string {
  if (result.ok) return text;
  const corrections = result.violations
    .map((v) => `• "${v.claim.raw.trim()}" is incorrect, ${v.expected}.`)
    .join('\n');
  return `${text}\n\n[Correction, the following did not match your computed chart and have been flagged:\n${corrections}]`;
}
