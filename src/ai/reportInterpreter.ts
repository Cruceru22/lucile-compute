/**
 * Report content generation with the SAME anti-hallucination guarantees as the
 * chat path (TASK A8): chart2txt ground truth + fact tools + claim validation.
 *
 * Reuses the canonical `@astroapp/ai-grounding` package directly (the compute
 * service is a Node workspace, so no mirror is needed here). Supports natal,
 * annual, and compatibility reports; compatibility takes ONE or TWO charts so it
 * structurally ties into A9 later.
 */
import {
  chart2txt,
  ChartFactTools,
  extractClaims,
  repairText,
  softenTone,
  TONE_SAFETY_DIRECTIVE,
  validateText,
  verifyClaim,
  type NatalChart,
  type ValidationResult,
} from '@astroapp/ai-grounding';
import { directedProfectionMonths, directedProfectionsInRange } from '@astroapp/shared';
import type { BirthData, PlanetName, TransitEvent } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { scoreCompatibility } from '../compatibility.js';
import { computeNatal } from '../natal.js';
import { computeSynastry } from '../synastry.js';
import { computeTransits } from '../transits.js';
import type { AIProvider, ContentBlock, ProviderMessage, ToolSpec } from './provider.js';

/** Slow, theme-defining transiting bodies for an annual forecast (no Moon noise). */
const SLOW_TRANSITING: PlanetName[] = [
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
  'Pluto',
  'Chiron',
  'NorthNode',
];

/** One-line, human-readable description of a transit event (date + orb). */
function describeTransit(e: TransitEvent): string {
  return `transiting ${e.transitingPlanet} ${e.aspect} natal ${e.natalPlanet}, exact ${e.exactAt.slice(0, 10)} (orb ${e.orb.toFixed(1)}°)`;
}

const ANNUAL_OVERVIEW_HEADING = 'The Year Ahead';

/**
 * Compute the next 12 months of slow-planet transits, grouped by calendar month
 * and formatted for the prompt: a year-wide list (for the overview) plus a
 * per-month list of that month's actual perfecting transits (named, with exact
 * dates). This is the deterministic ground truth that makes the forecast
 * specific and month-by-month rather than a generic natal re-read.
 */
function annualTransitData(
  primary: NatalChart,
  nowIso: string,
): { overview: string; months: Array<{ label: string; list: string }> } {
  const start = DateTime.fromISO(nowIso, { zone: 'utc' }).startOf('day');
  const events = computeTransits(primary, start.toISO()!, start.plus({ years: 1 }).toISO()!, {
    transitingBodies: SLOW_TRANSITING,
    stepDays: 2,
  }).sort((a, b) => a.exactAt.localeCompare(b.exactAt));

  const byMonth = new Map<string, TransitEvent[]>();
  for (const e of events) {
    const key = e.exactAt.slice(0, 7); // YYYY-MM
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(e);
    else byMonth.set(key, [e]);
  }

  const overview = events.length
    ? events.map(describeTransit).join('; ')
    : 'no major slow-planet transits perfect in the year ahead (a steady, low-key year)';

  const months: Array<{ label: string; list: string }> = [];
  let cursor = start.startOf('month');
  for (let i = 0; i < 12; i++) {
    const evs = byMonth.get(cursor.toFormat('yyyy-MM')) ?? [];
    months.push({
      label: cursor.toFormat('LLLL yyyy'),
      list: evs.length
        ? evs.map(describeTransit).join('; ')
        : 'no slow-planet transit perfects exactly this month',
    });
    cursor = cursor.plus({ months: 1 });
  }

  return { overview, months };
}

/**
 * Generate the whole month-by-month annual forecast in a SINGLE model call.
 *
 * The natal report fans out one call per section; for the annual report that
 * would be 13 calls (overview + 12 months), which blows past tight provider
 * rate limits (e.g. Gemini free tier = 20 requests/day). Instead we feed the
 * full deterministic transit data for the year and ask for every section in one
 * response, delimited by `===Heading===` markers, then split + validate once.
 */
