/**
 * Zod request schemas. These validate and parse incoming JSON bodies and yield
 * values structurally compatible with the `@astroapp/shared` I/O types.
 */
import { z } from 'zod';
import type {
  AspectType,
  Ayanamsa,
  BirthData,
  HouseSystem,
  PlanetName,
  Zodiac,
  ZodiacSign,
} from '@astroapp/shared';

const houseSystemSchema: z.ZodType<HouseSystem> = z.enum([
  'placidus',
  'whole_sign',
  'koch',
  'equal',
]);

/** Optional zodiac frame (additive; defaults to tropical when omitted). */
const zodiacSchema: z.ZodType<Zodiac> = z.enum(['tropical', 'sidereal']);

/** Optional sidereal ayanamsa (defaults to lahiri when sidereal + omitted). */
const ayanamsaSchema: z.ZodType<Ayanamsa> = z.enum([
  'lahiri',
  'fagan_bradley',
  'krishnamurti',
  'raman',
]);

/** `yyyy-mm-dd`. */
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO yyyy-mm-dd');

/**
 * `HH:mm` 24h. Also accepts `HH:mm:ss` (Postgres `time` columns serialize with
 * seconds, e.g. "21:25:00") and normalizes to `HH:mm` for the time parser.
 */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'time must be HH:mm or HH:mm:ss (24h)')
  .transform((t) => t.slice(0, 5));

/**
 * BirthData. `time` may be null; we cross-check it against `timeKnown` so a
 * `timeKnown:true` request without a time is rejected.
 */
export const birthDataSchema = z
  .object({
    id: z.string().optional(),
    date: dateSchema,
    time: timeSchema.nullable(),
    timeKnown: z.boolean(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    tzIana: z.string().min(1),
    houseSystem: houseSystemSchema,
    // Additive + optional: omitting these preserves the historical tropical
    // behaviour exactly. `sidereal` shifts longitudes by the ayanamsa.
    zodiac: zodiacSchema.optional(),
    ayanamsa: ayanamsaSchema.optional(),
  })
  .refine((b) => !b.timeKnown || b.time !== null, {
    message: 'time is required when timeKnown is true',
    path: ['time'],
  }) satisfies z.ZodType<BirthData>;

export const natalRequestSchema = birthDataSchema;

export const transitsRequestSchema = z.object({
  natal: z.object({
    planets: z
      .array(
        z.object({
          name: z.string(),
          sign: z.string(),
          degree: z.number(),
          absoluteDegree: z.number(),
          house: z.number(),
          retrograde: z.boolean(),
          speed: z.number().optional(),
        }),
      )
      .min(1)
      // Cap the natal body count. A real chart has ≤ ~17 bodies (plus a handful
      // of asteroids/points); 64 is generous headroom. Without this ceiling, the
      // FREE single-day `/transits` path accepts an unauthenticated, fabricated
      // `planets` array of arbitrary length and the inner triple-loop
      // (samples × transiting bodies × natal planets × aspects) becomes an
      // unbounded synchronous DoS even when `stepDays`/window are well-formed.
      .max(64),
    houses: z.array(z.unknown()).optional(),
    aspects: z.array(z.unknown()).optional(),
    ascendant: z.number().optional(),
    midheaven: z.number().optional(),
    houseSystem: houseSystemSchema.optional(),
    computedAt: z.string().optional(),
  }),
  from: z.string().min(1),
  to: z.string().min(1),
  // Bounded sampling step (days). A floor of 0.01 (~14.4 min) prevents an
  // unauthenticated DoS: without it, `stepDays: 0.00001` makes `computeTransits`
  // run tens of millions of synchronous `swe_calc` calls and pins the event
  // loop. The ceiling (366d) keeps a step from skipping a whole year of events.
  stepDays: z.number().min(0.01).max(366).optional(),
});

export const synastryRequestSchema = z.object({
  a: birthDataSchema,
  b: birthDataSchema,
});

/** Composite + Davison relationship charts (TASK B5): two people in, one chart out. */
export const compositeRequestSchema = z.object({
  a: birthDataSchema,
  b: birthDataSchema,
});

export const davisonRequestSchema = z.object({
  a: birthDataSchema,
  b: birthDataSchema,
});

export const progressionsRequestSchema = z.object({
  birth: birthDataSchema,
  target: z.string().min(1),
});

/**
 * Astrocartography request (TASK B7). Just the birth data; the endpoint returns
 * the four angular lines (MC/IC/AC/DC) per body. Unknown-time births are handled
 * inside the computation (returns `available:false`), not rejected here.
 */
export const astrocartographyRequestSchema = z.object({
  birth: birthDataSchema,
});

/**
 * Solar & lunar returns (TASK C2). A `kind` discriminator chooses the body; the
 * `target` is the date the return is on/after (a bare `yyyy-mm-dd` or an ISO
 * datetime). `location` is OPTIONAL — when omitted the return is cast at the
 * NATAL location (documented default). Houses/Asc come from the resolved return
 * instant + this location, so a location is enough; no time field is needed.
 */
export const returnsRequestSchema = z.object({
  natal: birthDataSchema,
  kind: z.enum(['solar', 'lunar']),
  /** Date the return is on/after — bare `yyyy-mm-dd` or an ISO datetime. */
  target: z.string().min(1),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      tzIana: z.string().min(1),
    })
    .optional(),
});

