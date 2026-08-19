/**
 * Synastry: inter-chart aspects between two people's natal bodies.
 * Every body of person A is compared against every body of person B.
 */
import type { Aspect, BirthData, NatalChart, PlanetName } from '@astroapp/shared';
import { isApplying, matchAspect, type BodyPosition } from './astro.js';
import { computeAllBodies } from './astro.js';
import { resolveBirthInstant } from './time.js';

/**
 * A synastry aspect. `a` is person A's body, `b` is person B's body. We reuse
 * the shared {@link Aspect} shape but document the cross-chart semantics here.
 */
export type SynastryAspect = Aspect;

export interface SynastryResult {
  aspects: SynastryAspect[];
}

function bodiesFor(birth: BirthData): BodyPosition[] {
  const { resolved } = resolveBirthInstant(birth.date, birth.time, birth.timeKnown, birth.tzIana);
  return computeAllBodies(resolved.jdUt);
}

/**
 * Compute synastry aspects: A's planets (field `a`) vs B's planets (field `b`).
 * Unlike intra-chart aspects, the full cross product is considered (including
 * same-named bodies, e.g. A.Sun–B.Moon and A.Sun–B.Sun).
 */
export function computeSynastry(personA: BirthData, personB: BirthData): SynastryResult {
  const aBodies = bodiesFor(personA);
  const bBodies = bodiesFor(personB);
  const aspects: SynastryAspect[] = [];

  for (const a of aBodies) {
    for (const b of bBodies) {
      const m = matchAspect(a.absoluteDegree, b.absoluteDegree);
      if (!m) continue;
      aspects.push({
        a: a.name as PlanetName,
        b: b.name as PlanetName,
        type: m.type,
        orb: m.orb,
        applying: isApplying(a.absoluteDegree, a.speed, b.absoluteDegree, b.speed, m.type),
      });
    }
  }

  return { aspects };
}

/**
 * Synastry between two ALREADY-COMPUTED charts, read from each body's stored
 * `absoluteDegree` instead of recomputing it from a birth instant.
 *
 * This exists for a CONNECTED FRIEND. The app shares a friend's computed chart
 * through the accepted-connection consent gate and deliberately never shares
 * their birth date, time or place, so {@link computeSynastry} — which needs both
 * birth instants — cannot run for them. Same cross product, same orbs; the only
 * thing lost is `applying`, which needs both bodies' daily motion: charts carry
 * `speed` only when the backend supplied it, so it is reported false unless BOTH
 * speeds are present rather than guessed. `scoreCompatibility` does not read
 * `applying`, so a connection scores on the same footing as a saved person.
 */
export function synastryFromCharts(chartA: NatalChart, chartB: NatalChart): SynastryResult {
  const aspects: SynastryAspect[] = [];
  for (const a of chartA.planets) {
    for (const b of chartB.planets) {
      const m = matchAspect(a.absoluteDegree, b.absoluteDegree);
      if (!m) continue;
      const applying =
        typeof a.speed === 'number' && typeof b.speed === 'number'
          ? isApplying(a.absoluteDegree, a.speed, b.absoluteDegree, b.speed, m.type)
          : false;
      aspects.push({ a: a.name, b: b.name, type: m.type, orb: m.orb, applying });
    }
  }
  return { aspects };
}