async function generateAnnualReport(
  provider: AIProvider,
  primary: NatalChart,
  labels: string[],
  nowIso: string,
  birthDate?: string,
): Promise<GeneratedReport> {
  const system = systemPrompt([primary], 'annual', labels);
  const { overview, months } = annualTransitData(primary, nowIso);

  const transitBlock = [
    `Most significant across the whole year: ${overview}`,
    ...months.map((m) => `${m.label}: ${m.list}`),
  ].join('\n');

  // Directed profections (al-Tabari): the deterministic day-level timing layer.
  // We pre-compute the exact dated activations per month and feed them as ground
  // truth so the model can give CONCRETE day windows — it must never do this
  // arithmetic itself. Only available with a known birth time (an Ascendant) and
  // a birth date; otherwise we simply omit the block.
  const directed = birthDate
    ? directedProfectionMonths(primary, birthDate, nowIso)
    : { available: false as const, months: [] as Array<{ label: string; list: string }> };
  const directedByLabel = new Map(directed.months.map((m) => [m.label, m.list]));
  const directedBlock = directed.available
    ? directed.months.map((m) => `${m.label}: ${m.list}`).join('\n')
    : '';

  // Shared ground truth, identical for all thirteen calls below.
  //
  // It goes in the SYSTEM prompt, NOT the user message, and that placement is
  // the whole cost story. `AnthropicProvider.systemBlocks` marks the system
  // block `cache_control: ephemeral`, so this large, unchanging block is billed
  // once and then at ~0.1x for the twelve calls that follow. In a user message
  // it would sit after the cache breakpoint and be billed in full thirteen
  // times — turning a latency fix into a bill.
  const groundTruth = [
    'THE EXACT TRANSITS (real, computed, use these, name them with their dates; never invent others):',
    transitBlock,
    ...(directed.available
      ? [
          '',
          'DIRECTED PROFECTIONS (al-Tabari), the precise day-level timing. These are REAL,',
          'computed activations of the directed point (it moves one sign per profection year',
          'from the equal-house cusp). Use these EXACT dates and windows; never invent dates,',
          'degrees, or aspects.',
          directedBlock,
        ]
      : []),
    '',
    'Ground every factual claim in the chart facts above. Be specific; never generic.',
  ].join('\n');

  const overviewPrompt = [
    `Write the "${ANNUAL_OVERVIEW_HEADING}" section of an annual forecast: 2-3 paragraphs on the`,
    "year's main themes. Name the most significant transits, roughly when they peak, and tie them",
    'to the natal placements.' +
      (directed.available
        ? ' Also name the 1-2 most important DIRECTED-PROFECTION activations of the year and the months they land in.'
        : ''),
    'Write the prose only — no heading, no markers.',
  ].join('\n');

  function monthPrompt(label: string): string {
    const directedLine = directedByLabel.get(label);
    const directedClause = directedLine
      ? ` Then give the PRECISE timing from directed profections for ${label}: ${directedLine === 'no directed-profection activation this month' ? 'no directed activation lands this month, so say the month is quiet by that measure.' : 'state the exact date(s) and the tight day-window for each activation, and interpret what that natal factor or term-lord activating means.'}`
      : '';
    return [
      `Write the ${label} section of an annual forecast: 1-2 concrete paragraphs.`,
      `NAME that month's exact transit(s) and their dates, connect them to the natal chart, and`,
      `give specific guidance.${directedClause} If the month is quiet on every measure, say so`,
      // Kept on ONE line: `promptGuards.test.ts` asserts this exact phrase is
      // present in the source, so line-wrapping it silently disarms the guard.
      'honestly and point to the nearest upcoming activation. END with exactly ONE actionable, mundane suggestion the reader can literally schedule or do (book the conversation, block the rest day, draft the budget, send the application), explicitly tied to the named transit that motivates it, citing that transit in parentheses.',
      'Write the prose only — no heading, no markers.',
    ].join('\n');
  }

  // The annual forecast is ABOUT transiting planets ("transiting Jupiter in Aries
  // this month"), whose signs are the TRANSIT data's ground truth, NOT the natal
  // placements. Running natal placement-sign validation here false-flags every
  // correct transit sentence as a hallucination and appends bogus corrections, so
  // we skip placement/house/aspect/retrograde validation for this text path and
  // treat the transit lines we fed the model as the ground truth instead.
  const validation: ValidationResult = { claims: [], violations: [], ok: true };

  const annualSystem = `${system}\n\n${groundTruth}`;

  async function generateOne(prompt: string): Promise<string> {
    const result = await provider.chat({
      system: annualSystem,
      messages: [{ role: 'user', content: prompt }],
      // 1500 is ample for one section and, unlike the old single 8192-token call
      // covering all thirteen, cannot truncate the year part-way through.
      maxTokens: 1500,
    });
    const text = softenTone(repairText(extractText(result.content), validation)).trim();
    if (text.length === 0) {
      throw new Error(
        result.stopReason === 'max_tokens'
          ? 'section truncated before producing content (max_tokens)'
          : 'section came back empty',
      );
    }
    return text;
  }

  // ONE CALL PER SECTION, replacing a single 8192-token call that wrote all
  // thirteen. Three reasons, in order of importance:
  //
  //  1. Wall-clock. Thirteen sections from one call is a long serial generation
  //     that regularly ran past a minute; as independent calls the cost is the
  //     SLOWEST one, not the sum. That is what brings a report inside a
  //     serverless request budget.
  //  2. It cannot truncate mid-year. The old call shared one token budget across
  //     the whole forecast, so a long January quietly cost December.
  //  3. Each month gets the model's full attention and its own budget.
  //
  // The overview is awaited FIRST, alone, on purpose: it warms the provider's
  // cached system prefix, so the twelve month calls that follow bill it at ~0.1x
  // instead of all paying full price simultaneously. Firing all thirteen at once
  // would be marginally faster and materially more expensive.
  const overviewText = await generateOne(overviewPrompt).catch((err: unknown) => {
    console.warn('[reportInterpreter] annual overview failed:', err);
    return null;
  });

  const monthResults = await Promise.allSettled(
    months.map((m) => generateOne(monthPrompt(m.label))),
  );

  const sections: ReportSection[] = [];
  if (overviewText) {
    sections.push({ heading: ANNUAL_OVERVIEW_HEADING, body: overviewText, validation });
  }
  monthResults.forEach((outcome, index) => {
    const label = months[index]?.label;
    if (!label) return;
    if (outcome.status === 'fulfilled') {
      sections.push({ heading: label, body: outcome.value, validation });
    } else {
      console.warn(`[reportInterpreter] annual month "${label}" failed:`, outcome.reason);
    }
  });

  // Everything failed — a blank PDF rendered as success would hide a total
  // failure, so surface it as one.
  if (sections.length === 0) {
    throw new Error('Annual forecast came back empty (the AI returned no content).');
  }

  const year = DateTime.fromISO(nowIso, { zone: 'utc' }).year;

  // We expect 13 sections (overview + 12 months). Anything fewer means months
  // are genuinely missing, so the client never claims a complete year on a short
  // report.
  const EXPECTED_SECTIONS = months.length + 1;
  const failedSections = Math.max(0, EXPECTED_SECTIONS - sections.length);

  return {
    kind: 'annual',
    title: `${TITLES.annual}, ${year}`,
    sections,
    hallucinationsCaught: validation.violations.length,
    failedSections,
  };
}

