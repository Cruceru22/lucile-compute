/**
 * Supabase auth, premium enforcement, chart loading, and private-bucket upload
 * for report generation (TASK A8).
 *
 * The compute service uses the SERVICE-ROLE key (server-side only) to verify the
 * caller's JWT, read the authoritative `subscriptions` entitlement, load the
 * user's chart, and upload the PDF to a PRIVATE Storage bucket, returning a
 * short-lived signed URL. The client is never trusted for entitlement, and no
 * Supabase service key or Anthropic key ever leaves the server.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BirthData, HouseSystem, NatalChart, PlanetName } from '@astroapp/shared';
import { signFor } from '../astro.js';

/** The private bucket reports are written to. */
export const REPORTS_BUCKET = 'reports';

let cached: SupabaseClient | null = null;

function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!cached) {
    cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cached;
}

export interface AuthedUser {
  client: SupabaseClient;
  userId: string;
}

/** Verify a Supabase JWT and resolve the user. Returns null on failure. */
export async function authenticate(token: string | undefined): Promise<AuthedUser | null> {
  const client = serviceClient();
  if (!client || !token) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { client, userId: data.user.id };
}

interface SubscriptionRow {
  entitlement: 'free' | 'premium' | 'lifetime';
  expires_at: string | null;
}

/**
 * Thrown when the entitlement read FAILS (DB/network error) so we cannot tell
 * whether the user is premium. Callers MUST translate this to a retryable 503
 * (`entitlement_unavailable`) — NOT a 403 — so a transient subscriptions read
 * failure never wrongly tells a paying user to buy. A successful read that
 * returns no row (or a non-premium row) is "genuinely not premium" → 403, and
 * does NOT throw this.
 */
export class EntitlementUnavailableError extends Error {
  constructor(message = 'entitlement read failed') {
    super(message);
    this.name = 'EntitlementUnavailableError';
  }
}

/**
 * Thrown when a storage READ fails (DB/network error) so we cannot tell whether a
 * row is genuinely absent or merely unreadable. Mirrors {@link
 * EntitlementUnavailableError}'s tri-state: a loader returns `null`/`[]` ONLY when
 * the read SUCCEEDED and the row is genuinely absent; on a real (non-absence)
 * error it THROWS this instead. Callers MUST translate it to a retryable 503
 * (`storage_unavailable`) — NOT a 404 `no_chart` — so a transient DB blip never
 * becomes a permanent "compute your chart first" dead-end for a user who has one.
 */