/**
 * Vedic depth (TASK D5): nakshatras + Vimshottari dasha. Just the birth data
 * plus an OPTIONAL `now` (ISO) so the response can mark the current Maha/Antar
 * dasha. The frame is always sidereal (Lahiri by default); `birth.ayanamsa`
 * may override it. The sidereal Moon lookup + dasha math happen inside the
 * endpoint; nothing is rejected here beyond the shared BirthData validation.
 */
export const vedicRequestSchema = z.object({
  birth: birthDataSchema,
  /** Optional "now" instant (ISO) to mark the current Maha/Antar dasha. */
  now: z.string().min(1).optional(),
});

/**
 * Advanced pro-depth techniques (TASK B6): harmonics, midpoints, antiscia,
 * fixed stars. One endpoint discriminated by `technique`, all over the SAME
 * `birth` input the natal endpoint accepts. `harmonic` is required only for the
 * harmonics technique (validated below); the optional `orb` overrides the
 * technique's default contact orb.
 */
export const advancedRequestSchema = z
  .object({
    technique: z.enum(['harmonics', 'midpoints', 'antiscia', 'fixed_stars']),
    birth: birthDataSchema,
    /** Harmonic number (harmonics only); a positive integer, typically 4/5/7/9. */
    harmonic: z.number().int().min(1).max(64).optional(),
    /** Optional contact-orb override (degrees) for midpoints/antiscia/fixed stars. */
    orb: z.number().min(0).max(15).optional(),
  })
  .refine((b) => b.technique !== 'harmonics' || typeof b.harmonic === 'number', {
    message: 'harmonic is required when technique is "harmonics"',
    path: ['harmonic'],
  });

/**
 * Planetary hours request (TASK C3). A `date` + place to compute the 12 day +
 * 12 night seasonal hours for, plus an OPTIONAL `now` (ISO) so the response can
 * flag which hour is current. The astronomy (sunrise/sunset via `swe_rise_trans`)
 * and the polar-day/night unavailable path are handled inside the computation,
 * not rejected here.
 */
export const planetaryHoursRequestSchema = z.object({
  date: dateSchema,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tzIana: z.string().min(1),
  /** Optional "now" instant (ISO) to mark the current hour. */
  now: z.string().min(1).optional(),
});

/**
 * Configuration search (TASK C7). A discriminated union over `kind` describing
 * one of three scannable configurations over a `{ from, to }` date range:
 *
 *  - `aspect`  — a transiting aspect between two bodies `a`/`b` (e.g. Mars
 *    conjunct Jupiter). `aspect` selects the exact angle (0/60/90/120/180).
 *  - `ingress` — a body entering a sign; `sign` is OPTIONAL (omit for ALL of
 *    that body's sign ingresses in the window).
 *  - `station` — a planet's retrograde/direct stations (speed sign change).
 *
 * `from`/`to` accept a bare `yyyy-mm-dd` or an ISO datetime; the range is capped
 * server-side (see `search.ts` MAX_RANGE_DAYS) so a scan is always bounded.
 */