export type ReportKind = 'natal' | 'annual' | 'compatibility';

export interface ReportSection {
  heading: string;
  body: string;
  /** Validation outcome for this section's body. */
  validation: ValidationResult;
}

export interface GeneratedReport {
  kind: ReportKind;
  title: string;
  sections: ReportSection[];
  /** Total caught (and repaired) fabrications across all sections. */
  hallucinationsCaught: number;
  /**
   * How many sections failed to generate and were replaced by a placeholder.
   * 0 on a fully successful report. The client should NOT claim "all facts
   * verified" when this is > 0, since the failed sections were not validated.
   */
  failedSections: number;
}

/** Fact tools exposed to the model (matches the chat path). */
function factToolSpecs(charts: NatalChart[]): ToolSpec[] {
  const suffix =
    charts.length > 1
      ? ' Pass `which: 1` or `which: 2` to choose the chart (1 = first person, 2 = second).'
      : '';
  const whichProp = charts.length > 1 ? { which: { type: 'integer', description: '1 or 2.' } } : {};
  return [
    {
      name: 'get_planet',
      description: `Fetch a body's exact placement from the computed chart.${suffix}`,
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, ...whichProp },
        required: ['name'],
      },
    },
    {
      name: 'get_house',
      description: `Fetch a house cusp (1..12) from the computed chart.${suffix}`,
      input_schema: {
        type: 'object',
        properties: { number: { type: 'integer' }, ...whichProp },
        required: ['number'],
      },
    },
    {
      name: 'get_aspect',
      description: `Fetch the aspect between two bodies, or null.${suffix}`,
      input_schema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' }, ...whichProp },
        required: ['a', 'b'],
      },
    },
    {
      name: 'list_aspects',
      description: `List all aspects in the computed chart.${suffix}`,
      input_schema: { type: 'object', properties: { ...whichProp } },
    },
    {
      name: 'get_angles',
      description: `Fetch the Ascendant + Midheaven.${suffix}`,
      input_schema: { type: 'object', properties: { ...whichProp } },
    },
  ];
}

function dispatch(
  toolsByChart: ChartFactTools[],
  name: string,
  input: Record<string, unknown>,
): unknown {
  const idx = Math.max(0, (Number(input.which) || 1) - 1);
  const tools = toolsByChart[idx] ?? toolsByChart[0];
  if (!tools) return { error: 'no_chart' };
  switch (name) {
    case 'get_planet':
      return tools.getPlanet(String(input.name ?? ''));
    case 'get_house':
      return tools.getHouse(Number(input.number));
    case 'get_aspect':
      return tools.getAspect(String(input.a ?? ''), String(input.b ?? ''));
    case 'list_aspects':
      return tools.listAspects();
    case 'get_angles':
      return tools.getAngles();
    default:
      return { error: `unknown tool: ${name}` };
  }
}

/** A saved person, with the birth data needed to compute their chart + synastry. */
export interface RelationshipContext {
  name: string;
  relationship: string;
  birth: BirthData;
  /**
   * Compact placement summary from the person's computed chart, e.g. "Sun in
   * Aries, Moon in Cancer, …". Factual ground truth listed in the system
   * prompt; absent when no chart has been computed for them yet.
   */
  placements?: string;
}

/**
 * Lazily-computed, GROUNDED relationship facts for the chat assistant: a saved
 * person's placements, and the deterministic synastry/compatibility between
 * them and the user. Everything returned is computed (Swiss Ephemeris +
 * `scoreCompatibility`), never invented — so the assistant can answer
 * "why is my compatibility with X low?" without fabricating. Charts are
 * computed on demand and cached for the turn (no cost unless actually asked).
 */
class RelationshipTools {
  private readonly chartCache = new Map<string, NatalChart>();

  constructor(
    private readonly selfBirth: BirthData | null,
    private readonly people: RelationshipContext[],
  ) {}

  /** Match a person by name (exact → fuzzy → the only saved person). */
  private find(name: string): RelationshipContext | undefined {
    const n = name.trim().toLowerCase();
    return (
      this.people.find((p) => p.name.toLowerCase() === n) ??
      this.people.find(
        (p) =>
          p.name.toLowerCase().includes(n) || (n.length > 0 && n.includes(p.name.toLowerCase())),
      ) ??
      (this.people.length === 1 ? this.people[0] : undefined)
    );
  }

  private chartFor(p: RelationshipContext): NatalChart {
    let chart = this.chartCache.get(p.name);
    if (!chart) {
      chart = computeNatal(p.birth) as unknown as NatalChart;
      this.chartCache.set(p.name, chart);
    }
    return chart;
  }

