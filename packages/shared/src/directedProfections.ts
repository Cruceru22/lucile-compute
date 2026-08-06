/**
 * DIRECTED PROFECTIONS (al-Tabari / Umar al-Tabari, 8th-c. Persian) — a precise
 * timing refinement on top of annual profections.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE TECHNIQUE (so it's auditable)
 * ──────────────────────────────────────────────────────────────────────────
 * Annual profections move the chart's focus one whole sign per year of life. The
 * DIRECTED refinement treats that activation as a POINT that moves continuously:
 *
 *   - It starts each profection year at the EQUAL-HOUSE cusp of the profected
 *     house — i.e. the Ascendant's degree carried into the profected sign:
 *         cusp = ascendant + (profectedHouse - 1) · 30°.
 *   - It advances 30° per profection year (5° = 2 months; 2.5°/month;
 *     1° ≈ 12.17 days). One year later it has moved exactly one sign and sits on
 *     the NEXT year's cusp, so the motion is continuous across birthdays:
 *         directedLongitude(t) = ascendant + (age + yearFraction) · 30°.
 *
 * As the point sweeps forward it ACTIVATES natal factors when it forms a Ptolemaic
 * aspect (conjunction / sextile / square / trine / opposition) to a natal planet,
 * angle, or Lot, and when it crosses from one Egyptian bound (term) into the next.
 * Each activation gets an EXACT date plus a tight orb window (the technique resolves
 * events to ~12–24 day periods at a 1–3° orb). This is the deterministic ground
 * truth that lets a forecast name concrete days — an LLM never does this math.
 *
 * Pure & DEPENDENCY-FREE (plain Date arithmetic, no luxon): it derives everything
 * from the already-computed natal chart (planet longitudes, houses, Ascendant) +
 * the birth date, so it runs identically server-side (compute) and on-device
 * (mobile, offline). Requires a known birth time (an Ascendant); degrades to
 * `available: false` otherwise.
 */
import type { NatalChart, PlanetName } from './index.js';

const DEG_PER_SIGN = 30;
const SIGNS = 12;
const MS_PER_DAY = 86_400_000;

const SIGN_NAMES = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Ptolemaic aspects: angular offset → name. Symmetric offsets share a name. */
const ASPECT_BY_OFFSET: Readonly<Record<number, string>> = {
  0: 'conjunction',
  60: 'sextile',
  90: 'square',
  120: 'trine',
  180: 'opposition',
  240: 'trine',
  270: 'square',
  300: 'sextile',
};
const ASPECT_OFFSETS = Object.keys(ASPECT_BY_OFFSET).map(Number);

/**
 * Egyptian bounds (terms) — the standard Hellenistic table (Ptolemy's
 * "Egyptians", as used by Valens). Per sign, five segments in zodiacal order;
 * each entry is the term-ruler and the ENDING degree within the sign (the start
 * is the previous entry's end, or 0 for the first). The directed point entering a
 * new segment is itself an activation (it "changes term-lord").
 */
