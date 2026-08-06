/**
 * Swiss Ephemeris backend setup.
 *
 * We use the native `sweph` binding (Swiss Ephemeris 2.10). By default we
 * compute with the built-in **Moshier** analytical ephemeris (no data files
 * required), which keeps the service runnable everywhere. When real Swiss
 * Ephemeris `.se1` files are available, point `SWEPH_PATH` (or `EPHE_PATH`) at
 * the directory and we switch to full **Swiss** precision automatically.
 *
 * See README "Ephemeris files" + "License" for how to obtain `.se1` files and
 * the licensing implications of shipping them.
 */
import { existsSync } from 'node:fs';
import type { Ayanamsa } from '@astroapp/shared';
import * as sweph from 'sweph';

const { constants } = sweph;

/** Which ephemeris backend is active for this process. */
export type EphemerisBackend = 'swiss' | 'moshier';

let activeBackend: EphemerisBackend = 'moshier';
let initialised = false;

/**
 * Resolve the ephemeris-files directory from env, if configured.
 * `SWEPH_PATH` takes precedence over `EPHE_PATH`.
 */
function resolveEphePath(): string | undefined {
  const p = process.env.SWEPH_PATH ?? process.env.EPHE_PATH;
  if (p && p.trim().length > 0) return p.trim();
  return undefined;
}

/**
 * Initialise the Swiss Ephemeris exactly once. Safe to call repeatedly.
 * If an ephemeris directory is configured and exists, we register it and use
 * the Swiss backend; otherwise we fall back to Moshier.
 */
export function initEphemeris(): EphemerisBackend {
  if (initialised) return activeBackend;
  const ephePath = resolveEphePath();
  if (ephePath && existsSync(ephePath)) {
    sweph.set_ephe_path(ephePath);
    activeBackend = 'swiss';
  } else {
    activeBackend = 'moshier';
  }
  initialised = true;
  return activeBackend;
}

/** The currently active ephemeris backend. */
export function getBackend(): EphemerisBackend {
  if (!initialised) initEphemeris();
  return activeBackend;
}

/**
 * Base calculation flags for the active backend, always including planetary
 * speed so we can determine retrograde motion and applying/separating aspects.
 */
export function calcFlags(): number {
  const base = getBackend() === 'swiss' ? constants.SEFLG_SWIEPH : constants.SEFLG_MOSEPH;
  return base | constants.SEFLG_SPEED;
}

/** House-system flag base (no speed needed for cusps). */
export function houseFlags(): number {
  return getBackend() === 'swiss' ? constants.SEFLG_SWIEPH : constants.SEFLG_MOSEPH;
}

/* -------------------------------------------------------------------------- */
/* Sidereal zodiac support (TASK C6)                                          */
/*                                                                            */
/* Sweph's sidereal mode is GLOBAL process state (`swe_set_sid_mode`), so a    */
/* sidereal request could otherwise leak into a following tropical one. We     */
/* therefore set the mode explicitly per request and always reset it back to   */
/* tropical afterwards (see `withSidereal`). Tropical requests never touch the  */
/* sidereal state at all and behave byte-for-byte as before.                   */
/* -------------------------------------------------------------------------- */

/** Map our `Ayanamsa` to the sweph `SE_SIDM_*` constant. Defaults to Lahiri. */
export function ayanamsaMode(ayanamsa: Ayanamsa = 'lahiri'): number {
  switch (ayanamsa) {
    case 'lahiri':
      return constants.SE_SIDM_LAHIRI;
    case 'fagan_bradley':
      return constants.SE_SIDM_FAGAN_BRADLEY;
    case 'krishnamurti':
      return constants.SE_SIDM_KRISHNAMURTI;
    case 'raman':
      return constants.SE_SIDM_RAMAN;
  }
}

/**
 * Calculation flags for a sidereal request: the backend base + speed + the
 * `SEFLG_SIDEREAL` flag so planet longitudes come back sidereal.
 */
export function siderealCalcFlags(): number {
  return calcFlags() | constants.SEFLG_SIDEREAL;
}

/**
 * House flags for a sidereal request. `swe_houses_ex` honours `SEFLG_SIDEREAL`
 * (it subtracts the active ayanamsa from the cusps/Asc/MC), so we can compute
 * sidereal angles directly rather than post-subtracting.
 */
export function siderealHouseFlags(): number {
  return houseFlags() | constants.SEFLG_SIDEREAL;
}

/**
 * Run `fn` with the global sidereal mode set to `ayanamsa`, then ALWAYS reset
 * the global state back to tropical (clear the sidereal flag from cached state)
 * so the next request is deterministic. The reset runs even if `fn` throws.
 *
 * sweph has no "unset sid mode" call; resetting to Fagan-Bradley with t0/ayan0=0
 * restores the library's default and, crucially, computations that do NOT pass
 * `SEFLG_SIDEREAL` ignore the sid mode entirely — so a tropical calc is
 * unaffected regardless of the last sid mode. We still reset for hygiene.
 */
export function withSidereal<T>(ayanamsa: Ayanamsa, fn: () => T): T {
  sweph.set_sid_mode(ayanamsaMode(ayanamsa), 0, 0);
  try {
    return fn();
  } finally {
    sweph.set_sid_mode(constants.SE_SIDM_FAGAN_BRADLEY, 0, 0);
  }
}

/**
 * The ayanamsa value (degrees) at a UT Julian Day for the given model. Sets the
 * sid mode, reads the offset, then resets to tropical. Returned for transparency.
 */
export function ayanamsaDegrees(jdUt: number, ayanamsa: Ayanamsa = 'lahiri'): number {
  return withSidereal(ayanamsa, () => sweph.get_ayanamsa_ut(jdUt));
}

export { sweph, constants };