  getPersonPlacement(name: string, body: string): unknown {
    const p = this.find(name);
    if (!p) return { error: 'unknown_person', known: this.people.map((x) => x.name) };
    return {
      person: p.name,
      ...((new ChartFactTools(this.chartFor(p)).getPlanet(body) as object) ?? {}),
    };
  }

  getCompatibility(name: string): unknown {
    const p = this.find(name);
    if (!p) return { error: 'unknown_person', known: this.people.map((x) => x.name) };
    if (!this.selfBirth) return { error: 'no_self_birth_data' };
    const synastry = computeSynastry(this.selfBirth, p.birth);
    const compat = scoreCompatibility(synastry.aspects, {
      timeKnownA: this.selfBirth.timeKnown,
      timeKnownB: p.birth.timeKnown,
    });
    return {
      person: p.name,
      relationship: p.relationship,
      score: compat.score,
      band: compat.bandLabel,
      timeLimited: compat.timeLimited,
      domains: compat.domains.map((d) => ({ area: d.label, score: d.score, summary: d.summary })),
      topHarmonies: compat.harmonies.slice(0, 5).map((c) => c.text),
      topFrictions: compat.frictions.slice(0, 5).map((c) => c.text),
    };
  }
}

/** Extra tool specs exposed to the chat assistant when the user has saved people. */
function relationshipToolSpecs(people: RelationshipContext[]): ToolSpec[] {
  if (people.length === 0) return [];
  return [
    {
      name: 'get_compatibility',
      description:
        'Compatibility (synastry) between YOU and a saved person, by their name. Returns an ' +
        'overall score (0-100), a band label, per-domain scores (romantic, emotional, ' +
        'communication, values, long-term), and the strongest harmonious and frictional ' +
        'cross-chart contacts. Use this for ANY question about how you get along with, or your ' +
        'compatibility with, a specific saved person.',
      input_schema: {
        type: 'object',
        properties: { person: { type: 'string', description: "The saved person's name." } },
        required: ['person'],
      },
    },
    {
      name: 'get_person_placement',
      description:
        "A saved person's exact placement for a body (Sun, Moon, Mercury, Venus, Mars, …), by " +
        'their name. Use to ground claims about their chart.',
      input_schema: {
        type: 'object',
        properties: {
          person: { type: 'string', description: "The saved person's name." },
          body: { type: 'string', description: 'Body name, e.g. "Venus".' },
        },
        required: ['person', 'body'],
      },
    },
  ];
}

/**
 * Grounding constraints shared by every report + chat prompt. Each numbered
 * rule is an INVARIANT: facts only from ground truth/tools, tool-fetch when
 * unsure, no house/angle claims without a birth time, no medical/legal/
 * financial directives, and the transparency rule (every substantive claim
 * names the placement/aspect/transit that produces it, in parentheses).
 */
export const GROUNDING_CONSTRAINTS: string = [
  '<constraints>',
  'ABSOLUTE RULES, violating any of these is a critical failure:',
  '1. Chart facts (a body’s sign, degree, house, retrograde state; an aspect and',
  '   its orb; the Ascendant or Midheaven) may come ONLY from the <chart_facts>',
  '   block or a tool result. NEVER state one from memory, inference, or general',
  '   astrology knowledge.',
  '2. Unsure about a fact? CALL A TOOL to fetch it. Never assume, never',
  '   approximate.',
  '3. If <chart_facts> marks the birth time unknown (houses/Ascendant/MC',
  '   unavailable), make NO house-based or angle-based claims at all, omit them',
  '   entirely rather than hedging. If asked directly, say plainly that an exact',
  '   birth time is needed, then offer what the chart DOES support.',
  '4. Interpretation, meaning, themes, advice, is yours to write freely; every',
  '   FACT beneath it must trace to <chart_facts> or a tool result.',
  '5. Never direct the reader to make medical, legal, or financial decisions from',
  '   astrology; point them to a qualified professional for those.',
  '6. TRANSPARENCY: after each substantive claim, name the exact placement,',
  '   aspect, or transit that produces it, in parentheses, e.g. "(Moon square',
  '   Saturn, orb 2.1°)" or "(transiting Jupiter trine natal Sun, exact May 4)".',
  '   A claim you cannot attribute to a named chart fact is a claim you must not',
  '   make.',
  '</constraints>',
].join('\n');

/**
 * Voice spec for long-form reports — warm, specific, second-person,
 * agency-first, zero horoscope-column filler.
 */
export const REPORT_VOICE: string = [
  '<voice>',
  'Write for THIS person, never a sun-sign column:',
  '- Second person throughout ("you", "your"). Never "this person" or "the native".',
  '- Anchor EVERY claim to a specific placement and SAY IT: body, sign, degree,',
  '  house (e.g. "your Moon at 12° Scorpio in the 4th"). Lean on the exact aspects',
  '  and their orbs, they are what make the reading specific.',
  '- Agency-first: frame each placement as what it ASKS of the reader, not what',
  '  will happen to them ("Saturn here asks you to build slowly", never "you will',
  '  be blocked").',
  '- Ground meaning in concrete life domains, work, money, friendship, family,',
  '  love, health habits, creative projects, not abstractions like',
  '  "transformation" or "energies".',
  '- Plain-spoken, warm, lightly literary, calm and non-fatalist. No hype, no',
  '  mysticism filler ("the universe has plans"), and no hedging soup: exactly ONE',
  '  clean modal per claim ("this can…", "you tend to…"), never "perhaps maybe',
  '  possibly".',
  '- Cut any sentence that would read the same for a different chart. If a line is',
  '  not tied to a real placement here, delete it.',
  '</voice>',
].join('\n');