export class StorageUnavailableError extends Error {
  constructor(message = 'storage read failed') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/**
 * PostgREST code for "undefined column" — emitted when a SELECT references a
 * column that doesn't exist yet (e.g. the `relationship` migration is unapplied).
 * This is a recoverable schema-absence we degrade around, NOT a transient outage.
 */
const PG_UNDEFINED_COLUMN = '42703';

/** A Supabase/PostgREST error shape with the bits we branch on. */
interface PostgrestErrorLike {
  message?: string;
  code?: string;
}

/**
 * True when an error represents a genuine "row absent" / recoverable-schema
 * condition rather than a transient outage. PostgREST returns `null` data with a
 * null error for a clean miss on `.maybeSingle()`, so a non-null error here is a
 * real failure UNLESS it's an undefined-column/relation (which callers degrade
 * around explicitly). Everything else → treat as unavailable and throw.
 */
function isSchemaAbsenceError(error: PostgrestErrorLike | null): boolean {
  if (!error) return false;
  return error.code === PG_UNDEFINED_COLUMN;
}

/**
 * Tri-state entitlement read against the authoritative subscriptions row.
 *
 * - returns `true`  → row present AND premium/lifetime (and not expired);
 * - returns `false` → read SUCCEEDED but the user is genuinely not premium
 *   (no row, or a `free`/expired row) → caller replies 403;
 * - THROWS {@link EntitlementUnavailableError} → the read itself failed
 *   (DB/network) so premium is UNKNOWN → caller replies 503 (retryable).
 *
 * This fails CLOSED for security (unknown ≠ premium) but OPEN for availability
 * (unknown ≠ "not premium"): a transient error never tells a paying user no.
 */
export async function checkEntitlement(user: AuthedUser): Promise<boolean> {
  // DEMO BYPASS — see `demoPremiumEnabled`. Grants premium to EVERY account and
  // backfills the subscriptions row so the Supabase Edge Functions (which read
  // that table directly and know nothing about this flag) agree.
  if (demoPremiumEnabled()) {
    void ensureDemoPremiumRow(user.userId);
    return true;
  }

  const { data, error } = await user.client
    .from('subscriptions')
    .select('entitlement, expires_at')
    .eq('user_id', user.userId)
    .maybeSingle<SubscriptionRow>();
  if (error) {
    console.warn('[storage] checkEntitlement failed:', error.message);
    throw new EntitlementUnavailableError(error.message);
  }
  if (!data) return false; // no subscription row → genuinely free.
  if (data.entitlement === 'lifetime') return true;
  if (data.entitlement === 'premium') {
    return !data.expires_at || new Date(data.expires_at).getTime() > Date.now();
  }
  return false;
}

/**
 * @deprecated Conflates "not premium" with "couldn't determine". Use
 * {@link checkEntitlement} (tri-state) so a transient DB error becomes a
 * retryable 503 rather than a wrong 403. Kept only for non-gating callers.
 */
export async function isPremium(user: AuthedUser): Promise<boolean> {
  try {
    return await checkEntitlement(user);
  } catch {
    return false;
  }
}

// --- DEMO PREMIUM BYPASS ----------------------------------------------------

/**
 * True when `DEMO_PREMIUM=1` is set for this service.
 *
 * A testing-only switch that makes every authenticated account premium without
 * touching the database schema. Off unless explicitly set, so a normal deploy
 * is unaffected — but it MUST NOT ship enabled: it hands every feature to every
 * account for free.
 */
export function demoPremiumEnabled(): boolean {
  const flag = process.env.DEMO_PREMIUM;
  return flag === '1' || flag === 'true';
}

/**
 * Best-effort upsert of a premium `subscriptions` row for a user.
 *
 * The in-process flag above covers THIS service, but the app also calls Supabase
 * Edge Functions (`ai-interpret`) that gate on the same table and cannot see a
 * local env var. Writing the row is what makes the bypass hold everywhere,
 * including for accounts created later — the row appears the first time a new
 * user's chart is computed.
 *
 * Deliberately fire-and-forget: this is a convenience, never a precondition, so
 * a failure must not turn a working request into an error. `source = 'promo'`
 * keeps these rows distinguishable from real purchases for later cleanup.
 */
async function ensureDemoPremiumRow(userId: string): Promise<void> {
  try {
    const client = serviceClient();
    if (!client) return;
    await client
      .from('subscriptions')
      .upsert(
        { user_id: userId, entitlement: 'premium', source: 'promo', expires_at: null },
        { onConflict: 'user_id' },
      );
  } catch {
    // Ignored on purpose — see the note above.
  }
}

/** Load a chart for the user (optional specific id), service-side. */
export async function loadChart(user: AuthedUser, chartId?: string): Promise<NatalChart | null> {
  let query = user.client.from('charts').select('chart').eq('user_id', user.userId);
  if (chartId) query = query.eq('id', chartId);
  const { data, error } = await query
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ chart: NatalChart }>();
  if (error) {
    console.warn('[storage] loadChart failed:', error.message);
    throw new StorageUnavailableError(error.message);
  }
  if (!data?.chart) return null; // read succeeded, chart genuinely absent
  return data.chart;
}

/**
 * Load the latest computed chart for a SPECIFIC `birth_data` row (RLS
 * owner-scoped). Unlike {@link loadChart} (which filters by `charts.id`), this
 * resolves the chart by its `birth_data_id`, so callers that hold a birth_data
 * id (e.g. /life-almanac, /compatibility) get the chart belonging to the SAME
 * person as that birth record. Returns the newest by `computed_at`, or null.
 */
