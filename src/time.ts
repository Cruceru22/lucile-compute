/**
 * Time handling — the most accuracy-critical part of the service.
 *
 * Birth input is ALWAYS a local civil date/time plus an IANA timezone name
 * (never a raw UTC offset). We use Luxon to interpret that local time in the
 * named zone — which applies the correct HISTORICAL DST rules from the IANA
 * tz database — convert to UTC, and then to a Julian Day in Universal Time
 * (UT) for Swiss Ephemeris.
 *
 * ACCURACY LIMIT: the IANA tz database is reliable mainly for dates after
 * ~1970. Before that, recorded local-mean-time / DST conventions are spotty,
 * so pre-1970 charts carry genuine timing uncertainty (often minutes, which
 * matters for the Ascendant). We surface this via `preTzDatabaseEra`.
 */
import { DateTime } from 'luxon';
import { constants, sweph } from './ephemeris.js';
import { find as findTz } from 'geo-tz';

/** Year before which IANA tz/DST data is considered unreliable. */
export const TZ_DB_RELIABLE_FROM_YEAR = 1970;

export interface ResolvedTime {
  /** Julian Day in Universal Time, for `sweph.calc_ut` / `sweph.houses_ex`. */
  jdUt: number;
  /** The instant in UTC, as an ISO string (for diagnostics/echo). */
  utc: string;
  /** True if the birth year predates reliable tz-database coverage. */
  preTzDatabaseEra: boolean;
}

/**
 * Build a Julian Day (UT) from a local birth date/time in a named IANA zone.
 *
 * @param date  ISO calendar date `yyyy-mm-dd`.
 * @param time  Local clock time `HH:mm` (24h). When the time is unknown the
 *              caller should pass noon — see {@link resolveBirthInstant}.
 * @param tzIana IANA zone name, e.g. `Europe/Lisbon`.
 */
export function localToJulianDay(date: string, time: string, tzIana: string): ResolvedTime {
  const [yStr, moStr, dStr] = date.split('-');
  const [hStr, miStr] = time.split(':');
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);

  const local = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0 },
    { zone: tzIana },
  );
  if (!local.isValid) {
    throw new Error(
      `Invalid local datetime/zone: ${date} ${time} ${tzIana} (${local.invalidReason})`,
    );
  }

  const utc = local.toUTC();
  // Decimal UTC hour for sweph.julday.
  const decimalHour = utc.hour + utc.minute / 60 + utc.second / 3600;
  const jdUt = sweph.julday(utc.year, utc.month, utc.day, decimalHour, constants.SE_GREG_CAL);

  return {
    jdUt,
    utc: utc.toISO() ?? '',
    preTzDatabaseEra: year < TZ_DB_RELIABLE_FROM_YEAR,
  };
}

/**
 * Resolve the computation instant for a birth, handling unknown time.
 *
 * When `timeKnown` is false we cannot reliably place houses/Asc/MC (they move
 * ~1° every 4 minutes), so by convention we compute PLANET positions for
 * **local noon** in the birth zone. Noon minimises the worst-case error for
 * the fast-moving Moon (max ~6° over a half-day, vs ~12° if anchored at
 * midnight on the wrong civil day) and keeps the date unambiguous across the
 * UTC boundary.
 */
export function resolveBirthInstant(
  date: string,
  time: string | null,
  timeKnown: boolean,
  tzIana: string,
): { resolved: ResolvedTime; usedNoonFallback: boolean } {
  if (timeKnown && time) {
    return { resolved: localToJulianDay(date, time, tzIana), usedNoonFallback: false };
  }
  return { resolved: localToJulianDay(date, '12:00', tzIana), usedNoonFallback: true };
}

/**
 * Derive an IANA timezone from lat/lon using geo-tz. Returns the first match
 * (geo-tz returns the most specific zone first). Used only when a caller does
 * not already supply `tzIana`.
 */
export function tzFromLatLon(lat: number, lon: number): string | undefined {
  const zones = findTz(lat, lon);
  return zones[0];
}

/** Convert a Luxon DateTime (any zone) to Julian Day (UT). */
export function dateTimeToJulianDay(dt: DateTime): number {
  const utc = dt.toUTC();
  const decimalHour = utc.hour + utc.minute / 60 + utc.second / 3600;
  return sweph.julday(utc.year, utc.month, utc.day, decimalHour, constants.SE_GREG_CAL);
}

/** Convert a Julian Day (UT) back to a UTC ISO datetime string. */
export function julianDayToIso(jdUt: number): string {
  const r = sweph.revjul(jdUt, constants.SE_GREG_CAL);
  // Build from the calendar date at midnight, then add the fractional hours as a
  // duration. This avoids minute/second overflow (e.g. second === 60) producing
  // an invalid DateTime.
  const dt = DateTime.fromObject(
    { year: r.year, month: r.month, day: r.day, hour: 0, minute: 0, second: 0 },
    { zone: 'utc' },
  ).plus({ hours: r.hour });
  return dt.toISO({ suppressMilliseconds: true }) ?? '';
}
