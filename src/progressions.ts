/**
 * Secondary progressions ("day for a year").
 *
 * The classic technique: a person's life at age N years is symbolised by the
 * sky N DAYS after birth. So for a target date we compute the elapsed years
 * since birth (fractional, by exact elapsed time), advance the birth instant
 * by that many DAYS, and read the planetary positions there.
 *
 * Progressed houses/Asc/MC have several competing conventions; we focus on the
 * progressed planetary positions (the most widely agreed-upon output) and,
 * when the birth time is known, also provide the progressed Asc/MC using the
 * same progressed instant + birth location (the "naibod"-free, directly
 * computed angles for the progressed moment).
 */
import type { BirthData, Planet } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { computeAllBodies, computeHouses, toHouses, toPlanet } from './astro.js';
import type { House } from '@astroapp/shared';
import { resolveBirthInstant } from './time.js';

/** Mean tropical year in days (length of one symbolic "year"). */
const TROPICAL_YEAR_DAYS = 365.242189;

export interface ProgressionsResult {
  /** Progressed planetary positions. */
  planets: Planet[];
  /** Progressed houses (only when birth time is known). */
  houses: House[];
  /** Progressed Ascendant longitude (0 when time unknown). */
  ascendant: number;
  /** Progressed Midheaven longitude (0 when time unknown). */
  midheaven: number;
  /** Elapsed symbolic years from birth to target (fractional). */
  ageYears: number;
  /** ISO datetime of the progressed sky instant (diagnostic). */
  progressedInstant: string;
  housesAvailable: boolean;
}

/**
 * Compute secondary progressions for `birth` at `targetDateIso`.
 *
 * @param targetDateIso ISO date (or datetime) for which to progress.
 */
export function computeProgressions(birth: BirthData, targetDateIso: string): ProgressionsResult {
  const { resolved } = resolveBirthInstant(birth.date, birth.time, birth.timeKnown, birth.tzIana);

  // Birth instant as a Luxon DateTime in UTC, reconstructed from the resolved UTC ISO.
  const birthUtc = DateTime.fromISO(resolved.utc, { zone: 'utc' });
  const target = DateTime.fromISO(targetDateIso, { zone: 'utc' });
  if (!birthUtc.isValid || !target.isValid) {
    throw new Error('Invalid birth or target datetime for progressions.');
  }

  const elapsedDays = target.diff(birthUtc, 'days').days;
  const ageYears = elapsedDays / TROPICAL_YEAR_DAYS;
  // Day-for-a-year: advance the birth instant by `ageYears` DAYS.
  const progressedInstant = birthUtc.plus({ days: ageYears });
  const jdProgressed = resolved.jdUt + ageYears; // 1 JD = 1 day

  const bodies = computeAllBodies(jdProgressed);
  const housesAvailable = birth.timeKnown;

  let cusps: number[] | null = null;
  let ascendant = 0;
  let midheaven = 0;
  if (housesAvailable) {
    const h = computeHouses(jdProgressed, birth.lat, birth.lon, birth.houseSystem);
    cusps = h.cusps;
    ascendant = h.ascendant;
    midheaven = h.midheaven;
  }

  return {
    planets: bodies.map((b) => toPlanet(b, cusps)),
    houses: cusps ? toHouses(cusps) : [],
    ascendant,
    midheaven,
    ageYears,
    progressedInstant: progressedInstant.toISO() ?? '',
    housesAvailable,
  };
}
