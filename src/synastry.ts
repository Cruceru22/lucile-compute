/**
 * Synastry: inter-chart aspects between two people's natal bodies.
 * Every body of person A is compared against every body of person B.
 */
import type { Aspect, BirthData, PlanetName } from '@astroapp/shared';
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
