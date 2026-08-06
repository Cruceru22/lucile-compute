/**
 * Electional / auspicious-timing engine — "good days (and times) to do X".
 *
 * DETERMINISTIC and tradition-based: for each day in a range we compute a small
 * set of timing factors (planetary day ruler, Moon phase, Moon sign, retrograde
 * flags, void-of-course Moon, Rahu Kalam window) and score a handful of common
 * activities against rules that are EXPLICITLY sourced to tradition (see the
 * research report). No AI, no chart needed — pure ephemeris + rule tables.
 *
 * Only rules CONFIRMED by the research are encoded here:
 *   - Planetary days of the week (fixed rulership) and the activities each ruler
 *     traditionally favours (Coley, 1676; Renaissance Astrology).
 *   - Waxing vs waning Moon (waxing → growth/beginnings; waning → release/cut
 *     back). [Western electional]
 *   - Void-of-course Moon → "don't begin important things". [Lilly 1647]
 *   - Mercury retrograde → caution for contracts/communication/travel.
 *   - Rahu Kalam → a daily inauspicious window (1/8 of daytime by weekday).
 *
 * NOT encoded (per research open questions): per-nakshatra/per-tithi Vedic rules
 * (need primary sourcing first), and the two REFUTED rules (haircut by Moon sign
 * ALONE; a blanket Mars-hour penalty).
 *
 * Everything is framed as TRADITION-BASED GUIDANCE, not prediction — the caller
 * is expected to surface the "no scientific evidence" disclaimer in-product.
 */
import type { PlanetName, ZodiacSign } from '@astroapp/shared';
import { DateTime } from 'luxon';
import { BODIES, computeBody, norm360, signFor } from './astro.js';
import { computePlanetaryHours } from './planetaryHours.js';
import { dayRulerForWeekday, type ChaldeanRuler } from './planetaryHoursCore.js';
import { localToJulianDay } from './time.js';

const ID_OF: Readonly<Record<string, number>> = Object.fromEntries(
  BODIES.map((b) => [b.name, b.id]),
);

/** Classical planets that can be retrograde (Sun/Moon never are). */
const RETRO_BODIES: readonly PlanetName[] = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

/** Ptolemaic aspect angles used for the void-of-course test. */
const ASPECT_ANGLES = [0, 60, 90, 120, 180] as const;

/**
 * Rahu Kalam segment index (which 1/8 of the daytime) by weekday, 0 = Sunday.
 * Standard sequence: Sun→8th, Mon→2nd, Tue→7th, Wed→5th, Thu→6th, Fri→4th, Sat→3rd.
 */
const RAHU_SEGMENT: readonly number[] = [7, 1, 6, 4, 5, 3, 2];

export type Tier = 'favorable' | 'mixed' | 'avoid';

export interface DayFactors {
  /** `yyyy-mm-dd` (local civil date). */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Planet ruling the day. */
  dayRuler: ChaldeanRuler;
  /** Waxing (Moon ahead of Sun, 0–180°) or waning (180–360°). */
  moonPhase: 'waxing' | 'waning';
  /** Coarse phase name for display. */
  moonPhaseName: 'New' | 'Waxing' | 'Full' | 'Waning';
  /** Moon illumination fraction 0..1. */
  illumination: number;
  /** Moon's zodiac sign (tropical). */
  moonSign: ZodiacSign;
  /** Classical planets retrograde at local noon. */
  retrograde: PlanetName[];
  /** Whether the Moon is void-of-course at local noon (modern last-aspect rule). */
  voidOfCourse: boolean;
  /** The day's Rahu Kalam window (ISO, zoned), or null at extreme latitudes. */
  rahuKalam: { start: string; end: string } | null;
}

export interface ActivityVerdict {
  activity: Activity;
  label: string;
  score: number; // 0..100
  tier: Tier;
  reasons: string[];
}

export interface ElectionalDay {
  date: string;
  factors: DayFactors;
  verdicts: ActivityVerdict[];
}