export async function loadChartByBirthDataId(
  user: AuthedUser,
  birthDataId: string,
): Promise<NatalChart | null> {
  const { data, error } = await user.client
    .from('charts')
    .select('chart')
    .eq('user_id', user.userId)
    .eq('birth_data_id', birthDataId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ chart: NatalChart }>();
  if (error) {
    console.warn('[storage] loadChartByBirthDataId failed:', error.message);
    throw new StorageUnavailableError(error.message);
  }
  if (!data?.chart) return null; // read succeeded, chart genuinely absent
  return data.chart;
}

/**
 * Load the chart for the user's CANONICAL SELF record specifically — never the
 * newest chart across all `birth_data` rows. Saved partners/exes are upserted
 * under the user's own `user_id`, so {@link loadChart} (which orders by
 * `computed_at` across ALL rows) can return a partner's chart; that would let the
 * AI chat answer about the user while grounded on someone else's placements.
 *
 * Resolves the canonical `label='self'` birth record (without depending on the
 * optional `relationship` column), then loads THAT record's chart via
 * {@link loadChartByBirthDataId}. Returns null when the user has no self record
 * or no computed chart for it.
 */
export async function loadSelfChart(user: AuthedUser): Promise<NatalChart | null> {
  const self = await loadBirthData(user); // no id → canonical self record
  if (!self?.id) return null;
  return loadChartByBirthDataId(user, self.id);
}

/** The `birth_data` columns we read to reconstruct a {@link BirthData}. */
interface BirthDataRow {
  id: string;
  label: string | null;
  birth_date: string;
  birth_time: string | null;
  time_known: boolean;
  lat: number;
  lon: number;
  tz_iana: string;
  house_system: HouseSystem;
}

/**
 * Load a `birth_data` row (RLS owner-scoped) and map it to the shared
 * {@link BirthData} shape used by the compute pipeline. When `id` is given the
 * exact row is loaded; otherwise the user's canonical `self` record is returned.
 * Returns null when no matching row exists. Mirrors the row→model mapping in
 * `apps/mobile/.../profiles.ts` (`profileToBirthData`).
 */
export async function loadBirthData(user: AuthedUser, id?: string): Promise<BirthData | null> {
  if (id) {
    const { data, error } = await user.client
      .from('birth_data')
      .select('id, label, birth_date, birth_time, time_known, lat, lon, tz_iana, house_system')
      .eq('user_id', user.userId)
      .eq('id', id)
      .limit(1)
      .maybeSingle<BirthDataRow>();
    if (error) {
      console.warn('[storage] loadBirthData(id) failed:', error.message);
      throw new StorageUnavailableError(error.message);
    }
    if (!data) return null; // read succeeded, row genuinely absent
    return mapBirthDataRow(data);
  }
  // No id → resolve the canonical SELF record by `label='self'` ALONE. We must
  // NOT depend on the `relationship` column here: if the
  // `20260616010000_profile_relationship` migration hasn't been applied,
  // SELECTing or filtering on `relationship` makes PostgREST return 42703
  // (undefined column) → null → a 404 for EVERY user (Compatibility/Almanac/the
  // self chart). The mobile client (`useProfiles.ts`) already degrades on 42703;
  // the server must too. `.order('created_at')` + `.limit(1)` deterministically
  // pick the OLDEST self row, matching the client's canonical-self choice.
  const { data, error } = await user.client
    .from('birth_data')
    .select('id, label, birth_date, birth_time, time_known, lat, lon, tz_iana, house_system')
    .eq('user_id', user.userId)
    .eq('label', 'self')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<BirthDataRow>();
  if (error) {
    console.warn('[storage] loadBirthData(self) failed:', error.message);
    throw new StorageUnavailableError(error.message);
  }
  if (!data) return null; // read succeeded, no self row yet
  return mapBirthDataRow(data);
}

/** Map a raw `birth_data` row to the shared {@link BirthData} shape. */
function mapBirthDataRow(data: BirthDataRow): BirthData {
  return {
    id: data.id,
    date: data.birth_date,
    // Only trust the stored time when it's flagged known (mirrors profileToBirthData).
    time: data.time_known ? data.birth_time : null,
    timeKnown: data.time_known,
    lat: data.lat,
    lon: data.lon,
    tzIana: data.tz_iana,
    houseSystem: data.house_system,
  };
}

