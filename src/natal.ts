/**
 * Natal chart computation.
 */
import type { Ayanamsa, BirthData, NatalChart, Zodiac } from '@astroapp/shared';
import {
  computeAllBodiesWithMisses,
  computeAspects,
  computeHouses,
  toHouses,
  toPlanet,
} from './astro.js';
import type { PlanetName } from '@astroapp/shared';
import { resolveBirthInstant } from './time.js';
import {
  ayanamsaDegrees,
  calcFlags,
  getBackend,
  houseFlags,
  siderealCalcFlags,
  siderealHouseFlags,
  withSidereal,
  type EphemerisBackend,
} from './ephemeris.js';

/**
 * The compute service's natal response. Extends the shared {@link NatalChart}
 * with metadata fields that the shared type does not (yet) carry:
 *
 * - `timeKnown` / `housesAvailable`: when the birth time is unknown we omit
 *   houses/Asc/MC (they are unreliable) and flag it here.
 * - `usedNoonFallback`: positions were computed for local noon.
 * - `preTzDatabaseEra`: birth predates reliable tz-database coverage (~1970).
 * - `ephemerisBackend`: 'swiss' (.se1 files) or 'moshier' (built-in).
 * - `unavailableBodies`: bodies omitted because the active backend lacks them
 *   (e.g. Chiron under Moshier; needs Swiss `seas_*.se1` files).
 * - `houseSystemDegraded`: the requested time-based house system (Placidus/Koch)
 *   is degenerate at this latitude (beyond the polar circle); the Asc/MC are
 *   still valid but the cusp division is a fallback. False for normal charts.
 *
 * These are additive wrapper fields; see report for shared-type reconciliation.
 */
export interface NatalChartResponse extends NatalChart {
  timeKnown: boolean;
  housesAvailable: boolean;
  usedNoonFallback: boolean;
  preTzDatabaseEra: boolean;
  ephemerisBackend: EphemerisBackend;
  unavailableBodies: PlanetName[];
  houseSystemDegraded: boolean;
  /** Zodiac frame the chart was computed in (`tropical` by default). */
  zodiac: Zodiac;
  /** Ayanamsa model used (only meaningful for `sidereal`). */
  ayanamsa: Ayanamsa;
  /** Ayanamsa offset applied, in degrees (0 for tropical). For transparency. */
  ayanamsaDegrees: number;
}

/**
 * Compute a full natal chart from birth data.
 *
 * Tropical (the default when `birth.zodiac` is absent or `'tropical'`) is
 * computed exactly as before — it never touches the global sidereal state.
 * Sidereal sets the sid mode for the duration of the calc (planets + houses use
 * `SEFLG_SIDEREAL`, so both longitudes AND the Asc/MC/cusps are sidereal) and
 * always resets the global state afterwards via {@link withSidereal}.
 */
export function computeNatal(birth: BirthData): NatalChartResponse {
  const { resolved, usedNoonFallback } = resolveBirthInstant(
    birth.date,
    birth.time,
    birth.timeKnown,
    birth.tzIana,
  );

  const zodiac: Zodiac = birth.zodiac ?? 'tropical';
  const ayanamsa: Ayanamsa = birth.ayanamsa ?? 'lahiri';
  const housesAvailable = birth.timeKnown;

  const compute = (): {
    bodies: ReturnType<typeof computeAllBodiesWithMisses>;
    cusps: number[] | null;
    ascendant: number;
    midheaven: number;
    houseSystemDegraded: boolean;
  } => {
    const sidereal = zodiac === 'sidereal';
    const planetFlags = sidereal ? siderealCalcFlags() : calcFlags();
    const hFlags = sidereal ? siderealHouseFlags() : houseFlags();

    const bodies = computeAllBodiesWithMisses(resolved.jdUt, planetFlags);

    let cusps: number[] | null = null;
    let ascendant = 0;
    let midheaven = 0;
    let houseSystemDegraded = false;
    if (housesAvailable) {
      const h = computeHouses(resolved.jdUt, birth.lat, birth.lon, birth.houseSystem, hFlags);
      cusps = h.cusps;
      ascendant = h.ascendant;
      midheaven = h.midheaven;
      houseSystemDegraded = h.degraded;
    }
    return { bodies, cusps, ascendant, midheaven, houseSystemDegraded };
  };

  // Sidereal runs inside `withSidereal` so the global sid mode is set for the
  // calc and reset to tropical afterwards (request isolation). Tropical runs
  // directly — no sidereal state is ever touched.
  const result = zodiac === 'sidereal' ? withSidereal(ayanamsa, compute) : compute();

  const { bodies: bodiesResult, cusps, ascendant, midheaven, houseSystemDegraded } = result;
  const { positions: bodies, unavailable } = bodiesResult;
  const aspects = computeAspects(bodies);

  const planets = bodies.map((b) => toPlanet(b, cusps));
  const houses = cusps ? toHouses(cusps) : [];

  return {
    planets,
    houses,
    aspects,
    ascendant,
    midheaven,
    houseSystem: birth.houseSystem,
    computedAt: new Date().toISOString(),
    timeKnown: birth.timeKnown,
    housesAvailable,
    usedNoonFallback,
    preTzDatabaseEra: resolved.preTzDatabaseEra,
    ephemerisBackend: getBackend(),
    unavailableBodies: unavailable,
    houseSystemDegraded,
    zodiac,
    ayanamsa,
    ayanamsaDegrees: zodiac === 'sidereal' ? ayanamsaDegrees(resolved.jdUt, ayanamsa) : 0,
  };
}