export type Activity =
  | 'haircut_growth'
  | 'haircut_reduce'
  | 'start_venture'
  | 'sign_contract'
  | 'travel'
  | 'money'
  | 'love';

interface ActivityRule {
  id: Activity;
  label: string;
  /** Moon phase this activity wants. */
  favorPhase?: 'waxing' | 'waning';
  /** Planetary day rulers traditionally good for this activity. */
  favorRulers?: ChaldeanRuler[];
  /** Tradition cautions against beginning this during a void-of-course Moon. */
  avoidVoc?: boolean;
  /** Tradition cautions against this under Mercury retrograde. */
  avoidMercuryRx?: boolean;
}

/** The codified rule set (confirmed traditions only). */
const RULES: readonly ActivityRule[] = [
  { id: 'haircut_growth', label: 'Haircut, to encourage growth', favorPhase: 'waxing' },
  { id: 'haircut_reduce', label: 'Haircut, for slower regrowth', favorPhase: 'waning' },
  {
    id: 'start_venture',
    label: 'Start a job / launch something',
    favorPhase: 'waxing',
    favorRulers: ['Sun', 'Jupiter'],
    avoidVoc: true,
    avoidMercuryRx: true,
  },
  {
    id: 'sign_contract',
    label: 'Sign a contract / big decision',
    favorRulers: ['Mercury'],
    avoidVoc: true,
    avoidMercuryRx: true,
  },
  { id: 'travel', label: 'Travel', favorRulers: ['Venus', 'Mercury'], avoidMercuryRx: true },
  {
    id: 'money',
    label: 'Money, buying & selling',
    favorRulers: ['Mercury', 'Jupiter'],
    avoidVoc: true,
    avoidMercuryRx: true,
  },
  {
    id: 'love',
    label: 'Love, first date / asking out',
    favorPhase: 'waxing',
    favorRulers: ['Venus'],
    avoidVoc: true,
  },
];

/** Julian Day (UT) for local noon on a civil date. */
function noonJd(date: string, tzIana: string): number {
  return localToJulianDay(date, '12:00', tzIana).jdUt;
}

/** Is the Moon void-of-course at `jd`? Modern rule: no exact Ptolemaic aspect to a
 *  classical planet remains before the Moon leaves its current sign. Other bodies
 *  are approximated as fixed over the short remaining-in-sign arc (< ~2.5 days). */
function moonVoidOfCourse(jd: number): boolean {
  const moon = computeBody(jd, ID_OF.Moon!, 'Moon').absoluteDegree;
  const ingressLon = (Math.floor(moon / 30) + 1) * 30; // next sign boundary (30..360)
  for (const name of ['Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'] as const) {
    const lon = computeBody(jd, ID_OF[name]!, name).absoluteDegree;
    for (const a of ASPECT_ANGLES) {
      for (const target of [norm360(lon + a), norm360(lon - a)]) {
        // An aspect perfects before ingress if its target longitude lies ahead of
        // the Moon but still inside the current sign.
        if (target > moon && target <= ingressLon) return false;
      }
    }
  }
  return true;
}