/** Connection state between the caller and a candidate ('declined' reads as 'none'). */
export type CandidateConnectionStatus = 'none' | 'pending' | 'accepted';

/** Precedence when several connection rows touch the same pair of users. */
const CONNECTION_RANK: Record<CandidateConnectionStatus, number> = {
  none: 0,
  pending: 1,
  accepted: 2,
};

/** The `user_profiles` columns the matchmaking scan reads. */
interface UserProfileRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  looking_for: string;
}

/** A discoverable profile the caller may be matched with (see /matches). */
export interface DiscoverableCandidate {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  lookingFor: string;
  /**
   * The candidate's canonical SELF birth record, or null when they have none
   * yet (the endpoint skips unscoreable candidates). NEVER serialised to the
   * client — the /matches response carries no birth fields.
   */
  birth: BirthData | null;
  connectionStatus: CandidateConnectionStatus;
}

/**
 * Load up to `cap` discoverable candidate profiles for the matchmaking scan
 * (SERVICE-ROLE: this deliberately reads OTHER users' rows, so it takes the
 * caller's id rather than an RLS-scoped {@link AuthedUser}).
 *
 * - Profiles: `discoverable = true`, not the caller, `looking_for` matching the
 *   intent ('both' qualifies for either), newest first, bounded by `cap`.
 * - Blocks: anyone with a `blocks` row touching the caller in EITHER direction
 *   is excluded (blocked users must never surface as matches).
 * - Birth: each candidate's canonical SELF `birth_data` row, resolved EXACTLY
 *   like {@link loadBirthData}'s no-id case — `label='self'` alone (no
 *   `relationship` dependency), oldest `created_at` first. Batched with one
 *   `.in('user_id', ids)` query; the oldest self row per user wins. Candidates
 *   without a self row are returned with `birth: null`.
 * - Connections: the caller's `connections` rows touching a candidate (either
 *   direction) yield `connectionStatus`; a 'declined' row counts as 'none'.
 *
 * Tri-state contract as everywhere in this file: `[]` ONLY when the reads
 * succeeded and nothing qualifies; any real DB/network failure THROWS
 * {@link StorageUnavailableError} (callers reply 503, never an empty list).
 */