const planetNameSchema: z.ZodType<PlanetName> = z.enum([
  'Sun',
  'Moon',
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
  'Pluto',
  'Chiron',
  'NorthNode',
  'Lilith',
  'Ceres',
  'Pallas',
  'Juno',
  'Vesta',
]);

const aspectTypeSchema: z.ZodType<AspectType> = z.enum([
  'conjunction',
  'sextile',
  'square',
  'trine',
  'opposition',
]);

const zodiacSignSchema: z.ZodType<ZodiacSign> = z.enum([
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
]);

const searchRangeFields = {
  from: z.string().min(1),
  to: z.string().min(1),
};

export const searchRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('aspect'),
      a: planetNameSchema,
      b: planetNameSchema,
      aspect: aspectTypeSchema,
      ...searchRangeFields,
    })
    .refine((q) => q.a !== q.b, {
      message: 'aspect search needs two DIFFERENT bodies',
      path: ['b'],
    }),
  z.object({
    kind: z.literal('ingress'),
    body: planetNameSchema,
    sign: zodiacSignSchema.optional(),
    ...searchRangeFields,
  }),
  z.object({
    kind: z.literal('station'),
    body: planetNameSchema,
    ...searchRangeFields,
  }),
]);

export type SearchRequest = z.infer<typeof searchRequestSchema>;

/**
 * AI report request (TASK A8). The chart(s) are loaded server-side from the
 * caller's account; the body only selects the kind and, optionally, a specific
 * primary `chartId` and a second `partnerChartId` (compatibility, ties into A9).
 */
export const reportRequestSchema = z.object({
  kind: z.enum(['natal', 'annual', 'compatibility']),
  chartId: z.string().uuid().optional(),
  partnerChartId: z.string().uuid().optional(),
  labels: z.array(z.string()).optional(),
  /**
   * Annual reports only: the calendar year to forecast (past or future — the
   * ephemeris is deterministic for any date). Omit for the next 12 months.
   */
  year: z.number().int().min(1900).max(2200).optional(),
});

/**
 * Life Almanac request (deterministic life-transit timeline, PREMIUM). The
 * chart + birth date are loaded server-side from the caller's records;
 * `chartId` (optional) selects a specific chart, defaulting to the user's
 * canonical `self`.
 */
export const lifeAlmanacRequestSchema = z.object({
  chartId: z.string().uuid().optional(),
});

export type LifeAlmanacRequest = z.infer<typeof lifeAlmanacRequestSchema>;

/**
 * Electional / auspicious-timing request ("good days to do X"). Pure compute
 * from date + location — no chart needed. Returns a per-day table with factors
 * (Moon phase/sign, day ruler, retrogrades, void-of-course, Rahu Kalam) and a
 * verdict per activity. `days` is capped so the scan stays bounded.
 */
export const electionalRequestSchema = z.object({
  from: dateSchema,
  days: z.number().int().min(1).max(31).default(14),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tzIana: z.string().min(1),
});

export type ElectionalRequestBody = z.infer<typeof electionalRequestSchema>;

/**
 * Compatibility scoring request (deterministic synastry read, PREMIUM). Both
 * charts are loaded server-side from the caller's `birth_data` rows: `chartId`
 * (optional) selects the SELF birth record (defaults to the user's `self` row);
 * `partnerId` is the other person's birth_data id.
 */
export const compatibilityRequestSchema = z.object({
  chartId: z.string().uuid().optional(),
  partnerId: z.string().uuid(),
});

export type CompatibilityRequest = z.infer<typeof compatibilityRequestSchema>;

/**
 * Cosmic matchmaking request (PREMIUM). `intent` selects who qualifies —
 * profiles whose `looking_for` is the intent or 'both'. `limit` bounds the
 * returned matches (default 20). Everything else (the caller's chart, the
 * candidate scan) is loaded server-side; the body carries no birth data.
 */
export const matchesRequestSchema = z.object({
  intent: z.enum(['partners', 'friends']),
  limit: z.number().int().min(1).max(50).optional(),
});

export type MatchesRequest = z.infer<typeof matchesRequestSchema>;

