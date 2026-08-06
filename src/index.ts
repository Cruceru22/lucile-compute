/**
 * @astroapp/compute — Swiss Ephemeris calculation microservice.
 *
 * All astrology math happens here, server-side. The LLM interpretation layer
 * (A8) never computes a chart; it only consumes the typed JSON these endpoints
 * return. See README for time-handling, ephemeris, and licensing notes.
 */
// MUST be first: loads .env into process.env before any other module reads it.
import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { BirthData, NatalChart } from '@astroapp/shared';
import { initEphemeris, getBackend } from './ephemeris.js';
import { signFor } from './astro.js';
import {
  natalRequestSchema,
  transitsRequestSchema,
  synastryRequestSchema,
  compositeRequestSchema,
  davisonRequestSchema,
  progressionsRequestSchema,
  reportRequestSchema,
  advancedRequestSchema,
  astrocartographyRequestSchema,
  returnsRequestSchema,
  planetaryHoursRequestSchema,
  searchRequestSchema,
  vedicRequestSchema,
  rectifyRequestSchema,
  interpretRequestSchema,
  compatibilityRequestSchema,
  lifeAlmanacRequestSchema,
  electionalRequestSchema,
  matchesRequestSchema,
} from './schemas.js';
import { computeNatal } from './natal.js';
import { computeVedic } from './vedic.js';
import { computeReturn } from './returns.js';
import { searchConfigurations, type SearchRequest } from './search.js';
import { computePlanetaryHours } from './planetaryHours.js';
import { computeAstrocartography } from './astrocartography.js';
import {
  computeAntiscia,
  computeFixedStars,
  computeHarmonics,
  computeMidpoints,
} from './advanced.js';
import { computeTransits } from './transits.js';
import { computeSynastry } from './synastry.js';
import { computeComposite, computeDavison } from './relationship.js';
import { computeProgressions } from './progressions.js';
import { computeRectification, type RectifyRequest } from './rectification.js';
import { buildLifeAlmanac } from './lifeAlmanac.js';
import { buildElectional } from './electional.js';
import { createProvider } from './ai/provider.js';
import { isDailyQuotaError } from './ai/gemini-provider.js';
import { generateReport, interpretChat } from './ai/reportInterpreter.js';
import { buildContextSections, validateTodayContext } from './ai/contextInjection.js';
import { renderReportPdf } from './ai/pdf.js';
import {
  authenticate,
  checkEntitlement,
  EntitlementUnavailableError,
  loadBirthData,
  loadChart,
  loadChartByBirthDataId,
  loadConversationHistory,
  loadDiscoverableCandidates,
  loadPeopleWithBirth,
  loadSelfChart,
  normalizeAlternation,
  saveConversationTurn,
  StorageUnavailableError,
  trimLeadingAssistantTurns,
  uploadReport,
  type AuthedUser,
  type DiscoverableCandidate,
} from './ai/storage.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { scoreCompatibility, type CompatibilityResult } from './compatibility.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * AGPL-3.0 §13 (Remote Network Interaction): because this service links the
 * Swiss Ephemeris (`sweph`, AGPL-3.0), the running service must offer users who
 * interact with it over the network the Corresponding Source. We satisfy that by
 * publishing this service's source and advertising the URL on every response (a
 * `Link: …; rel="source"` header) and in `/health`. Point `PUBLIC_SOURCE_URL` at
 * wherever the compute service's source is published. See ./README.md.
 */
const PUBLIC_SOURCE_URL =
  process.env.PUBLIC_SOURCE_URL ?? 'https://github.com/Cruceru22/lucile-compute';

/**
 * In-memory idempotency guard for /report. A double-submit (the client retries,
 * or the user taps twice) would otherwise trigger two PAID generations and leave
 * an orphaned PDF. We key an in-flight generation by
 * `${userId}:${kind}:${chartId}:${partnerChartId}:${year}` and, while one is
 * running for that key, return the SAME promise to every concurrent caller — so
 * a duplicate request rides the first generation's result instead of starting a
 * second. Memory-only (per-process) and self-cleaning: the entry is deleted once
 * the generation settles. Not a cross-instance lock — it dedupes the common
 * single-instance double-submit, which is the actual failure here.
 */
const inFlightReports = new Map<string, Promise<unknown>>();

// Initialise the ephemeris backend once at startup.
const backend = initEphemeris();