export async function loadDiscoverableCandidates(
  selfUserId: string,
  intent: 'partners' | 'friends',
  cap: number,
): Promise<DiscoverableCandidate[]> {
  const client = serviceClient();
  if (!client) throw new StorageUnavailableError('service client unavailable');

  const { data: profileData, error: profileError } = await client
    .from('user_profiles')
    .select('user_id, username, display_name, avatar_url, bio, looking_for')
    .eq('discoverable', true)
    .neq('user_id', selfUserId)
    .in('looking_for', [intent, 'both'])
    .order('created_at', { ascending: false })
    .limit(cap);
  if (profileError) {
    console.warn('[storage] loadDiscoverableCandidates(profiles) failed:', profileError.message);
    throw new StorageUnavailableError(profileError.message);
  }
  const profiles = (profileData ?? []) as UserProfileRow[];
  if (profiles.length === 0) return []; // read succeeded, nobody discoverable

  // Exclude anyone with a blocks row involving the caller, in either direction.
  const { data: blockData, error: blockError } = await client
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${selfUserId},blocked_id.eq.${selfUserId}`);
  if (blockError) {
    console.warn('[storage] loadDiscoverableCandidates(blocks) failed:', blockError.message);
    throw new StorageUnavailableError(blockError.message);
  }
  const blocked = new Set<string>();
  for (const row of (blockData ?? []) as Array<{ blocker_id: string; blocked_id: string }>) {
    blocked.add(row.blocker_id === selfUserId ? row.blocked_id : row.blocker_id);
  }
  const visible = profiles.filter((p) => !blocked.has(p.user_id));
  if (visible.length === 0) return [];
  const ids = visible.map((p) => p.user_id);

  // Each candidate's canonical SELF birth row: label='self' alone, oldest
  // created_at wins — mirroring loadBirthData's no-id selection exactly.
  const { data: birthData, error: birthError } = await client
    .from('birth_data')
    .select(
      'user_id, id, label, birth_date, birth_time, time_known, lat, lon, tz_iana, house_system',
    )
    .in('user_id', ids)
    .eq('label', 'self')
    .order('created_at', { ascending: true });
  if (birthError) {
    console.warn('[storage] loadDiscoverableCandidates(birth) failed:', birthError.message);
    throw new StorageUnavailableError(birthError.message);
  }
  const birthByUser = new Map<string, BirthData>();
  for (const row of (birthData ?? []) as Array<BirthDataRow & { user_id: string }>) {
    // Rows arrive oldest-first; the FIRST row per user is the canonical self.
    if (!birthByUser.has(row.user_id)) birthByUser.set(row.user_id, mapBirthDataRow(row));
  }

  // Connection status: rows touching the caller in either direction; keep the
  // strongest per candidate (accepted > pending); 'declined' counts as 'none'.
  const { data: connData, error: connError } = await client
    .from('connections')
    .select('requester_id, addressee_id, status')
    .or(`requester_id.eq.${selfUserId},addressee_id.eq.${selfUserId}`);
  if (connError) {
    console.warn('[storage] loadDiscoverableCandidates(connections) failed:', connError.message);
    throw new StorageUnavailableError(connError.message);
  }
  const statusByUser = new Map<string, CandidateConnectionStatus>();
  for (const row of (connData ?? []) as Array<{
    requester_id: string;
    addressee_id: string;
    status: string;
  }>) {
    const other = row.requester_id === selfUserId ? row.addressee_id : row.requester_id;
    const status: CandidateConnectionStatus =
      row.status === 'accepted' ? 'accepted' : row.status === 'pending' ? 'pending' : 'none';
    const prev = statusByUser.get(other) ?? 'none';
    if (CONNECTION_RANK[status] > CONNECTION_RANK[prev]) statusByUser.set(other, status);
  }

  return visible.map((p) => ({
    userId: p.user_id,
    username: p.username,
    displayName: p.display_name,
    avatarUrl: p.avatar_url,
    bio: p.bio,
    lookingFor: p.looking_for,
    birth: birthByUser.get(p.user_id) ?? null,
    connectionStatus: statusByUser.get(p.user_id) ?? 'none',
  }));
}

/** A person the user has saved (for relationship context in the AI/reports). */
export interface SavedPerson {
  name: string;
  relationship: string;
  /**
   * Compact, factual placement summary from the person's computed chart, e.g.
   * "Sun in Aries, Moon in Cancer, Mercury in Pisces, Venus in Taurus, Mars in
   * Leo" (+ Ascendant when the chart has angles). Omitted when no chart is on
   * record yet for that person.
   */
  placements?: string;
}

/** The five "personal" bodies summarised for a saved person, in reading order. */
const SUMMARY_BODIES: PlanetName[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars'];

/**
 * Build a compact, human-readable placement summary from a computed chart:
 * the SIGN of the Sun, Moon, Mercury, Venus and Mars, plus the Ascendant sign
 * when the chart actually has angles (a known birth time). Returns null when no
 * usable placements can be extracted, so callers can omit it cleanly.
 */
export function placementSummary(chart: NatalChart): string | null {
  const byName = new Map(chart.planets.map((p) => [p.name, p]));
  const parts: string[] = [];
  for (const name of SUMMARY_BODIES) {
    const planet = byName.get(name);
    if (planet) parts.push(`${name} in ${planet.sign}`);
  }
  if (chart.housesAvailable !== false && typeof chart.ascendant === 'number') {
    parts.push(`Ascendant in ${signFor(chart.ascendant)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Fetch the computed `charts.chart` JSON for a set of `birth_data` ids (RLS
 * owner-scoped) and return a map from `birth_data_id` to its placement summary.
 * Non-fatal: any DB failure yields an empty map (the people just carry no
 * placements). Keyed by `birth_data_id` so it lines up with the `birth_data`
 * rows the people queries already read.
 */
async function loadPlacementsByBirthId(
  user: AuthedUser,
  birthDataIds: string[],
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  if (birthDataIds.length === 0) return summaries;
  const { data, error } = await user.client
    .from('charts')
    .select('birth_data_id, chart')
    .eq('user_id', user.userId)
    .in('birth_data_id', birthDataIds);
  if (error || !data) return summaries;
  for (const row of data as Array<{ birth_data_id: string | null; chart: NatalChart | null }>) {
    if (!row.birth_data_id || !row.chart) continue;
    const summary = placementSummary(row.chart);
    if (summary) summaries.set(row.birth_data_id, summary);
  }
  return summaries;
}

/**
 * Load the OTHER people the user has saved (partner, crush, ex, family, friend),
 * for relationship context. Excludes the user's own 'self' record. Names come
 * from the `birth_data.label`; relationship from the typed column. Each person
 * also carries a `placements` summary read from their computed `charts.chart`
 * (keyed by `birth_data_id`) when one exists, so the assistant can answer about
 * a saved person's chart from ground truth. Service-side, RLS owner-scoped.
 */
export async function loadPeople(user: AuthedUser): Promise<SavedPerson[]> {
  const first = await user.client
    .from('birth_data')
    .select('id, label, relationship')
    .eq('user_id', user.userId);
  let data: unknown = first.data;
  let error: PostgrestErrorLike | null = first.error;
  // The `relationship` column may not exist yet (unapplied migration → 42703).
  // Degrade exactly like `loadBirthData`/the mobile `useProfiles` fallback: retry
  // the select WITHOUT `relationship` and default everyone to 'other', rather than
  // silently returning [] (which would erase every saved person).
  if (error && isSchemaAbsenceError(error)) {
    console.warn('[storage] loadPeople: relationship column missing, retrying without it');
    const retry = await user.client
      .from('birth_data')
      .select('id, label')
      .eq('user_id', user.userId);
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    console.warn('[storage] loadPeople failed:', error.message);
    throw new StorageUnavailableError(error.message);
  }
  const rows = (
    (data ?? []) as Array<{ id: string; label: string | null; relationship?: string | null }>
  ).filter((r) => r.label !== 'self' && r.relationship !== 'self');
  const placements = await loadPlacementsByBirthId(
    user,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const summary = placements.get(r.id);
    return {
      name: (r.label ?? '').trim() || 'Unnamed',
      relationship: r.relationship ?? 'other',
      ...(summary ? { placements: summary } : {}),
    };
  });
}

/** A saved person with the birth data needed to compute their chart + synastry. */
export interface SavedPersonWithBirth {
  name: string;
  relationship: string;
  birth: BirthData;
  /** Compact placement summary from the person's computed chart (see {@link SavedPerson}). */
  placements?: string;
}

/**
 * Like {@link loadPeople}, but also returns each person's {@link BirthData} so the
 * chat assistant can compute their chart + synastry/compatibility on demand.
 * Excludes the user's own 'self' record. Service-side, RLS owner-scoped.
 */
export async function loadPeopleWithBirth(user: AuthedUser): Promise<SavedPersonWithBirth[]> {
  const baseCols = 'id, label, birth_date, birth_time, time_known, lat, lon, tz_iana, house_system';
  const first = await user.client
    .from('birth_data')
    .select(`${baseCols}, relationship`)
    .eq('user_id', user.userId);
  let data: unknown = first.data;
  let error: PostgrestErrorLike | null = first.error;
  // Degrade on a missing `relationship` column (unapplied migration → 42703) by
  // re-selecting without it and defaulting to 'other', mirroring `loadBirthData`
  // and the mobile `useProfiles` fallback — never silently return [] on it.
  if (error && isSchemaAbsenceError(error)) {
    console.warn('[storage] loadPeopleWithBirth: relationship column missing, retrying without it');
    const retry = await user.client.from('birth_data').select(baseCols).eq('user_id', user.userId);
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    console.warn('[storage] loadPeopleWithBirth failed:', error.message);
    throw new StorageUnavailableError(error.message);
  }
  const rows = ((data ?? []) as Array<BirthDataRow & { relationship?: string | null }>).filter(
    (r) => r.label !== 'self' && r.relationship !== 'self',
  );
  const placements = await loadPlacementsByBirthId(
    user,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const summary = placements.get(r.id);
    return {
      name: (r.label ?? '').trim() || 'Unnamed',
      relationship: r.relationship ?? 'other',
      birth: {
        id: r.id,
        date: r.birth_date,
        time: r.time_known ? r.birth_time : null,
        timeKnown: r.time_known,
        lat: r.lat,
        lon: r.lon,
        tzIana: r.tz_iana,
        houseSystem: r.house_system,
      },
      ...(summary ? { placements: summary } : {}),
    };
  });
}