/** Conversational AI astrologer turn (grounded, premium). */
export const interpretRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  chartId: z.string().uuid().optional(),
  label: z.string().optional(),
  /** Echoed back so the client can keep a stable thread id; not persisted here. */
  conversationId: z.string().nullable().optional(),
  /**
   * Prior turns for in-conversation memory (bounded). We TRUNCATE to the last 40
   * turns rather than rejecting longer histories, so long-running threads keep
   * working instead of permanently 400-ing once they exceed the cap.
   */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .transform((h) => h.slice(-40))
    .optional(),
  /**
   * Cost tier hint. `interpretation` routes a one-off placement body to the
   * cheap model (Haiku on Anthropic); `chat` (default) uses the standard chat
   * model (Sonnet). Ignored by Gemini.
   */
  tier: z.enum(['interpretation', 'chat']).optional(),
  /**
   * Client-sent transit facts for the <sky_today> context section. Deliberately
   * `unknown`: the route validates each entry STRICTLY via `validateTodayContext`
   * (known planets/aspects, ±14-day ISO exactAt, bounded orb) and silently drops
   * everything else — never trust the client shape here.
   */
  todayContext: z.unknown().optional(),
  /**
   * Whether this turn belongs in the user's CHAT HISTORY (`ai_conversations` /
   * `ai_messages`). Defaults to true — the conversational astrologer.
   *
   * `false` marks a ONE-OFF, machine-composed prompt from a non-chat surface
   * (tap-to-learn placement + synastry bodies, the journal's deeper-reflection
   * instruction). Those used to be persisted like real conversations, so the
   * history list filled up with our own internal prompts as thread titles.
   */
  persist: z.boolean().optional(),
});

/**
 * Birth-time rectification (TASK D4). The TIME is scanned across a `window`
 * (`HH:mm` 24h, no overnight wrap — `latest` must be after `earliest`) at
 * `stepMinutes`; the candidate count and the `events` count are both bounded so
 * the scan can never run unboundedly. Each event is a dated life event (`date` +
 * free-text `kind` + optional `weight`). The birth's own `time`/`timeKnown` are
 * irrelevant to the scan (we override the time per candidate), so they are
 * accepted as-is via `birthDataSchema`.
 */
const MAX_RECTIFY_EVENTS = 40;
const MAX_RECTIFY_CANDIDATES = 288;

export const rectifyRequestSchema = z
  .object({
    birth: birthDataSchema,
    window: z.object({
      earliest: timeSchema,
      latest: timeSchema,
    }),
    stepMinutes: z.number().int().min(1).max(720).optional(),
    events: z
      .array(
        z.object({
          date: dateSchema,
          kind: z.string().min(1).max(64),
          weight: z.number().positive().max(100).optional(),
        }),
      )
      .max(MAX_RECTIFY_EVENTS),
  })
  .superRefine((b, ctx) => {
    const toMin = (t: string): number => {
      const [h, m] = t.split(':');
      return Number(h) * 60 + Number(m);
    };
    const lo = toMin(b.window.earliest);
    const hi = toMin(b.window.latest);
    if (hi <= lo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`latest` must be after `earliest` (no overnight wrap)',
        path: ['window', 'latest'],
      });
      return;
    }
    const step = b.stepMinutes ?? 10;
    const count = Math.floor((hi - lo) / step) + 1;
    if (count > MAX_RECTIFY_CANDIDATES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window + stepMinutes yields ${count} candidates (max ${MAX_RECTIFY_CANDIDATES}); widen the step or narrow the window`,
        path: ['stepMinutes'],
      });
    }
  });

export type RectifyRequest = z.infer<typeof rectifyRequestSchema>;

export type TransitsRequest = z.infer<typeof transitsRequestSchema>;
export type SynastryRequest = z.infer<typeof synastryRequestSchema>;
export type CompositeRequest = z.infer<typeof compositeRequestSchema>;
export type DavisonRequest = z.infer<typeof davisonRequestSchema>;
export type ProgressionsRequest = z.infer<typeof progressionsRequestSchema>;
export type AstrocartographyRequest = z.infer<typeof astrocartographyRequestSchema>;
export type ReturnsRequest = z.infer<typeof returnsRequestSchema>;
export type PlanetaryHoursRequest = z.infer<typeof planetaryHoursRequestSchema>;
export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type VedicRequest = z.infer<typeof vedicRequestSchema>;
export type AdvancedRequest = z.infer<typeof advancedRequestSchema>;