/**
 * Output-format spec shared by the report and chat prompts.
 *
 * Nothing downstream renders Markdown: the mobile app draws answers with React
 * Native `<Text>` and the PDF writer pushes section bodies straight into pdfkit,
 * so a `**` the model emits is shown as two literal asterisks in both. The app
 * ALSO parses Markdown defensively (`apps/mobile/src/features/ai/markdown.ts`)
 * because models regress to it — this section is the first line of defence, that
 * parser is the safety net.
 *
 * Deliberately written WITHOUT any Markdown of its own (no bullets, no
 * asterisks): a prompt that demonstrates the syntax it forbids invites the model
 * to copy it.
 */
export const FORMATTING_SPEC: string = [
  '<formatting>',
  'Write PLAIN PROSE. Your text is rendered as ordinary text, so any Markdown',
  'syntax appears literally on the page and looks broken.',
  'NEVER use: asterisks or underscores for bold/italics, backticks, hash-sign',
  'headings, dash or asterisk bullet lists, numbered lists, tables, or code',
  'fences.',
  'Separate paragraphs with a blank line. That is the only structure available.',
  'Where you would reach for a list, write short consecutive sentences instead.',
  'Emphasis comes from word choice and sentence order, never from punctuation.',
  '</formatting>',
].join('\n');

/** Report-kind intros (the <role> body). Exported for the prompt-guard tests. */
export const REPORT_INTROS: Record<ReportKind, string> = {
  natal: 'You write a complete natal report for the chart below.',
  annual:
    "You write a detailed, MONTH-BY-MONTH annual forecast for the chart below. Each section gives you the REAL exact transits perfecting in that period AND, when available, the REAL directed-profection activations (al-Tabari's day-level timing technique: the profected point moving one sign per year from the equal-house cusp, hitting natal planets/Lots/Egyptian-bound changes on exact dates). Treat ALL of these computed lines as ground truth, name them with their exact dates and day-windows, and tie each to the natal placements. Never invent dates, degrees, or aspects; the precise timing is given to you. Be concrete and specific to each month; never generic.",
  compatibility: 'You write a relationship/compatibility report comparing the charts below.',
};

/** Sectioned report system prompt. Exported for the prompt-guard tests. */
export function systemPrompt(charts: NatalChart[], kind: ReportKind, labels: string[]): string {
  const truth = charts
    .map((c, i) => chart2txt(c, { label: labels[i] ?? `Person ${i + 1}` }))
    .join('\n\n');
  return [
    '<role>',
    `You are AstroApp's astrology report writer. ${REPORT_INTROS[kind]}`,
    '</role>',
    '',
    GROUNDING_CONSTRAINTS,
    '',
    REPORT_VOICE,
    '',
    FORMATTING_SPEC,
    '',
    '<tone_safety>',
    TONE_SAFETY_DIRECTIVE,
    '</tone_safety>',
    '',
    '<chart_facts>',
    truth,
    '</chart_facts>',
  ].join('\n');
}

const MAX_TOOL_ROUNDS = 6;

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Validate model output against MULTIPLE charts (compatibility): a claim is a
 * violation only when it matches NEITHER chart. A compatibility section produces
 * two-chart sentences ("their Moon in Cancer"), so validating every placement
 * against the SELF chart alone wrongly flags the PARTNER's CORRECT placements as
 * hallucinations — inflating `hallucinationsCaught` and appending bogus
 * "[Correction…]" notes. Checking against all charts keeps natal validation
 * intact (single-chart path still uses {@link validateText}) while never
 * false-flagging a partner fact that is true in the second chart.
 */
function validateAgainstCharts(text: string, charts: NatalChart[]): ValidationResult {
  if (charts.length <= 1) {
    const only = charts[0];
    return only ? validateText(text, only) : { claims: [], violations: [], ok: true };
  }
  const toolsByChart = charts.map((c) => new ChartFactTools(c));
  const claims = extractClaims(text).map((claim) => {
    // Prefer a chart the claim VALIDATES against; if none, keep the self-chart
    // verdict (charts[0]) so the surfaced `expected` correction stays sensible.
    let verdict = verifyClaim(claim, toolsByChart[0]!);
    if (!verdict.valid) {
      for (let i = 1; i < toolsByChart.length; i++) {
        const alt = verifyClaim(claim, toolsByChart[i]!);
        if (alt.valid) {
          verdict = alt;
          break;
        }
      }
    }
    return verdict;
  });
  const violations = claims.filter((v) => !v.valid);
  return { claims, violations, ok: violations.length === 0 };
}

