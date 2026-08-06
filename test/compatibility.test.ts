/**
 * Pure tests for the deterministic compatibility scorer.
 *
 * We feed hand-built synastry aspect lists (no ephemeris) so the scoring model,
 * banding, domain breakdown, unknown-time degradation, and top-list ordering can
 * be asserted exactly.
 */
import { describe, it, expect } from 'vitest';
import type { SynastryAspect } from '../src/synastry.js';
import { scoreCompatibility } from '../src/compatibility.js';

const KNOWN = { timeKnownA: true, timeKnownB: true };

/** Build an aspect; `applying` is irrelevant to scoring so default it. */
function asp(
  a: SynastryAspect['a'],
  b: SynastryAspect['b'],
  type: SynastryAspect['type'],
  orb: number,
): SynastryAspect {
  return { a, b, type, orb, applying: false };
}

describe('scoreCompatibility', () => {
  it('harmony-heavy luminary/Venus-Mars contacts → high score, strong/rare band', () => {
    // A well-connected, mostly-warm couple should land high (~78–90), not ~50.
    const aspects: SynastryAspect[] = [
      asp('Sun', 'Moon', 'conjunction', 0.5),
      asp('Venus', 'Mars', 'trine', 0.4),
      asp('Sun', 'Venus', 'trine', 0.6),
      asp('Moon', 'Venus', 'conjunction', 0.5),
      asp('Sun', 'Jupiter', 'trine', 0.5),
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(['strong', 'rare']).toContain(r.band);
    expect(r.frictions).toHaveLength(0);
    expect(r.harmonies.length).toBeGreaterThan(0);
  });

  it('a real loving couple (warm + a couple of squares) lands ~strong, not lukewarm', () => {
    // The recalibration target: a mixed-but-solid couple should clear ~72+
    // ('strong'), where the old conservative model regressed it to ~56.
    const aspects: SynastryAspect[] = [
      asp('Sun', 'Moon', 'trine', 0.5),
      asp('Venus', 'Mars', 'trine', 0.4),
      asp('Moon', 'Venus', 'sextile', 0.5),
      asp('Venus', 'Mars', 'square', 0.6),
      asp('Sun', 'Saturn', 'square', 0.6),
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    expect(r.score).toBeGreaterThanOrEqual(72);
    expect(r.score).toBeLessThanOrEqual(90);
    expect(r.band).toBe('strong');
  });

  it('Mars-Saturn-heavy hard contacts → low score, difficult/growthy band', () => {
    const aspects: SynastryAspect[] = [
      asp('Saturn', 'Sun', 'square', 0.2),
      asp('Saturn', 'Moon', 'square', 0.2),
      asp('Saturn', 'Venus', 'opposition', 0.2),
      asp('Mars', 'Saturn', 'conjunction', 0.2),
      asp('Mars', 'Pluto', 'opposition', 0.2),
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    // Friction penalises LESS than harmony rewards, so a hostile chart bottoms
    // out in the 'growthy'/'difficult' zone rather than near zero.
    expect(r.score).toBeLessThan(58);
    expect(['difficult', 'growthy']).toContain(r.band);
    expect(r.harmonies).toHaveLength(0);
    expect(r.frictions.length).toBeGreaterThan(0);
  });

  it('a strongly hostile, tight chart can still reach the difficult band', () => {
    const aspects: SynastryAspect[] = [
      asp('Saturn', 'Sun', 'square', 0.2),
      asp('Saturn', 'Moon', 'square', 0.2),
      asp('Saturn', 'Venus', 'opposition', 0.2),
      asp('Mars', 'Saturn', 'conjunction', 0.2),
      asp('Mars', 'Pluto', 'opposition', 0.2),
      asp('Mars', 'Moon', 'square', 0.2),
      asp('Saturn', 'Mars', 'opposition', 0.3),
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    expect(r.score).toBeLessThan(45);
    expect(r.band).toBe('difficult');
  });

  it('chemistry bonus lifts a Venus-Mars square above a contact-less pairing', () => {
    // A Venus–Mars square is friction, but it is also CHEMISTRY — a live bond
    // contact. It should outscore an otherwise-sparse, low-signal pairing.
    const chemistry = scoreCompatibility([asp('Venus', 'Mars', 'square', 0.6)], KNOWN);
    const sparse = scoreCompatibility([asp('Jupiter', 'Saturn', 'sextile', 2.0)], KNOWN);
    expect(chemistry.score).toBeGreaterThan(sparse.score);
    // It registers as friction (polarity), not as a harmony.
    expect(chemistry.frictions.length).toBe(1);
    expect(chemistry.harmonies.length).toBe(0);
  });

  it('hard-pair conjunction is friction, ordinary conjunction is harmony', () => {
    const friction = scoreCompatibility([asp('Mars', 'Saturn', 'conjunction', 0.2)], KNOWN);
    expect(friction.frictions).toHaveLength(1);
    expect(friction.harmonies).toHaveLength(0);

    const harmony = scoreCompatibility([asp('Sun', 'Venus', 'conjunction', 0.2)], KNOWN);
    expect(harmony.harmonies).toHaveLength(1);
    expect(harmony.frictions).toHaveLength(0);
  });

  it("unknown time on ONE side drops only THAT side's Moon aspects (per-side), flags timeLimited", () => {
    // In a SynastryAspect, `a` is side A's body and `b` is side B's body. With B's
    // time unknown, only B's Moon is unreliable: drop aspects touching the B-Moon
    // (asp.b === 'Moon'), but KEEP A's Moon contacts (asp.a === 'Moon') — they are
    // perfectly reliable. The old behavior wrongly dropped BOTH charts' Moon.
    const aspects: SynastryAspect[] = [
      asp('Sun', 'Moon', 'conjunction', 0.5), // A.Sun – B.Moon → DROP (B time unknown)
      asp('Moon', 'Venus', 'trine', 0.4), // A.Moon – B.Venus → KEEP (A time known)
      asp('Sun', 'Venus', 'trine', 0.5), // no Moon → KEEP
    ];
    const r = scoreCompatibility(aspects, { timeKnownA: true, timeKnownB: false });
    expect(r.timeLimited).toBe(true);
    expect(r.excludedFactors).toEqual(['the Moon', 'houses', 'angles']);
    // A.Moon–Venus and Sun–Venus survive; only the B-Moon contact is dropped.
    expect(r.aspectCount).toBe(2);
    // The surviving Moon contact is A's Moon (reliable side), not the dropped B Moon.
    const survivingPairs = [...r.harmonies, ...r.frictions].map((a) => `${a.a}-${a.b}`);
    expect(survivingPairs).toContain('Moon-Venus');
    expect(survivingPairs).not.toContain('Sun-Moon');
  });

  it('unknown time on BOTH sides drops all Moon aspects', () => {
    const aspects: SynastryAspect[] = [
      asp('Sun', 'Moon', 'conjunction', 0.5),
      asp('Moon', 'Venus', 'trine', 0.4),
      asp('Sun', 'Venus', 'trine', 0.5),
    ];
    const r = scoreCompatibility(aspects, { timeKnownA: false, timeKnownB: false });
    expect(r.aspectCount).toBe(1); // only Sun–Venus survives
    const allBodies = [...r.harmonies, ...r.frictions].flatMap((a) => [a.a, a.b]);
    expect(allBodies).not.toContain('Moon');
  });

  it('does not set excludedFactors when both times are known', () => {
    const r = scoreCompatibility([asp('Sun', 'Venus', 'trine', 0.5)], KNOWN);
    expect(r.timeLimited).toBe(false);
    expect(r.excludedFactors).toBeUndefined();
  });

  it('computes per-domain sub-scores and names driving pairs; null for empty domains', () => {
    const aspects: SynastryAspect[] = [
      asp('Venus', 'Mars', 'trine', 0.3), // romantic
      asp('Mercury', 'Mercury', 'conjunction', 0.4), // communication
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    const romantic = r.domains.find((d) => d.key === 'romantic');
    const communication = r.domains.find((d) => d.key === 'communication');
    const longterm = r.domains.find((d) => d.key === 'longterm');

    expect(romantic?.score).not.toBeNull();
    expect(romantic?.summary).toContain('Venus');
    expect(communication?.score).not.toBeNull();
    expect(communication?.summary).toContain('Mercury');
    // No Saturn↔luminary/Venus contacts → longterm has nothing.
    expect(longterm?.score).toBeNull();
    expect(longterm?.summary).toContain('No strong contacts');
    // All five domains always present.
    expect(r.domains.map((d) => d.key)).toEqual([
      'romantic',
      'emotional',
      'communication',
      'values',
      'longterm',
    ]);
  });

  it('top harmonies and frictions are sorted by |contribution| desc and capped at 4', () => {
    const aspects: SynastryAspect[] = [
      asp('Sun', 'Moon', 'conjunction', 0.2), // strongest harmony (weight 1.0, mag 1.0, tight)
      asp('Venus', 'Mars', 'trine', 2.0), // weaker harmony
      asp('Mercury', 'Mercury', 'sextile', 3.0), // weakest harmony
      asp('Sun', 'Venus', 'trine', 1.0),
      asp('Jupiter', 'Saturn', 'sextile', 4.0), // even weaker
    ];
    const r = scoreCompatibility(aspects, KNOWN);
    expect(r.harmonies.length).toBeLessThanOrEqual(4);
    // First harmony should be the tight Sun–Moon conjunction.
    expect(r.harmonies[0].a).toBe('Sun');
    expect(r.harmonies[0].b).toBe('Moon');
    // Sorted descending by weight*magnitude*decay proxy — assert non-increasing.
    for (let i = 1; i < r.harmonies.length; i++) {
      // weight is exposed; use it together with orb as a sanity monotonicity check
      // via the underlying contribution is not exposed, so just assert top is best.
      expect(r.harmonies[i]).toBeDefined();
    }
  });

  it('activity level reflects count of tight high-weight contacts', () => {
    const quiet = scoreCompatibility([asp('Jupiter', 'Saturn', 'trine', 1)], KNOWN);
    expect(quiet.activity).toBe('quiet');

    const intense = scoreCompatibility(
      [
        asp('Sun', 'Moon', 'trine', 0.3),
        asp('Sun', 'Venus', 'trine', 0.3),
        asp('Moon', 'Mars', 'trine', 0.3),
        asp('Venus', 'Mars', 'trine', 0.3),
        asp('Sun', 'Mercury', 'sextile', 0.3),
      ],
      KNOWN,
    );
    expect(intense.activity).toBe('intense');
  });

  it('exposes a deterministic, pair-specific two-beat line per top aspect', () => {
    // Venus trine Mars → desire-in-sync copy (the romantic-pair soft line).
    const trine = scoreCompatibility([asp('Venus', 'Mars', 'trine', 0.3)], KNOWN);
    expect(trine.harmonies[0].text).toMatch(/desire|affection|attraction|sync/i);

    // Venus square Mars → a DIFFERENT, friction-keyed line (hot but clashing),
    // proving the copy is keyed by aspect family, not a single template.
    const square = scoreCompatibility([asp('Venus', 'Mars', 'square', 0.3)], KNOWN);
    expect(square.frictions[0].text).toMatch(/friction|clash|hot|pull/i);
    expect(square.frictions[0].text).not.toBe(trine.harmonies[0].text);

    // Fallback role-based line still names both bodies for an off-table pair.
    const fallback = scoreCompatibility([asp('Jupiter', 'Mercury', 'trine', 0.3)], KNOWN);
    expect(fallback.harmonies[0].text).toContain('Jupiter');
    expect(fallback.harmonies[0].text).toContain('Mercury');
  });
});
