/**
 * The chat's context for CONNECTED FRIENDS.
 *
 * Every other surface in the app can read an accepted friend's chart, but the
 * astrologer could not: it was given only the people the user had saved
 * themselves, so "how do I get on with Maria?" was answered with "you have not
 * added Maria" about someone sitting on the People tab. These lock in the two
 * halves of the fix.
 *
 *   * `synastryFromCharts` — synastry from two COMPUTED charts, because a
 *     friend shares their chart and never their birth date, time or place;
 *   * `chatSystemPrompt` — friends appear in <people> as friends, and a FAILED
 *     read says so instead of asserting the user knows nobody.
 */
import { describe, expect, it } from 'vitest';

import type { NatalChart, Planet, PlanetName } from '@astroapp/shared';

import { chatSystemPrompt, type RelationshipContext } from '../src/ai/reportInterpreter.js';
import { synastryFromCharts } from '../src/synastry.js';

function planet(name: PlanetName, absoluteDegree: number, speed?: number): Planet {
  return {
    name,
    sign: 'Aries',
    degree: absoluteDegree % 30,
    absoluteDegree,
    house: 1,
    retrograde: false,
    ...(speed === undefined ? {} : { speed }),
  };
}

function chartOf(planets: Planet[], extra: Partial<NatalChart> = {}): NatalChart {
  return {
    planets,
    houses: [],
    aspects: [],
    ascendant: null,
    midheaven: null,
    houseSystem: 'placidus',
    computedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('synastryFromCharts', () => {
  it('finds cross-chart aspects from the two charts’ stored positions', () => {
    const mine = chartOf([planet('Sun', 10)]);
    const theirs = chartOf([planet('Moon', 12), planet('Mars', 190)]);

    const { aspects } = synastryFromCharts(mine, theirs);

    expect(aspects).toHaveLength(2);
    const conjunction = aspects.find((a) => a.b === 'Moon');
    expect(conjunction).toMatchObject({ a: 'Sun', b: 'Moon', type: 'conjunction' });
    expect(conjunction?.orb).toBeCloseTo(2, 6);
    expect(aspects.find((a) => a.b === 'Mars')).toMatchObject({ type: 'opposition' });
  });

  it('reports `applying` only when BOTH bodies carry a speed', () => {
    const withoutSpeed = synastryFromCharts(
      chartOf([planet('Sun', 10)]),
      chartOf([planet('Moon', 12)]),
    );
    expect(withoutSpeed.aspects[0]?.applying).toBe(false);

    // The Moon at 12° closing on the Sun at 10° is separating, not applying —
    // a real answer rather than the false we fall back to without speeds.
    const withSpeed = synastryFromCharts(
      chartOf([planet('Sun', 10, 1)]),
      chartOf([planet('Moon', 12, 13)]),
    );
    expect(withSpeed.aspects[0]?.applying).toBe(false);

    // Reverse the motion and the same pair is closing.
    const closing = synastryFromCharts(
      chartOf([planet('Sun', 10, 1)]),
      chartOf([planet('Moon', 12, -13)]),
    );
    expect(closing.aspects[0]?.applying).toBe(true);
  });

  it('never reads a birth field: it takes charts, not birth data', () => {
    // A chart with no planets yields no aspects rather than throwing — the
    // friend simply has nothing computed to compare against.
    expect(synastryFromCharts(chartOf([]), chartOf([planet('Sun', 10)])).aspects).toEqual([]);
  });
});

const SELF = chartOf([planet('Sun', 132.5)]);

describe('chatSystemPrompt — connected friends in <people>', () => {
  const friend: RelationshipContext = {
    source: 'connection',
    name: 'Maria',
    relationship: 'connection',
    chart: chartOf([planet('Venus', 20)]),
    placements: 'Sun in Aries, Moon in Cancer',
  };

  it('lists a connected friend as a friend, with their placements', () => {
    const prompt = chatSystemPrompt(SELF, 'Ana', [friend]);
    expect(prompt).toContain('Maria');
    expect(prompt).toContain('a friend connected to them in the app');
    expect(prompt).toContain('Sun in Aries, Moon in Cancer');
    expect(prompt).toContain('connected to them in the app');
  });

  it('says the friend list may be incomplete when the read FAILED', () => {
    const prompt = chatSystemPrompt(SELF, 'Ana', [friend], null, '', { friendsUnreadable: true });
    expect(prompt).toContain('could not be read this turn');
    expect(prompt).toContain('NEVER tell');
  });

  it('with no people AND a failed read, never claims the user has saved nobody', () => {
    const blind = chatSystemPrompt(SELF, 'Ana', [], null, '', { friendsUnreadable: true });
    expect(blind).not.toContain('has not saved anyone else');
    expect(blind).toContain('the read failed');

    // The healthy empty case still tells the model not to invent a relationship.
    const empty = chatSystemPrompt(SELF, 'Ana', []);
    expect(empty).toContain('Do NOT assume they have a relationship');
  });
});