/** Run one grounded, validated section generation. */
async function generateSection(
  provider: AIProvider,
  charts: NatalChart[],
  system: string,
  toolSpecs: ToolSpec[],
  toolsByChart: ChartFactTools[],
  prompt: string,
): Promise<{ text: string; validation: ValidationResult }> {
  const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
  let finalContent: ContentBlock[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await provider.chat({ system, messages, tools: toolSpecs, maxTokens: 3072 });
    finalContent = result.content;
    if (result.stopReason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: result.content });
    const toolResults: ContentBlock[] = [];
    for (const block of result.content) {
      if (block.type === 'tool_use') {
        const out = dispatch(toolsByChart, block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out),
        });
      }
    }
    if (toolResults.length === 0) break;
    messages.push({ role: 'user', content: toolResults });
  }

  const raw = extractText(finalContent);
  // Validate against ALL charts: for a single-chart natal/annual section this is
  // exactly `validateText(raw, primary)`; for a compatibility section (two charts)
  // a placement/aspect claim is a violation only when it matches NEITHER chart, so
  // the partner's CORRECT placements ("their Moon in Cancer") are not false-flagged
  // as hallucinations. Keeps natal validation intact.
  const validation = validateAgainstCharts(raw, charts);
  return { text: softenTone(repairText(raw, validation)), validation };
}

/* -------------------------------------------------------------------------- */
/* Conversational interpretation (AI astrologer chat — TASK A8)               */
/* -------------------------------------------------------------------------- */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A person the user has saved, for relationship context. */
export interface PersonContext {
  name: string;
  relationship: string;
  /** Compact placement summary from the person's computed chart (factual ground truth). */
  placements?: string;
}

export interface InterpretationResult {
  text: string;
  toolRounds: number;
  hallucinationsCaught: number;
  validated: boolean;
}

/** Natural-language phrase for a saved person's relationship type. */
function relationshipPhrase(relationship: string): string {
  switch (relationship) {
    case 'partner':
      return 'your partner';
    case 'crush':
      return 'your crush';
    case 'ex':
      return 'your ex';
    case 'family':
      return 'family';
    case 'friend':
      return 'a friend';
    default:
      return 'someone in your life';
  }
}

/** A short, factual block describing the people the user has saved. */
function peopleBlock(people: RelationshipContext[]): string[] {
  if (people.length === 0) {
    return [
      'PEOPLE: the user has not saved anyone else (no partner, crush, ex, friend or',
      'family on record). Do NOT assume they have a relationship, if they ask about',
      "love or a specific person, answer from their chart's capacity for it, and you",
      'may gently note they can add someone to get a synastry reading.',
    ];
  }
  return [
    'PEOPLE IN THEIR LIFE (saved by the user, real; never invent others). The',
    'placements listed for each person are FACTUAL ground truth from their computed',
    'chart, you MAY use them directly when asked about that person, and you must NOT',
    'invent placements for anyone not listed. For any question about how they relate',
    'to / their compatibility with one of these, CALL `get_compatibility(person)` for',
    'the score + key contacts; use `get_person_placement` for any body not already',
    'listed below. NEVER guess a compatibility score:',
    ...people.map((p) => {
      const head = `- ${p.name}, ${relationshipPhrase(p.relationship)}, `;
      return head + (p.placements?.trim() ? p.placements.trim() : 'chart not computed yet');
    }),
  ];
}

/**
 * Upcoming directed-profection activations (al-Tabari) for the next ~90 days,
 * as ground-truth lines for the chat. This is the day-level timing layer: the
 * model must NOT compute it (it would hallucinate dates) — we precompute the
 * exact activations and hand them over so "what's coming up?" answers are
 * concrete. Empty when there's no birth time/date (no Ascendant) — the chat then
 * simply has no precise-timing block.
 */
function directedProfectionChatBlock(chart: NatalChart, selfBirth: BirthData | null): string[] {
  if (!selfBirth?.date) return [];
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const res = directedProfectionsInRange(chart, selfBirth.date, from, to);
  if (!res.available || res.activations.length === 0) return [];
  return [
    'UPCOMING PRECISE TIMING, directed profections (al-Tabari), REAL and computed.',
    'The profected point moves one sign per year from the equal-house cusp; these are',
    'its exact dated activations over roughly the next 90 days. Use THESE dates/windows',
    'verbatim for any "what is coming up / when" question; NEVER invent a date or degree:',
    ...res.activations.slice(0, 12).map((a) => `- ${a.description}`),
  ];
}

/**
 * Chat-specific rules layered ON TOP of {@link GROUNDING_CONSTRAINTS}: voice,
 * the saved-people ground truth, the compatibility tool, and precise timing.
 * Exported for the prompt-guard tests.
 */
export const CHAT_RULES: string = [
  '<chat_rules>',
  '- Be concise and conversational, at most a few short paragraphs. Warm,',
  '  specific, second person; plain-spoken, lightly literary, never a generic',
  '  horoscope.',
  '- Agency-first: frame placements as what they ASK of the user, not what will',
  '  happen to them. Ground meaning in concrete life domains (work, money,',
  '  friendship, family, love, health habits), no mysticism filler, and exactly',
  '  ONE clean modal per claim (never "perhaps maybe possibly").',
  '- NAME the placement behind any claim (body, sign, degree, house) in',
  '  parentheses after the claim. Nothing that would read the same for a',
  '  different chart.',
  '- The <people> list is factual context about their relationships, treat it',
  '  as ground truth too: never invent a partner/ex they have not saved.',
  '- For a compatibility/relationship question about a saved person, CALL',
  '  `get_compatibility(person)` and ground your answer in its score, bands and',
  '  the named harmonious/frictional contacts it returns, explain WHY, never',
  '  invent a number.',
  '- For any "what is coming up / when will X happen / this month" question,',
  '  ground the timing in the <precise_timing> block (directed profections) if',
  '  present; state the exact date(s) and day-window. NEVER invent a date,',
  '  degree, or aspect.',
  '</chat_rules>',
].join('\n');