/** Max length of the auto-derived conversation title (first words of the prompt). */
const TITLE_MAX = 60;

/**
 * Persist one chat turn (the user message + the assistant reply) to
 * `ai_conversations` / `ai_messages` using the SERVICE-ROLE client. Because the
 * service role bypasses RLS, every row sets `user_id` explicitly.
 *
 * - When `conversationId` is null/absent, a new conversation is created with a
 *   title derived from the first ~60 chars of `userText`.
 * - The user turn then the assistant turn are inserted as `ai_messages`.
 * - The conversation's `updated_at` is touched so the thread sorts to the top.
 *
 * NON-FATAL by contract: any DB failure (e.g. the migration creating these
 * tables hasn't been applied) is swallowed and the passed-in `conversationId`
 * (or null) is returned, so the chat keeps working even when persistence is
 * unavailable. NEVER throws.
 */
/**
 * Load the last `limit` turns of a thread from `ai_messages` (oldest→newest),
 * so a resumed chat keeps its memory even if the CLIENT failed to send history
 * (offline / unapplied migration). Non-fatal: returns [] on any failure.
 */
/**
 * Trim any LEADING assistant turns so the history starts with a USER turn (or is
 * empty). Some providers 400 on a leading assistant message, which the request
 * layer surfaces as a 502. History can begin on an assistant turn either because
 * the server-reload `limit` window sliced mid-thread, OR because the CLIENT sent
 * a history that starts assistant-first — so this MUST be applied to BOTH the
 * server reload and the client-supplied history before calling `interpretChat`.
 */
