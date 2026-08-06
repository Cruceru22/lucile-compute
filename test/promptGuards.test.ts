/**
 * Prompt-guard tests for the report/chat interpreter prompts (string-contains
 * structural invariants — the repo's convention for prompt guards).
 *
 * These lock in the promises the prompts make:
 *   * grounding — facts only from <chart_facts>/tools, tool-fetch when unsure,
 *     no house/angle claims for unknown birth times, no medical/legal/financial
 *     directives;
 *   * transparency — every substantive claim names its producing placement/
 *     aspect/transit in parentheses (the product's moat);
 *   * voice — second person, agency-first, concrete, no mysticism, ONE modal
 *     per claim;
 *   * tone safety — the D7 directive is embedded verbatim;
 *   * context injection — the chat prompt carries <recent_journal>/<sky_today>
 *     sections when provided, and never invents them when not.
 */
import { TONE_SAFETY_DIRECTIVE, type NatalChart } from '@astroapp/ai-grounding';
import { describe, expect, it } from 'vitest';

import { buildContextSections, validateTodayContext } from '../src/ai/contextInjection.js';
import {
  CHAT_RULES,
  chatSystemPrompt,
  FORMATTING_SPEC,
  GROUNDING_CONSTRAINTS,
  REPORT_INTROS,
  REPORT_VOICE,
  systemPrompt,
} from '../src/ai/reportInterpreter.js';

const CHART: NatalChart = {
  planets: [
    { name: 'Sun', sign: 'Leo', degree: 12.5, absoluteDegree: 132.5, house: 5, retrograde: false },
    {
      name: 'Moon',
      sign: 'Cancer',
      degree: 3.2,
      absoluteDegree: 93.2,
      house: 4,
      retrograde: false,
    },
  ],
  houses: [{ number: 1, cuspDegree: 200.0, sign: 'Libra' }],
  aspects: [{ a: 'Sun', b: 'Moon', type: 'sextile', orb: 4.0, applying: false }],
  ascendant: 200.0,
  midheaven: 110.0,
  houseSystem: 'placidus',
  computedAt: '2026-06-15T00:00:00.000Z',
  timeKnown: true,
  housesAvailable: true,
};

describe('GROUNDING_CONSTRAINTS invariants (reports + chat share them)', () => {
  it('keeps the no-external-facts and tool-fetch rules', () => {
    expect(GROUNDING_CONSTRAINTS).toContain('may come ONLY from the <chart_facts>');
    expect(GROUNDING_CONSTRAINTS).toContain('NEVER state one from memory');
    expect(GROUNDING_CONSTRAINTS).toContain('CALL A TOOL');
  });

  it('keeps the unknown-birth-time and professional-referral rules', () => {
    expect(GROUNDING_CONSTRAINTS).toContain('birth time unknown');
    expect(GROUNDING_CONSTRAINTS).toContain('NO house-based or angle-based claims');
    expect(GROUNDING_CONSTRAINTS).toMatch(/medical, legal, or financial/);
  });

  it('keeps the transparency rule (name the producing aspect in parentheses)', () => {
    expect(GROUNDING_CONSTRAINTS).toContain('TRANSPARENCY');
    expect(GROUNDING_CONSTRAINTS).toContain('in parentheses');
  });
});

describe('REPORT_VOICE invariants', () => {
  it('is second person, agency-first, concrete, mysticism-free, one modal per claim', () => {
    expect(REPORT_VOICE).toContain('Second person');
    expect(REPORT_VOICE).toContain('Agency-first');
    expect(REPORT_VOICE).toContain('concrete life domains');
    expect(REPORT_VOICE).toContain('mysticism filler');
    expect(REPORT_VOICE).toContain('ONE');
    expect(REPORT_VOICE).toContain('clean modal per claim');
    expect(REPORT_VOICE).toContain('would read the same for a different chart');
  });
});