const EGYPTIAN_BOUNDS: Readonly<Record<string, ReadonlyArray<{ ruler: PlanetName; end: number }>>> =
  {
    Aries: [
      { ruler: 'Jupiter', end: 6 },
      { ruler: 'Venus', end: 12 },
      { ruler: 'Mercury', end: 20 },
      { ruler: 'Mars', end: 25 },
      { ruler: 'Saturn', end: 30 },
    ],
    Taurus: [
      { ruler: 'Venus', end: 8 },
      { ruler: 'Mercury', end: 14 },
      { ruler: 'Jupiter', end: 22 },
      { ruler: 'Saturn', end: 27 },
      { ruler: 'Mars', end: 30 },
    ],
    Gemini: [
      { ruler: 'Mercury', end: 6 },
      { ruler: 'Jupiter', end: 12 },
      { ruler: 'Venus', end: 17 },
      { ruler: 'Mars', end: 24 },
      { ruler: 'Saturn', end: 30 },
    ],
    Cancer: [
      { ruler: 'Mars', end: 7 },
      { ruler: 'Venus', end: 13 },
      { ruler: 'Mercury', end: 19 },
      { ruler: 'Jupiter', end: 26 },
      { ruler: 'Saturn', end: 30 },
    ],
    Leo: [
      { ruler: 'Jupiter', end: 6 },
      { ruler: 'Venus', end: 11 },
      { ruler: 'Saturn', end: 18 },
      { ruler: 'Mercury', end: 24 },
      { ruler: 'Mars', end: 30 },
    ],
    Virgo: [
      { ruler: 'Mercury', end: 7 },
      { ruler: 'Venus', end: 17 },
      { ruler: 'Jupiter', end: 21 },
      { ruler: 'Mars', end: 28 },
      { ruler: 'Saturn', end: 30 },
    ],
    Libra: [
      { ruler: 'Saturn', end: 6 },
      { ruler: 'Mercury', end: 14 },
      { ruler: 'Jupiter', end: 21 },
      { ruler: 'Venus', end: 28 },
      { ruler: 'Mars', end: 30 },
    ],
    Scorpio: [
      { ruler: 'Mars', end: 7 },
      { ruler: 'Venus', end: 11 },
      { ruler: 'Mercury', end: 19 },
      { ruler: 'Jupiter', end: 24 },
      { ruler: 'Saturn', end: 30 },
    ],
    Sagittarius: [
      { ruler: 'Jupiter', end: 12 },
      { ruler: 'Venus', end: 17 },
      { ruler: 'Mercury', end: 21 },
      { ruler: 'Saturn', end: 26 },
      { ruler: 'Mars', end: 30 },
    ],
    Capricorn: [
      { ruler: 'Mercury', end: 7 },
      { ruler: 'Jupiter', end: 14 },
      { ruler: 'Venus', end: 22 },
      { ruler: 'Saturn', end: 26 },
      { ruler: 'Mars', end: 30 },
    ],
    Aquarius: [
      { ruler: 'Mercury', end: 7 },
      { ruler: 'Venus', end: 13 },
      { ruler: 'Jupiter', end: 20 },
      { ruler: 'Mars', end: 25 },
      { ruler: 'Saturn', end: 30 },
    ],
    Pisces: [
      { ruler: 'Venus', end: 12 },
      { ruler: 'Jupiter', end: 16 },
      { ruler: 'Mercury', end: 19 },
      { ruler: 'Mars', end: 28 },
      { ruler: 'Saturn', end: 30 },
    ],
  };

/** A single dated activation of the directed point. */
export interface DirectedActivation {
  /** ISO date (yyyy-mm-dd) of the EXACT hit. */
  exactDate: string;
  /** Tight orb window around the exact hit (yyyy-mm-dd). */
  windowStart: string;
  windowEnd: string;
  /** The directed point's longitude (0–360) at the exact hit. */
  directedLongitude: number;
  /** Human label of where the point is, e.g. "13°56′ Libra". */
  directedPosition: string;
  kind: 'aspect' | 'bound';
  /** Aspect activations: the aspect + the natal factor hit. */
  aspect?: string;
  target?: string;
  /** Bound activations: the term-rulers either side of the crossing. */
  fromBoundRuler?: PlanetName;
  toBoundRuler?: PlanetName;
  /** One-line human description (used directly in prompt ground truth). */
  description: string;
}

export interface DirectedProfectionResult {
  available: boolean;
  /** When unavailable, why (e.g. no birth time). */
  reason?: string;
  /** Activations within the requested window, ordered by date. */
  activations: DirectedActivation[];
  /** The orb (degrees) used for the windows. */
  orbDeg: number;
}

interface NatalTarget {
  name: string;
  longitude: number;
}

const TWO_PI_DEG = 360;
const norm360 = (d: number): number => ((d % TWO_PI_DEG) + TWO_PI_DEG) % TWO_PI_DEG;

/** Format a longitude as e.g. "13°56′ Libra". */
function formatLongitude(lon: number): string {
  const n = norm360(lon);
  const signIdx = Math.floor(n / DEG_PER_SIGN) % SIGNS;
  const within = n - signIdx * DEG_PER_SIGN;
  const deg = Math.floor(within);
  const min = Math.round((within - deg) * 60);
  // Carry a rounded 60′ into the next degree.
  const carry = min === 60;
  return `${carry ? deg + 1 : deg}°${String(carry ? 0 : min).padStart(2, '0')}′ ${SIGN_NAMES[signIdx]}`;
}