/**
 * Grounded, chat-flavoured system prompt for the conversational astrologer.
 * Sectioned like the Edge Function's interpreter prompt. `contextSections`
 * optionally appends the bounded <recent_journal>/<sky_today> blocks (see
 * ./contextInjection.ts) — context, never a new source of chart facts.
 * Exported for the prompt-guard tests.
 */
export function chatSystemPrompt(
  chart: NatalChart,
  label?: string,
  people: RelationshipContext[] = [],
  selfBirth: BirthData | null = null,
  contextSections = '',
): string {
  const truth = chart2txt(chart, { label: label ?? 'You' });
  const directedBlock = directedProfectionChatBlock(chart, selfBirth);
  return [
    '<role>',
    "You are AstroApp's astrologer, in conversation with the chart's owner.",
    'Answer their questions about THEIR chart below, grounded, plain-spoken,',
    'never a generic horoscope.',
    '</role>',
    '',
    GROUNDING_CONSTRAINTS,
    '',
    CHAT_RULES,
    '',
    FORMATTING_SPEC,
    '',
    '<tone_safety>',
    TONE_SAFETY_DIRECTIVE,
    '</tone_safety>',
    '',
    '<people>',
    ...peopleBlock(people),
    '</people>',
    ...(directedBlock.length
      ? ['', '<precise_timing>', ...directedBlock, '</precise_timing>']
      : []),
    '',
    '<chart_facts>',
    truth,
    '</chart_facts>',
    ...(contextSections ? ['', contextSections] : []),
  ].join('\n');
}

/**
 * Run ONE grounded, validated conversational turn against the user's chart,
 * with the SAME fact-tool + claim-validation machinery as report sections.
 * `history` carries prior turns so the model keeps in-conversation memory.
 */
export async function interpretChat(
  provider: AIProvider,
  chart: NatalChart,
  prompt: string,
  history: ChatTurn[] = [],
  label?: string,
  relationships: RelationshipContext[] = [],
  selfBirth: BirthData | null = null,
  /**
   * Optional pre-built <recent_journal>/<sky_today> sections — build them with
   * `buildContextSections` from ./contextInjection.ts (which strictly validates
   * client-sent transits and bounds the total size). Context only; the factual
   * validation below is unchanged.
   */
  contextSections = '',
): Promise<InterpretationResult> {
  const system = chatSystemPrompt(chart, label, relationships, selfBirth, contextSections);
  const toolSpecs = [...factToolSpecs([chart]), ...relationshipToolSpecs(relationships)];
  const toolsByChart = [new ChartFactTools(chart)];
  const relTools = new RelationshipTools(selfBirth, relationships);

  const messages: ProviderMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) satisfies ProviderMessage),
    { role: 'user', content: prompt },
  ];
  let finalContent: ContentBlock[] = [];
  let toolRounds = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await provider.chat({ system, messages, tools: toolSpecs, maxTokens: 1024 });
    finalContent = result.content;
    if (result.stopReason !== 'tool_use') break;
    toolRounds++;
    messages.push({ role: 'assistant', content: result.content });
    const toolResults: ContentBlock[] = [];
    for (const block of result.content) {
      if (block.type === 'tool_use') {
        let out: unknown;
        if (block.name === 'get_compatibility') {
          out = relTools.getCompatibility(String(block.input.person ?? ''));
        } else if (block.name === 'get_person_placement') {
          out = relTools.getPersonPlacement(
            String(block.input.person ?? ''),
            String(block.input.body ?? ''),
          );
        } else {
          out = dispatch(toolsByChart, block.name, block.input);
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out),
        });
      }
    }
    if (toolResults.length === 0) break;
    messages.push({ role: 'user', content: toolResults });
  }

  const raw = extractText(finalContent);
  const validation = validateText(raw, chart);
  return {
    // `softenTone` is the DETERMINISTIC half of the D7 tone guard; the prompt
    // directive alone is only a steer. It was applied in the (never-deployed)
    // ai-interpret Edge Function but not here, so the path users actually hit
    // shipped unguarded — and the tone tests assert against that Edge copy, so
    // the suite stayed green.
    text: softenTone(repairText(raw, validation)),
    toolRounds,
    hallucinationsCaught: validation.violations.length,
    validated: validation.violations.length === 0,
  };
}