export function trimLeadingAssistantTurns<T extends { role: 'user' | 'assistant' }>(
  turns: T[],
): T[] {
  let start = 0;
  while (start < turns.length && turns[start]!.role === 'assistant') start += 1;
  return start === 0 ? turns : turns.slice(start);
}

/**
 * Collapse any run of CONSECUTIVE same-role turns down to a single turn, keeping
 * the LAST turn of each run. Some providers (Gemini) hard-400 on two consecutive
 * same-role messages, which the request layer surfaces as a 502. A malformed
 * history can contain such a run for several reasons — an empty assistant reply
 * that was once persisted (so two user turns sit adjacent), a client that sent a
 * doubled turn, or a server reload window that sliced mid-thread. Unlike
 * {@link trimLeadingAssistantTurns} (leading-only), this normalises the WHOLE
 * history so it can never produce consecutive same-role turns. Keeping the last
 * of a run preserves the most recent (typically most complete) content.
 */
export function normalizeAlternation<T extends { role: 'user' | 'assistant' }>(turns: T[]): T[] {
  const out: T[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.role === turn.role) {
      out[out.length - 1] = turn; // same role as previous → keep the last of the run
    } else {
      out.push(turn);
    }
  }
  return out;
}

export async function loadConversationHistory(
  user: AuthedUser,
  conversationId: string,
  limit = 20,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const { data, error } = await user.client
      .from('ai_messages')
      .select('role, content, created_at')
      .eq('user_id', user.userId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) {
      if (error) console.warn('[storage] loadConversationHistory failed:', error.message);
      return [];
    }
    // Order DETERMINISTICALLY by (created_at, role-rank). The DB query orders by
    // created_at only; on a coarse clock the user turn and its `+1ms` assistant
    // reply can land on the SAME timestamp, leaving their relative order undefined.
    // If the assistant turn then sorts before its user turn, `normalizeAlternation`
    // would collapse the pair and drop a turn. Tie-break user-before-assistant so a
    // turn pair always reads user→assistant regardless of clock granularity.
    const roleRank = (r: 'user' | 'assistant'): number => (r === 'user' ? 0 : 1);
    const turns = (
      data as Array<{ role: 'user' | 'assistant'; content: string; created_at: string }>
    )
      .slice()
      .sort((x, y) => {
        const byTime = Date.parse(x.created_at) - Date.parse(y.created_at);
        return byTime !== 0 ? byTime : roleRank(x.role) - roleRank(y.role);
      })
      .map((r) => ({ role: r.role, content: r.content }));
    // History must START with a USER turn (some providers 400 on a leading
    // assistant message). The `limit` window can slice mid-thread and begin on an
    // assistant turn, so trim leading assistant turns (or return []).
    return trimLeadingAssistantTurns(turns);
  } catch (e) {
    console.warn('[storage] loadConversationHistory threw:', e instanceof Error ? e.message : e);
    return [];
  }
}