/** Compute all timing factors for one day. */
function dayFactors(date: string, lat: number, lon: number, tzIana: string): DayFactors {
  const jd = noonJd(date, tzIana);
  const weekday = DateTime.fromISO(date, { zone: tzIana }).weekday % 7; // luxon Mon=1..Sun=7 → 0=Sun

  const sunLon = computeBody(jd, ID_OF.Sun!, 'Sun').absoluteDegree;
  const moonBody = computeBody(jd, ID_OF.Moon!, 'Moon');
  const phaseAngle = norm360(moonBody.absoluteDegree - sunLon);
  const moonPhase: 'waxing' | 'waning' = phaseAngle < 180 ? 'waxing' : 'waning';
  const illumination = (1 - Math.cos((phaseAngle * Math.PI) / 180)) / 2;
  const moonPhaseName: DayFactors['moonPhaseName'] =
    phaseAngle < 12 || phaseAngle > 348
      ? 'New'
      : phaseAngle > 168 && phaseAngle < 192
        ? 'Full'
        : moonPhase === 'waxing'
          ? 'Waxing'
          : 'Waning';

  const retrograde = RETRO_BODIES.filter((n) => computeBody(jd, ID_OF[n]!, n).speed < 0);

  // Planetary day ruler + Rahu Kalam need sunrise/sunset.
  const ph = computePlanetaryHours({ date, lat, lon, tzIana });
  let dayRuler: ChaldeanRuler;
  let rahuKalam: DayFactors['rahuKalam'] = null;
  if (ph.available) {
    dayRuler = ph.dayRuler;
    const sunrise = DateTime.fromISO(ph.sunrise).toMillis();
    const sunset = DateTime.fromISO(ph.sunset).toMillis();
    const eighth = (sunset - sunrise) / 8;
    const seg = RAHU_SEGMENT[weekday] ?? 0;
    rahuKalam = {
      start: DateTime.fromMillis(sunrise + seg * eighth, { zone: tzIana }).toISO()!,
      end: DateTime.fromMillis(sunrise + (seg + 1) * eighth, { zone: tzIana }).toISO()!,
    };
  } else {
    dayRuler = dayRulerForWeekday(weekday);
  }

  return {
    date,
    weekday,
    dayRuler,
    moonPhase,
    moonPhaseName,
    illumination,
    moonSign: signFor(moonBody.absoluteDegree),
    retrograde,
    voidOfCourse: moonVoidOfCourse(jd),
    rahuKalam,
  };
}

/** Score one activity against a day's factors (transparent additive model). */
function scoreActivity(rule: ActivityRule, f: DayFactors): ActivityVerdict {
  let score = 50;
  const reasons: string[] = [];

  if (rule.favorPhase) {
    if (f.moonPhase === rule.favorPhase) {
      score += 18;
      reasons.push(
        rule.favorPhase === 'waxing'
          ? `Waxing Moon, tradition favours growth and beginnings.`
          : `Waning Moon, tradition favours cutting back and slower regrowth.`,
      );
    } else {
      score -= 8;
      reasons.push(
        `The Moon is ${f.moonPhase}, not ${rule.favorPhase}, less ideal for this by tradition.`,
      );
    }
  }

  if (rule.favorRulers && rule.favorRulers.includes(f.dayRuler)) {
    score += 18;
    reasons.push(
      `${weekdayName(f.weekday)} is ruled by ${f.dayRuler}, traditionally good for this.`,
    );
  }

  // Hard "avoid" conditions cap the day's score.
  const mercuryRx = f.retrograde.includes('Mercury');
  if (rule.avoidMercuryRx && mercuryRx) {
    score = Math.min(score, 28);
    reasons.push(`Mercury is retrograde, tradition cautions against contracts, comms and travel.`);
  }
  if (rule.avoidVoc && f.voidOfCourse) {
    score = Math.min(score, 30);
    reasons.push(`The Moon is void-of-course midday, tradition says don't begin important things.`);
  }

  score = Math.max(0, Math.min(100, score));
  const tier: Tier = score >= 65 ? 'favorable' : score >= 40 ? 'mixed' : 'avoid';
  return { activity: rule.id, label: rule.label, score, tier, reasons };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? 'This day';
}

export interface ElectionalRequest {
  from: string; // yyyy-mm-dd
  days: number;
  lat: number;
  lon: number;
  tzIana: string;
}

/**
 * Build the per-day electional table for a date range. Each day carries its
 * factors plus a verdict for every activity, so the client can highlight one
 * activity and show the favorable days.
 */
export function buildElectional(req: ElectionalRequest): { days: ElectionalDay[] } {
  const start = DateTime.fromISO(req.from, { zone: req.tzIana });
  const days: ElectionalDay[] = [];
  for (let i = 0; i < req.days; i++) {
    const date = start.plus({ days: i }).toFormat('yyyy-MM-dd');
    const factors = dayFactors(date, req.lat, req.lon, req.tzIana);
    const verdicts = RULES.map((rule) => scoreActivity(rule, factors));
    days.push({ date, factors, verdicts });
  }
  return { days };
}