/**
 * OPTIONAL grounded "bigger picture" paragraph for a compatibility reading.
 *
 * Synthesises ONLY the already-computed deterministic facts (the named top
 * harmonies + frictions with their one-liners, the score, and the band) into a
 * single human paragraph. The prompt forbids inventing aspects and instructs a
 * specific, non-fatalist second-person voice.
 *
 * NON-FATAL by contract: every failure path (provider unconfigured, quota, 503,
 * empty completion) returns `null`, so the caller simply omits `synthesis` and
 * still returns the full deterministic reading. NEVER throws.
 *
 * It is also TIME-BOUNDED: the provider call is raced against
 * {@link SYNTHESIS_TIMEOUT_MS} so a slow/rate-limited LLM can never hang the
 * core deterministic compatibility response — on timeout we degrade to no
 * `synthesis`.
 */
const SYNTHESIS_TIMEOUT_MS = 6000;

async function synthesiseCompatibility(
  result: CompatibilityResult,
  selfLabel: string,
  partnerLabel: string,
): Promise<string | null> {
  try {
    const provider = createProvider('chat');

    const list = (items: CompatibilityResult['harmonies']): string =>
      items.length === 0
        ? '(none)'
        : items
            .map((c) => `- ${c.a} ${c.type} ${c.b} (orb ${c.orb.toFixed(1)}°): ${c.text}`)
            .join('\n');

    const facts = [
      `Score: ${result.score}/100, band "${result.bandLabel}".`,
      result.timeLimited
        ? 'Note: a birth time was missing, so the Moon, houses and angles were left out.'
        : '',
      '',
      'Top harmonies (where it flows):',
      list(result.harmonies),
      '',
      'Top frictions (where it grips):',
      list(result.frictions),
    ]
      .filter(Boolean)
      .join('\n');

    const system = [
      'You are an astrologer writing ONE short "bigger picture" paragraph about a',
      'relationship synastry. You are given the ALREADY-COMPUTED facts below and',
      'must not invent anything beyond them.',
      '',
      'Rules:',
      `- Address the reader as "you"; the other person is "${partnerLabel}".`,
      '- Ground EVERY claim in the provided aspects, and name them (e.g. "your Venus',
      '  trine their Mars").',
      '- Be specific and concrete, not generic; non-fatalist, friction is growth,',
      '  not doom.',
      '- Synthesise harmonies AND frictions into a single coherent read consistent',
      `  with the band ("${result.bandLabel}").`,
      '- Exactly ONE paragraph, 3–5 sentences. No headings, no lists, no preamble.',
    ].join('\n');

    const user = `Facts about ${selfLabel} and ${partnerLabel}:\n\n${facts}`;

    // Race the provider against a short timeout: a slow or rate-limited LLM must
    // never hang the (already-complete) deterministic compatibility result.
    const res = await Promise.race([
      provider.chat({
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 512,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNTHESIS_TIMEOUT_MS)),
    ]);
    if (!res) return null; // timed out → degrade to no synthesis.

    const text = res.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return text.length > 0 ? text : null;
  } catch {
    // Quota / 503 / unconfigured provider / anything — degrade gracefully.
    return null;
  }
}

/**
 * Single server-side auth + premium gate for every PREMIUM endpoint.
 *
 * Verifies the caller's Supabase JWT (Bearer) and the authoritative
 * `subscriptions` entitlement, then maps the outcome to a status code:
 *   - no/invalid token            → 401 `unauthorized`
 *   - read succeeded, NOT premium → 403 `premium_required`
 *   - entitlement read FAILED     → 503 `entitlement_unavailable` (retryable)
 *
 * The 503 path is the security fix for "fail-closed-as-403": a transient
 * subscriptions read error must never tell a paying user to buy. On success it
 * returns the {@link AuthedUser}; otherwise it sends the response and returns
 * null, so callers do `const user = await requirePremium(...); if (!user) return;`.
 */
async function requirePremium(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const authHeader = request.headers.authorization ?? '';
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : undefined;
  const user = await authenticate(token);
  if (!user) {
    await reply.status(401).send({ error: 'unauthorized' });
    return null;
  }
  try {
    const premium = await checkEntitlement(user);
    if (!premium) {
      await reply.status(403).send({ error: 'premium_required' });
      return null;
    }
  } catch (err) {
    if (err instanceof EntitlementUnavailableError) {
      // Premium UNKNOWN (transient DB/network) → retryable, NOT a wrong 403.
      await reply.status(503).send({ error: 'entitlement_unavailable' });
      return null;
    }
    throw err;
  }
  return user;
}