interface BirthParts {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: string): BirthParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// ── Pure date helpers (no luxon) ──────────────────────────────────────────────

/** Parse an ISO date (`yyyy-mm-dd`) or datetime to ms; NaN if unparseable. */
function parseIsoMs(iso: string): number {
  // `yyyy-mm-dd` is parsed as UTC midnight by Date.parse; full ISO with Z is UTC.
  return Date.parse(iso);
}

/** Floor a ms instant to UTC midnight. */
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** ms → `yyyy-mm-dd` (UTC). */
function isoDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The UNWRAPPED directed longitude at instant `tMs`, measured in absolute degrees
 * from the Ascendant (monotonically increasing, NOT reduced mod 360). This is what
 * makes the activation search exact and wrap-safe: the point advances `30°` per
 * profection year, anchored on the birthday (so the motion is continuous across
 * each birthday — frac resets to 0 exactly as the profected house increments, +30°).
 */
function directedUnwrapped(birth: BirthParts, ascendant: number, tMs: number): number {
  const t = new Date(tMs);
  let bdYear = t.getUTCFullYear();
  const birthdayThisYear = Date.UTC(bdYear, birth.month - 1, birth.day);
  if (tMs < birthdayThisYear) bdYear -= 1;
  const lastBirthdayMs = Date.UTC(bdYear, birth.month - 1, birth.day);
  const nextBirthdayMs = Date.UTC(bdYear + 1, birth.month - 1, birth.day);

  const age = bdYear - birth.year;
  const yearLenMs = nextBirthdayMs - lastBirthdayMs;
  const frac = yearLenMs > 0 ? (tMs - lastBirthdayMs) / yearLenMs : 0;

  return ascendant + (age + frac) * DEG_PER_SIGN;
}

/**
 * Invert `directedUnwrapped` for a target unwrapped value `U`, returning the ms
 * instant within `[loMs, hiMs]` where the directed point reaches `U`. The function
 * is continuous & strictly increasing on the interval, so a bisection converges.
 * Returns null if `U` is not bracketed by the interval.
 */
