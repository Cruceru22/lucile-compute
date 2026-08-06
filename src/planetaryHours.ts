/**
 * Planetary hours (TASK C3) — the Swiss-Ephemeris-backed layer.
 *
 * Computes sunrise, sunset, and the NEXT day's sunrise for a date + place via
 * `swe_rise_trans`, then hands the three instants to the PURE builder in
 * `planetaryHoursCore.ts` to produce the 12 day-hours + 12 night-hours table
 * with Chaldean rulers. No existing endpoint or astronomy is changed; this only
 * reuses the ephemeris init + the JD/time helpers + geo handling conventions
 * already established by A3.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * RISE / SET CONVENTION (documented choice)
 * ──────────────────────────────────────────────────────────────────────────
 * We compute Sun rise/set using sweph's `rise_trans` with the flags
 *   `SE_CALC_RISE | SE_BIT_DISC_CENTER`  and  `SE_CALC_SET | SE_BIT_DISC_CENTER`,
 * i.e. the moment the Sun's DISC CENTER crosses the true (geometric) horizon,
 * WITH standard atmospheric refraction applied (we do NOT pass
 * `SE_BIT_NO_REFRACTION`). This is the conventional definition used for
 * traditional/seasonal planetary hours: the dividing instants are sunrise and
 * sunset of the Sun's centre, refracted, rather than the upper-limb "official"
 * sunrise. It keeps day and night spans symmetric about local apparent noon and
 * matches the definition most planetary-hours references and software use. We
 * pass atmospheric pressure 0 and temperature 0, which tells Swiss Ephemeris to
 * use its standard atmosphere model for the refraction term.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * POLAR / EDGE CASES
 * ──────────────────────────────────────────────────────────────────────────
 * At high latitudes the Sun can stay above or below the horizon for the whole
 * civil date (polar day / polar night), so a sunrise and/or sunset simply does
 * not occur. `rise_trans` returns a non-OK flag (the Swiss Ephemeris "event
 * does not occur" condition) in that case. We DO NOT fabricate hours: the
 * endpoint returns `{ available: false, reason }`, mirroring how A3's other
 * unavailable paths behave (e.g. astrocartography with unknown time).
 */
import { DateTime } from 'luxon';
import { constants, getBackend, houseFlags, sweph, type EphemerisBackend } from './ephemeris.js';
import {
  buildPlanetaryHours,
  currentHour,
  type ChaldeanRuler,
  type PlanetaryHoursTable,
} from './planetaryHoursCore.js';

/** Number of milliseconds in a day (used for JD↔epoch conversion). */
const MS_PER_DAY = 86_400_000;
/** Julian Day of the Unix epoch (1970-01-01T00:00:00Z). */
const JD_UNIX_EPOCH = 2_440_587.5;

/** Convert a Julian Day (UT) to Unix epoch milliseconds. */
export function jdUtToEpochMs(jdUt: number): number {
  return Math.round((jdUt - JD_UNIX_EPOCH) * MS_PER_DAY);
}

/** Convert Unix epoch milliseconds to a Julian Day (UT). */
export function epochMsToJdUt(epochMs: number): number {
  return epochMs / MS_PER_DAY + JD_UNIX_EPOCH;
}

/** Rise/set search flags: Sun disc CENTER crossing, WITH refraction. */
const RISE_FLAGS = constants.SE_CALC_RISE | constants.SE_BIT_DISC_CENTER;
const SET_FLAGS = constants.SE_CALC_SET | constants.SE_BIT_DISC_CENTER;

/**
 * Find the first Sun event of `kind` (`rise` or `set`) at/after `fromJdUt` for a
 * location. Returns the event JD (UT), or `null` when the event does not occur
 * (polar day/night) within the search.
 *
 * sweph geopos order is `[longitude, latitude, elevation_m]` (lon FIRST).
 */
function nextSunEvent(
  fromJdUt: number,
  lat: number,
  lon: number,
  kind: 'rise' | 'set',
): number | null {
  const rsmi = kind === 'rise' ? RISE_FLAGS : SET_FLAGS;
  // epheflag mirrors the active backend (swiss vs moshier), like calc_ut.
  const epheflag = houseFlags();
  const res = sweph.rise_trans(
    fromJdUt,
    constants.SE_SUN,
    null,
    epheflag,
    rsmi,
    [lon, lat, 0],
    0, // atmospheric pressure → sweph uses its standard atmosphere
    0, // temperature → standard
  );
  // flag === OK (0) means the event was found; anything else (incl. the
  // "event does not occur" condition at high latitude) means no event.
  if (res.flag !== constants.OK) return null;
  return res.data;
}

/** A successfully computed planetary-hours response. */
export interface PlanetaryHoursResult extends PlanetaryHoursTable {
  available: true;
  /** The civil date the hours were computed for (`yyyy-mm-dd`, local). */
  date: string;
  /** The location. */
  lat: number;
  lon: number;
  /** IANA zone the ISO instants are expressed in. */
  tzIana: string;
  /** Sunrise on the date (ISO, zoned). */
  sunrise: string;
  /** Sunset on the date (ISO, zoned). */
  sunset: string;
  /** Next day's sunrise (ISO, zoned). */
  nextSunrise: string;
  ephemerisBackend: EphemerisBackend;
  /**
   * The current planetary hour, when a `now` was supplied AND it falls within
   * the sunrise → next-sunrise window; otherwise `null`.
   */
  current: { period: 'day' | 'night'; index: number; ruler: ChaldeanRuler } | null;
}