export function buildApp() {
  const app = Fastify({ logger: true });

  // CORS so the web build (a browser origin, e.g. http://localhost:8081) can
  // call the compute service cross-origin. Native clients (Expo Go / dev builds)
  // don't enforce CORS, but browsers do. In production, set `CORS_ORIGINS` to a
  // comma-separated allowlist of known app/web origins so we DON'T reflect any
  // origin. When `CORS_ORIGINS` is unset (local dev) we fall back to reflecting
  // any origin (`origin: true`) for convenience.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  void app.register(cors, { origin: corsOrigins.length > 0 ? corsOrigins : true });

  // AGPL-3.0 §13 source offer: advertise the Corresponding Source URL on EVERY
  // response, so any network client of this (Swiss-Ephemeris-linked) service is
  // told where to get its source. `Link: <url>; rel="source"` is a standard,
  // machine-readable way to make that offer.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Link', `<${PUBLIC_SOURCE_URL}>; rel="source"`);
  });

  app.get('/health', async () => {
    return { status: 'ok', ephemerisBackend: getBackend(), source: PUBLIC_SOURCE_URL } as const;
  });

  // POST /natal — body: BirthData -> NatalChartResponse
  app.post('/natal', async (request, reply) => {
    const parsed = natalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    return computeNatal(parsed.data);
  });

  // POST /transits — body: { natal, from, to } -> { events: TransitEvent[] }
  app.post('/transits', async (request, reply) => {
    const parsed = transitsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { natal, from, to, stepDays } = parsed.data;
    // The multi-day transit TIMELINE is premium; only the single-day "today"
    // highlight (which the free Today/Sky screen depends on) is unauthenticated.
    // Determine the requested span from [from, to): a window of <= ~1 day stays
    // free; anything wider requires premium. We add a small epsilon so a request
    // spanning exactly one calendar day (e.g. midnight→midnight, or a slightly
    // over-24h client window for a single day) is still treated as free.
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const spanMs = Number.isFinite(fromMs) && Number.isFinite(toMs) ? toMs - fromMs : Infinity;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const SINGLE_DAY_EPSILON_MS = 60 * 60 * 1000; // 1h slack around a single-day window
    // A genuine single-day window is a POSITIVE span of <= ~1 day. A reversed or
    // zero-length window (`from >= to`, spanMs <= 0) must NOT slip through the
    // free single-day gate — otherwise an unauthenticated caller can pass any
    // `from > to` and have it treated as a free request (computeTransits then
    // rejects it, but the premium gate was bypassed). Require a positive span.
    const isSingleDay = spanMs > 0 && spanMs <= ONE_DAY_MS + SINGLE_DAY_EPSILON_MS;
    if (!isSingleDay) {
      if (!(await requirePremium(request, reply))) return reply;
    }
    try {
      const events = computeTransits(natal as unknown as NatalChart, from, to, { stepDays });
      return { events };
    } catch (err) {
      return reply.status(400).send({
        error: 'transit_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /synastry — body: { a, b } -> { aspects }
  app.post('/synastry', async (request, reply) => {
    const parsed = synastryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    return computeSynastry(parsed.data.a, parsed.data.b);
  });

  // POST /composite — body: { a, b } -> CompositeChart (midpoint composite, TASK B5)
  app.post('/composite', async (request, reply) => {
    const parsed = compositeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeComposite(parsed.data.a, parsed.data.b);
    } catch (err) {
      return reply.status(400).send({
        error: 'composite_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /davison — body: { a, b } -> DavisonChart (time/space midpoint, TASK B5)
  app.post('/davison', async (request, reply) => {
    const parsed = davisonRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeDavison(parsed.data.a, parsed.data.b);
    } catch (err) {
      return reply.status(400).send({
        error: 'davison_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /progressions — body: { birth, target } -> ProgressionsResult
  app.post('/progressions', async (request, reply) => {
    const parsed = progressionsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeProgressions(parsed.data.birth, parsed.data.target);
    } catch (err) {
      return reply.status(400).send({
        error: 'progression_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /rectify — birth-time rectification (TASK D4).
  //
  // For an APPROXIMATE birth, scan candidate times across `window` at
  // `stepMinutes` and RANK them by how well the user's dated life events line up
  // with TIME-dependent techniques (the natal angles + slow predictive contacts
  // to them). Returns ranked candidates with per-event rationale, the best
  // estimate, and an honest disclaimer (this is a heuristic AID, not certainty).
  // Bounded by candidate + event caps (enforced in the schema and the scanner).
  // Reuses the natal angle (houses), progression, and body calcs; no existing
  // endpoint changes.
  app.post('/rectify', async (request, reply) => {
    const parsed = rectifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeRectification(parsed.data as RectifyRequest);
    } catch (err) {
      return reply.status(400).send({
        error: 'rectify_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /advanced — pro-depth techniques (TASK B6): harmonics, midpoints,
  // antiscia, fixed stars. One endpoint discriminated by `technique`, all over
  // the same BirthData the /natal endpoint accepts. These are pure transforms
  // of the chart we already compute; no existing endpoint changes.
  app.post('/advanced', async (request, reply) => {
    const parsed = advancedRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    const { technique, birth, harmonic, orb } = parsed.data;
    try {
      switch (technique) {
        case 'harmonics':
          // `harmonic` is guaranteed present for this technique by the schema.
          return computeHarmonics(birth, harmonic as number);
        case 'midpoints':
          return computeMidpoints(birth, orb);
        case 'antiscia':
          return computeAntiscia(birth, orb);
        case 'fixed_stars': {
          // Fixed-star conjunctions can include the chart angles; derive them
          // from a natal compute (only meaningful when the birth time is known).
          const natal = computeNatal(birth);
          const angles =
            natal.housesAvailable && natal.ascendant !== null && natal.midheaven !== null
              ? { ascendant: natal.ascendant, midheaven: natal.midheaven }
              : { ascendant: null, midheaven: null };
          return computeFixedStars(birth, angles, orb);
        }
      }
    } catch (err) {
      return reply.status(400).send({
        error: 'advanced_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /astrocartography — body: { birth: BirthData } -> AstrocartographyResult
  //
  // Astrocartography (TASK B7): the four angular lines (MC/IC/AC/DC) per body
  // across the Earth at the birth instant. Pure read-only spherical astronomy
  // over the SAME BirthData the /natal endpoint accepts; no existing endpoint
  // changes. Unknown-time births return `available:false` (lines would be
  // meaningless — the map shifts ~15°/hour), handled inside the computation.
  app.post('/astrocartography', async (request, reply) => {
    const parsed = astrocartographyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeAstrocartography(parsed.data.birth);
    } catch (err) {
      return reply.status(400).send({
        error: 'astrocartography_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /returns — body: { natal, kind: 'solar' | 'lunar', target, location? }
  //
  // Solar & lunar returns (TASK C2). Root-finds the instant the transiting
  // Sun/Moon reaches its natal longitude on/after `target`, then computes a full
  // natal-style chart for that instant at the chosen `location` (default: the
  // natal location). Reuses the natal builder + planet calc; no existing
  // endpoint changes. Unknown natal time degrades confidence (flagged in the
  // response), never the houses (the return instant + place are exact).
  app.post('/returns', async (request, reply) => {
    const parsed = returnsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeReturn(parsed.data);
    } catch (err) {
      return reply.status(400).send({
        error: 'returns_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /planetary-hours — body: { date, lat, lon, tzIana, now? }
  //
  // Traditional (seasonal/unequal) planetary hours (TASK C3). Computes sunrise,
  // sunset, and the next day's sunrise for the date + place via swe_rise_trans
  // (Sun disc-center crossing, with refraction — see planetaryHours.ts), then
  // splits the day span into 12 day-hours and the night span into 12 night-hours
  // and assigns each its Chaldean ruler. Returns the weekday, the 24-ruler
  // sequence, both half-day lists, and — when `now` is given — the current hour.
  // Polar day/night (the Sun does not rise/set) returns `available:false` with a
  // reason; no hours are fabricated. No existing endpoint changes.
  app.post('/planetary-hours', async (request, reply) => {
    const parsed = planetaryHoursRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computePlanetaryHours(parsed.data);
    } catch (err) {
      return reply.status(400).send({
        error: 'planetary_hours_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /timing — electional / auspicious-timing ("good days to do X").
  // Deterministic, tradition-based scoring per day from date + location (no
  // chart): Moon phase/sign, planetary day ruler, retrogrades, void-of-course
  // Moon, Rahu Kalam → a verdict per activity. Framed as guidance, not prediction.
  app.post('/timing', async (request, reply) => {
    const parsed = electionalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return buildElectional(parsed.data);
    } catch (err) {
      return reply.status(400).send({
        error: 'timing_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /search — configuration search engine (TASK C7).
  //
  // Astro-Seek-style scan of the ephemeris over a `{ from, to }` date range for
  // astrological configurations: transiting ASPECTS between two bodies, sign
  // INGRESSES of a body, and retrograde/direct STATIONS of a planet. Each kind
  // defines a continuous f(jd) whose roots mark the events; we sample on a coarse
  // per-kind grid and refine every bracketed root with the SAME hybrid
  // Newton/bisection root-finder C2 uses, returning the EXACT instant of each.
  // The scan is bounded three ways (range cap + step size + result cap) so it can
  // never run unboundedly; results beyond the cap set `truncated`. Read-only;
  // reuses the existing planet calc + root-finder. No existing endpoint changes.
  app.post('/search', async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return searchConfigurations(parsed.data as SearchRequest);
    } catch (err) {
      return reply.status(400).send({
        error: 'search_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /vedic — body: { birth: BirthData, now? } -> VedicResult (TASK D5).
  //
  // Vedic depth: each body's NAKSHATRA (lunar mansion + pada; Moon highlighted)
  // and the VIMSHOTTARI DASHA (the 120-year planetary-period timeline seeded by
  // the Moon's nakshatra — Maha-dashas with ISO start/end dates, the current
  // Maha-dasha, and its Antar-dasha breakdown). Always computed in the SIDEREAL
  // frame (Lahiri ayanamsa by default — reuses C6's sidereal path), over the SAME
  // BirthData the /natal endpoint accepts. Read-only; no existing endpoint
  // changes. `now` (optional) marks the active Maha/Antar dasha.
  app.post('/vedic', async (request, reply) => {
    const parsed = vedicRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    if (!(await requirePremium(request, reply))) return reply;
    try {
      return computeVedic(parsed.data.birth, parsed.data.now);
    } catch (err) {
      return reply.status(400).send({
        error: 'vedic_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /report — generate a validated AI PDF report (TASK A8, PREMIUM).
  //
  // Auth: caller's Supabase JWT (Bearer). Premium is enforced SERVER-SIDE from
  // `subscriptions`. The chart(s) are loaded service-side; the AI content is
  // produced with the SAME chart2txt + tool-use + claim-validation guarantees as
  // the chat path, rendered to PDF, uploaded to the private `reports` bucket, and
  // returned as a short-lived signed URL. API keys never leave the server.
  app.post('/report', async (request, reply) => {
    const parsed = reportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const user = await requirePremium(request, reply);
    if (!user) return reply;

    const { kind, chartId, partnerChartId, labels, year } = parsed.data;
    // Ground the report's PRIMARY chart on the canonical SELF record, never the
    // newest chart across ALL birth_data rows. Saved partners/exes are upserted
    // under the user's own user_id, so loadChart() with no chartId could return a
    // partner's chart and the report would be grounded on someone else's
    // placements (the /interpret path was already fixed; /report was not). Honor
    // an explicit chartId when supplied; otherwise resolve self specifically.
    let primary;
    let charts;
    // Annual reports use directed profections, which need the birth DATE (to
    // anchor the profection year). Loaded only for the annual path.
    let primaryBirthDate: string | undefined;
    try {
      primary = chartId ? await loadChart(user, chartId) : await loadSelfChart(user);
      if (!primary) return reply.status(404).send({ error: 'no_chart' });
      charts = [primary];
      if (kind === 'annual') {
        const birth = chartId ? await loadBirthData(user, chartId) : await loadBirthData(user);
        primaryBirthDate = birth?.date;
      }
      if (kind === 'compatibility') {
        // A compatibility report REQUIRES a real second chart. Without a
        // partnerChartId (or when its chart can't be loaded) we must NOT silently
        // downgrade to a single-chart reading titled "Compatibility Report" —
        // reject so the client supplies a partner.
        if (!partnerChartId) return reply.status(400).send({ error: 'partner_required' });
        const partner = await loadChart(user, partnerChartId);
        if (!partner) return reply.status(404).send({ error: 'partner_required' });
        charts.push(partner);
      }
    } catch (err) {
      // A transient storage read failure must be retryable (503), NOT a wrong 404
      // "compute your chart first" for a user who actually has a chart.
      if (err instanceof StorageUnavailableError) {
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }

    let provider;
    try {
      provider = createProvider('report'); // premium deep-dive → Opus
    } catch {
      return reply.status(500).send({ error: 'provider_unconfigured' });
    }

    // Annual reports can target any calendar year (past or future); the window
    // starts Jan 1 of that year. Other kinds ignore `year`.
    const nowIso =
      kind === 'annual' && year ? `${year}-01-01T00:00:00.000Z` : new Date().toISOString();

    // Idempotency: dedupe a generation already in flight for the SAME key (a
    // double-submit). Concurrent duplicates ride the first generation's promise
    // instead of triggering a second paid run + orphaned PDF. Keyed per user so
    // it can never collide across users. The provider variable is captured above.
    const idemKey = `${user.userId}:${kind}:${chartId ?? ''}:${partnerChartId ?? ''}:${year ?? ''}`;

    // Map a generation failure to a reply, distinguishing a per-DAY AI quota
    // (429 "resets tomorrow") from a generic transient failure (502).
    const replyReportError = (err: unknown): FastifyReply => {
      const message = err instanceof Error ? err.message : String(err);
      if (isDailyQuotaError(err)) {
        return reply.status(429).send({ error: 'ai_daily_limit', message });
      }
      return reply.status(502).send({ error: 'report_failed', message });
    };

    const existing = inFlightReports.get(idemKey);
    if (existing) {
      try {
        return await existing;
      } catch (err) {
        return replyReportError(err);
      }
    }

    const job = (async () => {
      const report = await generateReport(
        provider,
        charts,
        kind,
        labels ?? [],
        nowIso,
        primaryBirthDate,
      );
      const pdf = await renderReportPdf(report);
      const { path, signedUrl } = await uploadReport(user, kind, pdf);
      return {
        ok: true,
        kind,
        title: report.title,
        path,
        signedUrl,
        hallucinationsCaught: report.hallucinationsCaught,
        failedSections: report.failedSections,
      };
    })();
    inFlightReports.set(idemKey, job);

    try {
      return await job;
    } catch (err) {
      return replyReportError(err);
    } finally {
      // Self-clean: once the generation settles (success or failure), drop the
      // entry so a later, deliberate regeneration for the same key can run.
      inFlightReports.delete(idemKey);
    }
  });

  // POST /life-almanac — deterministic personal life-transit timeline (PREMIUM).
  //
  // Auth mirrors /report: caller's Supabase JWT (Bearer); premium enforced
  // server-side. The chart + the birth date are loaded service-side (self or a
  // specific `chartId`), then `buildLifeAlmanac` computes returns, cycle phases
  // and personalized outer-planet hits from birth to ~5y past now — no LLM.
  app.post('/life-almanac', async (request, reply) => {
    const parsed = lifeAlmanacRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const user = await requirePremium(request, reply);
    if (!user) return reply;

    // `chartId` here is a BIRTH_DATA id (matching the /compatibility convention),
    // NOT a `charts.id`. Resolve the person's birth record first, then load THAT
    // person's chart by `birth_data_id`, so the chart and the birth date always
    // come from the same person (the old code filtered two different tables'
    // primary keys with one id, so an explicit chartId 404'd and the default path
    // could mismatch chart vs birth_data).
    const { chartId } = parsed.data;
    let birth;
    let chart;
    try {
      birth = await loadBirthData(user, chartId);
      if (!birth) return reply.status(404).send({ error: 'no_birth_data' });
      chart = await loadChartByBirthDataId(user, birth.id!);
      if (!chart) return reply.status(404).send({ error: 'no_chart' });
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }

    try {
      const almanac = buildLifeAlmanac(chart, birth.date, new Date().toISOString());
      return almanac;
    } catch (err) {
      return reply.status(502).send({
        error: 'almanac_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /compatibility — deterministic synastry compatibility score (PREMIUM).
  //
  // Auth mirrors /report: caller's Supabase JWT (Bearer); premium enforced
  // server-side. Both birth records are loaded service-side (self = chartId or
  // the user's 'self' row; partner = partnerId), synastry aspects computed, and
  // the score/bands/domains/one-liners are ALL computed locally with no LLM — the
  // core result is deterministic. An OPTIONAL "bigger picture" `synthesis`
  // paragraph is then added best-effort via the LLM, but it is non-fatal AND
  // time-bounded (see synthesiseCompatibility), so it can neither fail nor slow
  // the deterministic reading.
  app.post('/compatibility', async (request, reply) => {
    const parsed = compatibilityRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const user = await requirePremium(request, reply);
    if (!user) return reply;

    const { chartId, partnerId } = parsed.data;
    let self;
    let partner;
    try {
      [self, partner] = await Promise.all([
        loadBirthData(user, chartId),
        loadBirthData(user, partnerId),
      ]);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }
    if (!self || !partner) return reply.status(404).send({ error: 'no_chart' });

    try {
      const { aspects } = computeSynastry(self, partner);
      const result = scoreCompatibility(aspects, {
        timeKnownA: self.timeKnown,
        timeKnownB: partner.timeKnown,
      });

      // OPTIONAL grounded "bigger picture" paragraph. Non-fatal: the
      // deterministic result above is already complete and is returned no matter
      // what happens here. We only ADD `synthesis` if the AI call succeeds —
      // quota/503/misconfig must never 502 the whole reading. The provider has
      // retry + model fallback built in.
      // BirthData carries no display name; use neutral second-person labels.
      const synthesis = await synthesiseCompatibility(result, 'you', 'your partner');
      if (synthesis) result.synthesis = synthesis;

      return result;
    } catch (err) {
      return reply.status(502).send({
        error: 'compatibility_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Scan cap for /matches: we load + score at most this many candidate profiles
   * per request. A DELIBERATE v1 bound — each candidate costs a synastry + natal
   * computation, so beyond this cap we need PRECOMPUTED scores (a matches table
   * refreshed offline), not a bigger synchronous scan.
   */
  const MATCH_SCAN_CAP = 200;

  /** One entry of the /matches response. Public profile + score — NO birth fields. */
  interface MatchEntry {
    userId: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    lookingFor: string;
    score: number;
    band: CompatibilityResult['band'];
    bandLabel: string;
    sunSign: string | null;
    moonSign: string | null;
    ascSign: string | null;
    timeKnown: boolean;
    connectionStatus: DiscoverableCandidate['connectionStatus'];
  }

  // POST /matches — premium cosmic matchmaking (PREMIUM).
  //
  // Auth mirrors /compatibility: caller's Supabase JWT (Bearer), premium enforced
  // server-side. The caller's SELF birth record and up to MATCH_SCAN_CAP
  // discoverable, non-blocked candidate profiles are loaded service-side; each
  // candidate's SELF chart is scored against the caller's via deterministic
  // synastry compatibility, and the top matches come back sorted by score.
  //
  // PRIVACY INVARIANT: the response contains NO birth fields — no date, time,
  // lat, lon, or tzIana. Only public profile fields, the score/band, and coarse
  // sun/moon/ascendant SIGNS leave the server. Every match object is constructed
  // EXPLICITLY (never spread from the candidate, which carries the birth row).
  app.post('/matches', async (request, reply) => {
    const parsed = matchesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const user = await requirePremium(request, reply);
    if (!user) return reply;

    const { intent, limit } = parsed.data;

    let selfBirth: BirthData | null = null;
    let candidates: DiscoverableCandidate[] = [];
    try {
      selfBirth = await loadBirthData(user); // no id → canonical self record
      if (selfBirth) {
        candidates = await loadDiscoverableCandidates(user.userId, intent, MATCH_SCAN_CAP);
      }
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        // Transient DB failure — retryable, never a permanent "no chart"/empty list.
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }
    if (!selfBirth) return reply.status(404).send({ error: 'no_chart' });

    const matches: MatchEntry[] = [];
    for (const candidate of candidates) {
      // Candidates without a SELF birth record can't be scored — skip them.
      if (!candidate.birth) continue;
      try {
        const { aspects } = computeSynastry(selfBirth, candidate.birth);
        const compat = scoreCompatibility(aspects, {
          timeKnownA: selfBirth.timeKnown,
          timeKnownB: candidate.birth.timeKnown,
        });
        const natal = computeNatal(candidate.birth);
        const sunSign = natal.planets.find((p) => p.name === 'Sun')?.sign ?? null;
        const moonSign = natal.planets.find((p) => p.name === 'Moon')?.sign ?? null;
        // The Ascendant needs a known birth time (houses); otherwise omit it.
        const ascSign =
          natal.housesAvailable !== false && natal.ascendant != null
            ? signFor(natal.ascendant)
            : null;
        matches.push({
          userId: candidate.userId,
          username: candidate.username,
          displayName: candidate.displayName,
          avatarUrl: candidate.avatarUrl,
          bio: candidate.bio,
          lookingFor: candidate.lookingFor,
          score: compat.score,
          band: compat.band,
          bandLabel: compat.bandLabel,
          sunSign,
          moonSign,
          ascSign,
          timeKnown: candidate.birth.timeKnown,
          connectionStatus: candidate.connectionStatus,
        });
      } catch (err) {
        // One bad candidate (corrupt birth row, out-of-range date, …) must never
        // 500 the whole match list — skip them and log it.
        request.log.warn(
          { err, candidateId: candidate.userId },
          'matches: skipping candidate whose computation failed',
        );
      }
    }

    matches.sort((x, y) => y.score - x.score);
    return { matches: matches.slice(0, limit ?? 20) };
  });

  // Conversational AI astrologer (TASK A8): grounded, validated chat turn against
  // the user's own chart. Replaces the never-deployed `ai-interpret` Edge Function
  // — same Gemini provider + anti-hallucination machinery as /report.
  app.post('/interpret', async (request, reply) => {
    const parsed = interpretRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const user = await requirePremium(request, reply);
    if (!user) return reply;

    const { prompt, chartId, label, conversationId, history, tier, todayContext, persist } =
      parsed.data;
    // <sky_today> context: strictly validated transit facts (bad entries are
    // dropped, never repaired). Journal parity with the Edge Function is a
    // deliberate follow-up — see ./ai/contextInjection.ts.
    const contextSections = buildContextSections([], validateTodayContext(todayContext));
    // Ground the chat's PRIMARY chart on the canonical SELF record, never the
    // newest chart across all birth_data rows. Saved partners/exes are upserted
    // under the user's own user_id, so loadChart() with no chartId could return a
    // partner's chart and the assistant would answer about the user grounded on
    // someone else's placements. When the client passes an explicit chartId we
    // honour it; otherwise we resolve self specifically.
    let chart;
    try {
      chart = chartId ? await loadChart(user, chartId) : await loadSelfChart(user);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }
    if (!chart) return reply.status(404).send({ error: 'no_chart' });

    // One-off placement interpretations are cheap (Haiku); the conversational
    // astrologer — including any threaded turn — gets Sonnet. Anthropic only.
    const isOneOff = tier === 'interpretation' && !conversationId && (history ?? []).length === 0;
    const modelTier = isOneOff ? 'interpretation' : 'chat';
    // Only the CHAT belongs in `ai_conversations`. Non-chat surfaces (tap-to-learn
    // placement + synastry bodies, the journal reflection prompt) send prompts we
    // composed ourselves; persisting those created a thread per tap, titled with
    // our own instruction text, which then showed up in the user's chat history.
    // Callers opt out explicitly with `persist: false`; a one-off
    // `tier: 'interpretation'` call is treated the same way as a safety net for
    // any caller that forgets. Threaded turns always persist.
    const shouldPersist = persist !== false && !isOneOff;
    let provider;
    try {
      provider = createProvider(modelTier);
    } catch {
      return reply.status(500).send({ error: 'provider_unconfigured' });
    }

    // Load saved people WITH birth data + the user's own birth data, so the
    // assistant can compute synastry/compatibility on demand when asked about a
    // specific person (grounded, never invented).
    let selfBirth;
    let relationships;
    try {
      [selfBirth, relationships] = await Promise.all([
        loadBirthData(user),
        loadPeopleWithBirth(user),
      ]);
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        return reply.status(503).send({ error: 'storage_unavailable' });
      }
      throw err;
    }
    // Server-side memory fallback: if resuming a thread but the client sent no
    // history (offline / failed loadMessages), reload it from ai_messages so the
    // model actually remembers instead of silently losing context.
    let effectiveHistory = history ?? [];
    if (conversationId && effectiveHistory.length === 0) {
      effectiveHistory = await loadConversationHistory(user, conversationId);
    }
    // Whether the history came from the CLIENT or the server reload, it must
    // start with a USER turn — a leading assistant turn makes the provider 400
    // (surfaced as a 502). The reload path already trims, but a client-supplied
    // history does not, so normalise here unconditionally before interpreting.
    effectiveHistory = trimLeadingAssistantTurns(effectiveHistory);
    // Also collapse any CONSECUTIVE same-role turns anywhere in the history — a
    // malformed history (e.g. an empty assistant reply once persisted, leaving
    // two adjacent user turns) would otherwise produce consecutive same-role
    // messages → Gemini 400 → 502. This makes the alternation safe end to end.
    effectiveHistory = normalizeAlternation(effectiveHistory);
    try {
      const result = await interpretChat(
        provider,
        chart,
        prompt,
        effectiveHistory,
        label,
        relationships,
        selfBirth,
        contextSections,
      );
      // Persist this turn server-side so the thread list + resume work. NON-FATAL:
      // saveConversationTurn never throws — on a DB failure it returns the
      // passed-in id (or null), so the chat still responds even if the
      // ai_conversations migration hasn't been applied.
      //
      // ONLY persist when the assistant actually produced text. An empty reply
      // (safety block / truncation) must NOT be written as an empty assistant
      // `ai_messages` row: on resume that leaves the history ending on a user
      // turn followed by an empty assistant turn, so the next real user turn
      // makes two consecutive user turns → Gemini 400 → 502 forever. When empty,
      // we skip the save but still return the existing conversationId so the
      // thread is unchanged.
      const savedConversationId =
        shouldPersist && result.text.trim()
          ? await saveConversationTurn(user, conversationId ?? null, prompt, result.text)
          : (conversationId ?? null);
      return {
        text: result.text,
        toolRounds: result.toolRounds,
        hallucinationsCaught: result.hallucinationsCaught,
        validated: result.validated,
        conversationId: savedConversationId,
      };
    } catch (err) {
      // A per-DAY quota (resets at midnight PT) is distinct from a transient
      // per-minute throttle: the client should message "daily AI limit reached —
      // resets tomorrow", not "try again in a moment". Surface it as a 429 with a
      // dedicated error code so the client can branch on it.
      if (isDailyQuotaError(err)) {
        return reply.status(429).send({
          error: 'ai_daily_limit',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.status(502).send({
        error: 'interpret_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildApp();
  app.log.info({ ephemerisBackend: backend }, 'compute service starting');
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

// Only auto-start when run directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