function solveForUnwrapped(
  birth: BirthParts,
  ascendant: number,
  U: number,
  loMs: number,
  hiMs: number,
): number | null {
  const fLo = directedUnwrapped(birth, ascendant, loMs) - U;
  const fHi = directedUnwrapped(birth, ascendant, hiMs) - U;
  if (fLo > 0 || fHi < 0) return null; // not in range
  let lo = loMs;
  let hi = hiMs;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const f = directedUnwrapped(birth, ascendant, mid) - U;
    if (f < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Day/night sect from the Sun's natal house (above the horizon = houses 7–12 = day). */
function isDayChart(chart: NatalChart): boolean | null {
  const sun = chart.planets.find((p) => p.name === 'Sun');
  if (!sun || chart.housesAvailable === false) return null;
  return sun.house >= 7 && sun.house <= 12;
}

/** Build the list of natal factors the directed point can activate. */
function buildTargets(chart: NatalChart): NatalTarget[] {
  const targets: NatalTarget[] = [];
  for (const p of chart.planets) {
    targets.push({ name: `natal ${p.name}`, longitude: p.absoluteDegree });
  }
  if (chart.ascendant != null) targets.push({ name: 'the Ascendant', longitude: chart.ascendant });
  if (chart.midheaven != null) targets.push({ name: 'the Midheaven', longitude: chart.midheaven });

  const sun = chart.planets.find((p) => p.name === 'Sun');
  const moon = chart.planets.find((p) => p.name === 'Moon');
  const day = isDayChart(chart);
  if (sun && moon && chart.ascendant != null && day != null) {
    const asc = chart.ascendant;
    const fortune = norm360(
      day
        ? asc + moon.absoluteDegree - sun.absoluteDegree
        : asc + sun.absoluteDegree - moon.absoluteDegree,
    );
    const spirit = norm360(
      day
        ? asc + sun.absoluteDegree - moon.absoluteDegree
        : asc + moon.absoluteDegree - sun.absoluteDegree,
    );
    targets.push({ name: 'the Lot of Fortune', longitude: fortune });
    targets.push({ name: 'the Lot of Spirit', longitude: spirit });
  }
  return targets;
}

/** Absolute longitudes (0–360) of every Egyptian-bound boundary, with the rulers either side. */
function boundBoundaries(): Array<{ longitude: number; from: PlanetName; to: PlanetName }> {
  const out: Array<{ longitude: number; from: PlanetName; to: PlanetName }> = [];
  for (let s = 0; s < SIGNS; s++) {
    const sign = SIGN_NAMES[s];
    const prevSign = SIGN_NAMES[(s + SIGNS - 1) % SIGNS];
    if (!sign || !prevSign) continue;
    const terms = EGYPTIAN_BOUNDS[sign];
    if (!terms) continue;
    const prevTerms = EGYPTIAN_BOUNDS[prevSign];
    if (prevTerms && prevTerms.length > 0) {
      out.push({
        longitude: s * DEG_PER_SIGN,
        from: prevTerms[prevTerms.length - 1]!.ruler,
        to: terms[0]!.ruler,
      });
    }
    for (let i = 0; i < terms.length - 1; i++) {
      out.push({
        longitude: s * DEG_PER_SIGN + terms[i]!.end,
        from: terms[i]!.ruler,
        to: terms[i + 1]!.ruler,
      });
    }
  }
  return out;
}

/**
 * Compute every directed-profection activation that falls in `[fromIso, toIso]`.
 *
 * @param chart      the natal chart (needs an Ascendant — i.e. a known birth time)
 * @param birthDate  yyyy-mm-dd birth date (anchors the profection year)
 * @param fromIso    window start (ISO date or datetime)
 * @param toIso      window end
 * @param opts.orbDeg  orb (degrees) for the activation window; default 1.5° (~±18 days)
 */
export function directedProfectionsInRange(
  chart: NatalChart,
  birthDate: string,
  fromIso: string,
  toIso: string,
  opts: { orbDeg?: number } = {},
): DirectedProfectionResult {
  const orbDeg = opts.orbDeg ?? 1.5;

  if (chart.ascendant == null || chart.housesAvailable === false) {
    return {
      available: false,
      reason:
        'Directed profections need the rising degree (Ascendant), which requires a known birth time.',
      activations: [],
      orbDeg,
    };
  }
  const parsedBirth = parseDate(birthDate);
  if (!parsedBirth) {
    return { available: false, reason: 'Unparseable birth date.', activations: [], orbDeg };
  }
  const birth: BirthParts = parsedBirth;
  const ascendant: number = chart.ascendant;

  const fromParsed = parseIsoMs(fromIso);
  const toParsed = parseIsoMs(toIso);
  if (!Number.isFinite(fromParsed) || !Number.isFinite(toParsed)) {
    return { available: false, reason: 'Invalid date window.', activations: [], orbDeg };
  }
  const fromMs = startOfUtcDay(fromParsed);
  const toMs = startOfUtcDay(toParsed) + MS_PER_DAY - 1; // end of that day
  if (toMs <= fromMs) {
    return { available: false, reason: 'Invalid date window.', activations: [], orbDeg };
  }

  const uFrom = directedUnwrapped(birth, ascendant, fromMs);
  const uTo = directedUnwrapped(birth, ascendant, toMs);

  const activations: DirectedActivation[] = [];

  /** For an absolute longitude `X` (0–360), find the unwrapped value(s) of the
   *  directed point in [uFrom, uTo] that equal X (mod 360) and return their
   *  exact-hit ms (at most a couple given the short sweep). */
  function hitsForLongitude(X: number): number[] {
    const result: number[] = [];
    const xNorm = norm360(X);
    const kStart = Math.floor((uFrom - xNorm) / TWO_PI_DEG);
    const kEnd = Math.ceil((uTo - xNorm) / TWO_PI_DEG);
    for (let k = kStart; k <= kEnd; k++) {
      const U = xNorm + k * TWO_PI_DEG;
      if (U < uFrom - 1e-9 || U > uTo + 1e-9) continue;
      const ms = solveForUnwrapped(birth, ascendant, U, fromMs, toMs);
      if (ms != null) result.push(ms);
    }
    return result;
  }

  /** Window edges for an exact-hit at unwrapped U0: solve U0±orb, clamped to range. */
  function windowFor(U0: number): { start: string; end: string } {
    const lo = solveForUnwrapped(birth, ascendant, U0 - orbDeg, fromMs, toMs);
    const hi = solveForUnwrapped(birth, ascendant, U0 + orbDeg, fromMs, toMs);
    return { start: isoDay(lo ?? fromMs), end: isoDay(hi ?? toMs) };
  }

  // 1) Aspects to natal targets.
  for (const target of buildTargets(chart)) {
    for (const offset of ASPECT_OFFSETS) {
      const X = norm360(target.longitude + offset);
      for (const ms of hitsForLongitude(X)) {
        const U0 = directedUnwrapped(birth, ascendant, ms);
        const lon = norm360(U0);
        const win = windowFor(U0);
        const aspect = ASPECT_BY_OFFSET[offset]!;
        activations.push({
          exactDate: isoDay(ms),
          windowStart: win.start,
          windowEnd: win.end,
          directedLongitude: lon,
          directedPosition: formatLongitude(lon),
          kind: 'aspect',
          aspect,
          target: target.name,
          description: `directed point ${formatLongitude(lon)} ${aspect} ${target.name}, exact ${isoDay(ms)} (window ${win.start} → ${win.end})`,
        });
      }
    }
  }

  // 2) Egyptian-bound crossings.
  for (const b of boundBoundaries()) {
    for (const ms of hitsForLongitude(b.longitude)) {
      const U0 = directedUnwrapped(birth, ascendant, ms);
      const lon = norm360(U0);
      const win = windowFor(U0);
      activations.push({
        exactDate: isoDay(ms),
        windowStart: win.start,
        windowEnd: win.end,
        directedLongitude: lon,
        directedPosition: formatLongitude(lon),
        kind: 'bound',
        fromBoundRuler: b.from,
        toBoundRuler: b.to,
        description: `directed point crosses into ${b.to}'s Egyptian bound at ${formatLongitude(lon)} (leaving ${b.from}'s), exact ${isoDay(ms)}`,
      });
    }
  }

  activations.sort(
    (a, b) =>
      a.exactDate.localeCompare(b.exactDate) ||
      a.kind.localeCompare(b.kind) ||
      (a.target ?? '').localeCompare(b.target ?? ''),
  );

  return { available: true, activations, orbDeg };
}

/**
 * Bucket directed-profection activations by calendar month for a month-by-month
 * forecast, mirroring the transit ground-truth shape consumed by the annual
 * report. Returns 12 months starting at `startIso`.
 */
export function directedProfectionMonths(
  chart: NatalChart,
  birthDate: string,
  startIso: string,
): { available: boolean; reason?: string; months: Array<{ label: string; list: string }> } {
  const startParsed = parseIsoMs(startIso);
  if (!Number.isFinite(startParsed))
    return { available: false, reason: 'Invalid start date.', months: [] };
  const startMs = startOfUtcDay(startParsed);
  const sd = new Date(startMs);
  const endMs = Date.UTC(sd.getUTCFullYear() + 1, sd.getUTCMonth(), sd.getUTCDate());

  const res = directedProfectionsInRange(chart, birthDate, isoDay(startMs), isoDay(endMs));
  if (!res.available) return { available: false, reason: res.reason, months: [] };

  const byMonth = new Map<string, DirectedActivation[]>();
  for (const a of res.activations) {
    const key = a.exactDate.slice(0, 7); // yyyy-MM
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(a);
    else byMonth.set(key, [a]);
  }

  const months: Array<{ label: string; list: string }> = [];
  // Iterate 12 calendar months starting with the month containing `startIso`.
  let y = sd.getUTCFullYear();
  let m = sd.getUTCMonth(); // 0-based
  for (let i = 0; i < 12; i++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    const evs = byMonth.get(key) ?? [];
    months.push({
      label: `${MONTH_NAMES[m]} ${y}`,
      list: evs.length
        ? evs.map((a) => a.description).join('; ')
        : 'no directed-profection activation this month',
    });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return { available: true, months };
}