export async function saveConversationTurn(
  user: AuthedUser,
  conversationId: string | null,
  userText: string,
  assistantText: string,
): Promise<string | null> {
  try {
    let convoId = conversationId;

    // A client-supplied conversationId must belong to THIS user before we append
    // messages to it (the service-role client bypasses RLS, so an attacker could
    // otherwise write into another user's thread). Verify ownership; if the row
    // isn't owned (or doesn't exist), fall through to creating a NEW conversation
    // rather than trusting the id.
    if (convoId) {
      const { data: owned, error: ownErr } = await user.client
        .from('ai_conversations')
        .select('id')
        .eq('id', convoId)
        .eq('user_id', user.userId)
        .maybeSingle<{ id: string }>();
      if (ownErr || !owned) convoId = null;
    }

    if (!convoId) {
      const title = userText.trim().slice(0, TITLE_MAX) || 'New conversation';
      const { data, error } = await user.client
        .from('ai_conversations')
        .insert({ user_id: user.userId, title })
        .select('id')
        .single<{ id: string }>();
      if (error || !data?.id) return conversationId;
      convoId = data.id;
    }

    const now = new Date().toISOString();
    const { error: msgError } = await user.client.from('ai_messages').insert([
      {
        conversation_id: convoId,
        user_id: user.userId,
        role: 'user',
        content: userText,
        created_at: now,
      },
      {
        conversation_id: convoId,
        user_id: user.userId,
        role: 'assistant',
        content: assistantText,
        // +1ms so the assistant turn always sorts AFTER the user turn.
        created_at: new Date(Date.parse(now) + 1).toISOString(),
      },
    ]);
    if (msgError) return convoId;

    // Touch updated_at so the thread floats to the top of the list. If a DB
    // trigger already maintains this, the explicit update is harmless.
    await user.client
      .from('ai_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convoId)
      .eq('user_id', user.userId);

    return convoId;
  } catch (error) {
    // Table missing / migration unapplied / transient error — keep chat working,
    // but log it so an unapplied migration is observable rather than silent.
    console.warn(
      '[storage] saveConversationTurn failed:',
      error instanceof Error ? error.message : String(error),
    );
    return conversationId;
  }
}

/**
 * Upload the PDF to the private `reports` bucket under the user's folder and
 * return a signed URL (valid `expiresInSeconds`). The owner-scoped path + RLS
 * policy keep reports private to the user.
 *
 * The default TTL is 7 days: the client caches the finished job's URL (often
 * indefinitely), so a short 1h TTL left the PDF link broken later. A week gives
 * a comfortable window before the link expires.
 */
export async function uploadReport(
  user: AuthedUser,
  kind: string,
  pdf: Buffer,
  expiresInSeconds = 604800, // 7 days
): Promise<{ path: string; signedUrl: string }> {
  const path = `${user.userId}/${kind}-${Date.now()}.pdf`;
  const { error: uploadError } = await user.client.storage
    .from(REPORTS_BUCKET)
    .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (uploadError) throw new Error(`upload failed: ${uploadError.message}`);

  const { data, error: signError } = await user.client.storage
    .from(REPORTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (signError || !data?.signedUrl) {
    throw new Error(`sign failed: ${signError?.message ?? 'no url'}`);
  }
  return { path, signedUrl: data.signedUrl };
}