const SECTION_PLANS: Record<ReportKind, Array<{ heading: string; prompt: string }>> = {
  natal: [
    {
      heading: 'Core Identity',
      prompt:
        'Write the "Core Identity" section: weave together your Sun, Moon and Ascendant. Open by naming each one precisely, sign, degree and house, and what it being THERE (not anywhere else) means for you. Use any aspect between them. 2-3 paragraphs, addressed to "you", every sentence tied to a real placement.',
    },
    {
      heading: 'Mind & Communication',
      prompt:
        'Write the "Mind & Communication" section about your Mercury. Name its exact sign, degree and house, then read it: how you think, learn and talk. Bring in every aspect Mercury makes in your chart (with the orb) and what each does. 2 paragraphs, addressed to "you", specific to this Mercury.',
    },
    {
      heading: 'Love & Values',
      prompt:
        'Write the "Love & Values" section about your Venus and Mars. Name each by sign, degree and house, then read how you love, attract, want and act. Use the aspects between them and to other bodies. 2 paragraphs, addressed to "you", never a generic love horoscope.',
    },
    {
      heading: 'Drive & Growth',
      prompt:
        'Write the "Drive & Growth" section about your Jupiter and Saturn. Name each by sign, degree and house, then read where you expand and find ease (Jupiter) and where you meet limit, structure and the long work (Saturn). Use their aspects. 2 paragraphs, addressed to "you".',
    },
  ],
  annual: [
    {
      heading: 'The Year Ahead',
      prompt:
        'Write a forward-looking annual overview grounded in the natal placements and their themes. 3 paragraphs.',
    },
    {
      heading: 'Focus Areas',
      prompt:
        'Write a "Focus Areas" section highlighting the chart\'s strongest themes for the year. 2 paragraphs.',
    },
  ],
  compatibility: [
    {
      heading: 'Overall Dynamic',
      prompt:
        'Write the "Overall Dynamic" of this relationship. Ground it in named placements from BOTH charts, e.g. "your Sun in X meets their Moon in Y", and the actual cross-chart contacts between them. Name people by their labels. 3 paragraphs, concrete to these two charts, never a generic couple reading.',
    },
    {
      heading: 'Strengths & Friction',
      prompt:
        'Write a "Strengths & Friction" section: name the specific cross-chart aspects that flow (the strengths) and the ones that grip (the friction), citing the two bodies and signs/houses involved in each. 2 paragraphs, concrete and even-handed, addressed to the pair.',
    },
  ],
};

const TITLES: Record<ReportKind, string> = {
  natal: 'Your Complete Natal Report',
  annual: 'Your Annual Forecast',
  compatibility: 'Your Compatibility Report',
};

/**
 * Generate a full, validated report. `charts[0]` is the primary; `charts[1]` (if
 * present) is the partner for compatibility.
 */
export async function generateReport(
  provider: AIProvider,
  charts: NatalChart[],
  kind: ReportKind,
  labels: string[] = [],
  nowIso: string = new Date().toISOString(),
  birthDate?: string,
): Promise<GeneratedReport> {
  if (charts.length === 0) throw new Error('at least one chart is required');
  if (kind === 'compatibility' && charts.length < 2) {
    // Allowed structurally (A9 will pass two); with one we still produce a
    // single-chart "relational tendencies" reading.
  }

  // The annual forecast is month-by-month (13 sections). Generating it section
  // by section would be 13 model calls and exhaust tight provider rate limits
  // (e.g. Gemini free tier = 20 req/day), so it runs as a SINGLE grounded call.
  if (kind === 'annual') {
    return generateAnnualReport(provider, charts[0]!, labels, nowIso, birthDate);
  }

  const toolsByChart = charts.map((c) => new ChartFactTools(c));
  const toolSpecs = factToolSpecs(charts);
  const system = systemPrompt(charts, kind, labels);

  const plan = SECTION_PLANS[kind];

  // PARALLEL, not sequential.
  //
  // Each section is an independent generation: same charts, same system prompt,
  // different section prompt — nothing downstream of one feeds the next. Awaiting
  // them one at a time simply added up their latencies, so a four-section natal
  // report took four model round-trips end to end and routinely ran past a
  // minute. Run together, wall-clock is the SLOWEST single call rather than the
  // sum, at identical cost (the same calls, the same tokens).
  //
  // `allSettled` + index order is what keeps the existing semantics intact: the
  // report's sections must stay in plan order regardless of completion order,
  // and one section failing must still degrade to a placeholder rather than
  // rejecting the whole report.
  const settled = await Promise.allSettled(
    plan.map(async (item) => {
      const { text, validation } = await generateSection(
        provider,
        charts,
        system,
        toolSpecs,
        toolsByChart,
        item.prompt,
      );
      // An empty body (model returned nothing usable — e.g. a safety block or a
      // max_tokens cut with no text) is a failed section, not a silent blank
      // one. Treat it exactly like a thrown failure so `failedSections > 0`
      // drives the client's "not all facts verified" warning.
      if (text.trim().length === 0) {
        throw new Error('section produced no content');
      }
      return { text, validation };
    }),
  );

  const sections: ReportSection[] = [];
  let hallucinationsCaught = 0;
  let failures = 0;
  let lastFailureMessage = '';

  settled.forEach((outcome, index) => {
    const item = plan[index];
    if (!item) return;
    if (outcome.status === 'fulfilled') {
      hallucinationsCaught += outcome.value.validation.violations.length;
      sections.push({
        heading: item.heading,
        body: outcome.value.text,
        validation: outcome.value.validation,
      });
      return;
    }
    // A single section failing (e.g. a transient provider 503 that survived the
    // retry+fallback) shouldn't sink the whole report. Emit a graceful
    // placeholder and keep the rest; only fail if EVERY section failed. Log the
    // cause so the all-sections-failed throw can surface WHY.
    failures++;
    const reason: unknown = outcome.reason;
    lastFailureMessage = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[reportInterpreter] section "${item.heading}" failed:`, lastFailureMessage);
    sections.push({
      heading: item.heading,
      body: 'This section could not be generated right now, the astrology engine was briefly busy. Open the report again in a little while to regenerate it.',
      validation: { claims: [], violations: [], ok: true },
    });
  });

  if (failures === plan.length) {
    throw new Error(
      `Every report section failed to generate (the AI service is busy). Last error: ${lastFailureMessage || 'unknown'}`,
    );
  }

  return { kind, title: TITLES[kind], sections, hallucinationsCaught, failedSections: failures };
}