describe('FORMATTING_SPEC invariants (reports + chat share them)', () => {
  it('demands plain prose and names the Markdown constructs it forbids', () => {
    expect(FORMATTING_SPEC).toContain('Write PLAIN PROSE');
    expect(FORMATTING_SPEC).toContain('asterisks or underscores for bold/italics');
    expect(FORMATTING_SPEC).toContain('backticks');
    expect(FORMATTING_SPEC).toContain('bullet lists');
    expect(FORMATTING_SPEC).toContain('Separate paragraphs with a blank line');
  });

  it('never demonstrates the Markdown it forbids', () => {
    // A prompt that shows `**` or a `- ` bullet teaches the model to emit them.
    expect(FORMATTING_SPEC).not.toMatch(/\*|`|^#|^- /m);
  });
});

describe('report systemPrompt assembly', () => {
  it('embeds role, constraints, voice, formatting, tone safety and the ground truth', () => {
    for (const kind of ['natal', 'annual', 'compatibility'] as const) {
      const prompt = systemPrompt([CHART], kind, ['Ana']);
      expect(prompt).toContain(REPORT_INTROS[kind]);
      expect(prompt).toContain(GROUNDING_CONSTRAINTS);
      expect(prompt).toContain(REPORT_VOICE);
      expect(prompt).toContain(FORMATTING_SPEC);
      expect(prompt).toContain(TONE_SAFETY_DIRECTIVE);
      expect(prompt).toContain('<chart_facts>');
      expect(prompt).toContain('GROUND-TRUTH CHART: Ana');
    }
  });

  it('annual intro keeps the computed-timing ground-truth contract', () => {
    expect(REPORT_INTROS.annual).toContain('Never invent dates, degrees, or aspects');
    expect(REPORT_INTROS.annual).toContain('directed-profection');
  });
});

describe('chatSystemPrompt assembly', () => {
  it('embeds constraints, chat rules, tone safety, people and ground truth', () => {
    const prompt = chatSystemPrompt(CHART, 'Ana');
    expect(prompt).toContain(GROUNDING_CONSTRAINTS);
    expect(prompt).toContain(CHAT_RULES);
    expect(prompt).toContain(FORMATTING_SPEC);
    expect(prompt).toContain(TONE_SAFETY_DIRECTIVE);
    expect(prompt).toContain('<people>');
    expect(prompt).toContain('<chart_facts>');
    expect(prompt).toContain('GROUND-TRUTH CHART: Ana');
    // No saved people → the model is told not to invent relationships.
    expect(prompt).toContain('Do NOT assume they have a relationship');
  });

  it('keeps the compatibility-tool and precise-timing rules', () => {
    expect(CHAT_RULES).toContain('get_compatibility');
    expect(CHAT_RULES).toContain('never');
    expect(CHAT_RULES).toContain('invent a number');
    expect(CHAT_RULES).toContain('NEVER invent a date');
    expect(CHAT_RULES).toContain('<precise_timing>');
  });

  it('appends validated context sections after the chart facts', () => {
    const sky = validateTodayContext(
      [
        {
          transitingPlanet: 'Saturn',
          aspect: 'square',
          natalPlanet: 'Moon',
          exactAt: new Date().toISOString(),
          orb: 0.4,
        },
      ],
      Date.now(),
    );
    const sections = buildContextSections(
      [{ entry_date: '2026-06-30', mood: 4, transit_ref: null, body: 'Long day, but good.' }],
      sky,
    );
    const prompt = chatSystemPrompt(CHART, 'Ana', [], null, sections);
    expect(prompt).toContain('<sky_today>');
    expect(prompt).toContain('<recent_journal>');
    expect(prompt.indexOf('<sky_today>')).toBeGreaterThan(prompt.indexOf('</chart_facts>'));

    const bare = chatSystemPrompt(CHART, 'Ana');
    expect(bare).not.toContain('<sky_today>');
    expect(bare).not.toContain('<recent_journal>');
  });
});

describe('monthly actionable-suggestion rule (annual report)', () => {
  it('the per-month prompt template demands one actionable, transit-grounded suggestion', async () => {
    // The month prompts are built inside generateAnnualReport; guard the rule
    // at the source-text level so a rewrite cannot silently drop it.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/ai/reportInterpreter.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('ONE actionable, mundane suggestion');
    expect(source).toContain('tied to the named transit');
  });
});