/** The unavailable (polar day/night) response. */
export interface PlanetaryHoursUnavailable {
  available: false;
  reason: string;
  date: string;
  lat: number;
  lon: number;
  tzIana: string;
}

export type PlanetaryHoursResponse = PlanetaryHoursResult | PlanetaryHoursUnavailable;

export interface ComputePlanetaryHoursInput {
  /** Civil date `yyyy-mm-dd` to compute hours for. */
  date: string;
  lat: number;
  lon: number;
  /** IANA zone for interpreting the date and formatting the output instants. */
  tzIana: string;
  /** Optional "now" (ISO) to flag the current hour. */
  now?: string;
}

/**
 * Compute the planetary-hours table for a date + place.
 *
 * Steps:
 *   1. Anchor the search at local MIDNIGHT of `date` in `tzIana`, converted to
 *      JD (UT). Find the first sunrise at/after midnight (the date's sunrise).
 *   2. Find the first sunset AFTER that sunrise (the date's sunset).
 *   3. Find the first sunrise AFTER that sunset (the next day's sunrise).
 *   4. Take the weekday at the LOCAL sunrise date, build the table via the pure
 *      core, and (if `now` given) flag the current hour.
 *
 * Returns `{ available:false }` when any required event does not occur (polar
 * day/night) — no hours are fabricated.
 */
export function computePlanetaryHours(input: ComputePlanetaryHoursInput): PlanetaryHoursResponse {
  const { date, lat, lon, tzIana } = input;

  // Local midnight of the date, as the search anchor.
  const midnight = DateTime.fromISO(`${date}T00:00`, { zone: tzIana });
  if (!midnight.isValid) {
    throw new Error(`Invalid date/zone: ${date} ${tzIana} (${midnight.invalidReason})`);
  }
  const midnightJd = epochMsToJdUt(midnight.toMillis());

  const sunriseJd = nextSunEvent(midnightJd, lat, lon, 'rise');
  const base: Pick<PlanetaryHoursUnavailable, 'date' | 'lat' | 'lon' | 'tzIana'> = {
    date,
    lat,
    lon,
    tzIana,
  };
  if (sunriseJd === null) {
    return {
      available: false,
      reason:
        'The Sun does not rise on this date at this latitude (polar day or polar night), so seasonal planetary hours are undefined here.',
      ...base,
    };
  }

  // Sunset must come after sunrise; nudge the search start just past sunrise.
  const sunsetJd = nextSunEvent(sunriseJd + 1 / 1440, lat, lon, 'set');
  if (sunsetJd === null) {
    return {
      available: false,
      reason:
        'The Sun rises but does not set on this date at this latitude (polar day), so seasonal planetary hours are undefined here.',
      ...base,
    };
  }

  const nextSunriseJd = nextSunEvent(sunsetJd + 1 / 1440, lat, lon, 'rise');
  if (nextSunriseJd === null) {
    return {
      available: false,
      reason:
        'The next sunrise does not occur at this latitude (polar night follows), so the night hours are undefined here.',
      ...base,
    };
  }

  const sunriseMs = jdUtToEpochMs(sunriseJd);
  const sunsetMs = jdUtToEpochMs(sunsetJd);
  const nextSunriseMs = jdUtToEpochMs(nextSunriseJd);

  // Weekday at the LOCAL sunrise date. Luxon weekday: 1=Mon..7=Sun → map to
  // 0=Sun..6=Sat that the core uses.
  const sunriseLocal = DateTime.fromMillis(sunriseMs, { zone: tzIana });
  const weekday = sunriseLocal.weekday % 7; // 7 (Sun) → 0; 1..6 stay

  // Format an epoch instant as a zoned ISO string in `tzIana`.
  const toIso = (epochMs: number): string =>
    DateTime.fromMillis(epochMs, { zone: tzIana }).toISO({ suppressMilliseconds: true }) ?? '';

  const table = buildPlanetaryHours(sunriseMs, sunsetMs, nextSunriseMs, weekday, toIso);

  // Current hour, if a `now` is supplied and inside the window.
  let current: PlanetaryHoursResult['current'] = null;
  if (input.now) {
    const nowDt = DateTime.fromISO(input.now, { zone: tzIana });
    if (nowDt.isValid) {
      const parseIso = (iso: string): number => DateTime.fromISO(iso, { zone: tzIana }).toMillis();
      current = currentHour(table, nowDt.toMillis(), parseIso);
    }
  }

  return {
    available: true,
    ...base,
    sunrise: toIso(sunriseMs),
    sunset: toIso(sunsetMs),
    nextSunrise: toIso(nextSunriseMs),
    ephemerisBackend: getBackend(),
    current,
    ...table,
  };
}
