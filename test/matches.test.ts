/**
 * POST /matches — premium cosmic-matchmaking endpoint.
 *
 * The storage module is mocked (vi.mock) so auth, entitlement, and the
 * candidate scan are controlled per-test, while the synastry/natal/compatibility
 * math runs for REAL against the ephemeris (scores are genuine). Asserted here:
 *
 *   (a) unauthenticated → 401;
 *   (b) happy path → matches sorted by score desc, `limit` respected;
 *   (c) PRIVACY INVARIANT: the serialised response contains NO birth fields
 *       ('birth', 'lat', 'lon', 'tzIana', 'birth_date');
 *   (d) a candidate without a self birth record is skipped, not 500;
 *   (e) invalid intent → 400;
 *   plus the tri-state translations: no self chart → 404, storage error → 503.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BirthData } from '@astroapp/shared';

vi.mock('../src/ai/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/storage.js')>();
  return {
    ...actual,
    authenticate: vi.fn(),
    checkEntitlement: vi.fn(),
    loadBirthData: vi.fn(),
    loadDiscoverableCandidates: vi.fn(),
  };
});

import { buildApp } from '../src/index.js';
import {
  authenticate,
  checkEntitlement,
  loadBirthData,
  loadDiscoverableCandidates,
  StorageUnavailableError,
  type AuthedUser,
  type DiscoverableCandidate,
} from '../src/ai/storage.js';

const mockedAuthenticate = vi.mocked(authenticate);
const mockedCheckEntitlement = vi.mocked(checkEntitlement);
const mockedLoadBirthData = vi.mocked(loadBirthData);
const mockedLoadCandidates = vi.mocked(loadDiscoverableCandidates);

const SELF_ID = 'self-user';
const GOOD_TOKEN = 'good-token';
const AUTH = { authorization: `Bearer ${GOOD_TOKEN}` };

function makeBirth(date: string, time: string | null = '12:00'): BirthData {
  return {
    date,
    time,
    timeKnown: time !== null,
    lat: 38.72,
    lon: -9.14,
    tzIana: 'Europe/Lisbon',
    houseSystem: 'placidus',
  };
}

function makeCandidate(
  userId: string,
  b: BirthData | null,
  connectionStatus: DiscoverableCandidate['connectionStatus'] = 'none',
): DiscoverableCandidate {
  return {
    userId,
    username: `user-${userId}`,
    displayName: `Person ${userId}`,
    avatarUrl: null,
    bio: 'Sky watcher.',
    lookingFor: 'both',
    birth: b,
    connectionStatus,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockedAuthenticate.mockReset();
  mockedCheckEntitlement.mockReset();
  mockedLoadBirthData.mockReset();
  mockedLoadCandidates.mockReset();
  // Defaults: a valid premium caller with a self chart and no candidates.
  mockedAuthenticate.mockImplementation(async (token) =>
    token === GOOD_TOKEN ? ({ client: {}, userId: SELF_ID } as AuthedUser) : null,
  );
  mockedCheckEntitlement.mockResolvedValue(true);
  mockedLoadBirthData.mockResolvedValue(makeBirth('1990-05-05'));
  mockedLoadCandidates.mockResolvedValue([]);
});

describe('POST /matches', () => {
  it('(a) rejects an unauthenticated request (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      payload: { intent: 'partners' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('(b) happy path: matches sorted by score desc, limit respected', async () => {
    mockedLoadCandidates.mockResolvedValue([
      makeCandidate('c1', makeBirth('1991-03-10')),
      makeCandidate('c2', makeBirth('1988-11-22'), 'pending'),
      makeCandidate('c3', makeBirth('1994-07-01'), 'accepted'),
    ]);

    const full = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners' },
    });
    expect(full.statusCode).toBe(200);
    const { matches } = full.json() as { matches: Array<Record<string, unknown>> };
    expect(matches).toHaveLength(3);
    // Sorted descending by score.
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]!.score as number).toBeGreaterThanOrEqual(matches[i]!.score as number);
    }
    // Contract fields present, with genuine computed signs.
    for (const m of matches) {
      expect(m).toMatchObject({
        userId: expect.any(String),
        username: expect.any(String),
        displayName: expect.any(String),
        bio: expect.any(String),
        lookingFor: 'both',
        score: expect.any(Number),
        band: expect.any(String),
        bandLabel: expect.any(String),
        sunSign: expect.any(String),
        moonSign: expect.any(String),
        ascSign: expect.any(String), // time known → houses → Ascendant sign
        timeKnown: true,
        connectionStatus: expect.stringMatching(/^(none|pending|accepted)$/),
      });
    }
    // connectionStatus is passed through per candidate.
    const byId = new Map(matches.map((m) => [m.userId, m.connectionStatus]));
    expect(byId.get('c2')).toBe('pending');
    expect(byId.get('c3')).toBe('accepted');

    // Same candidates, limit 2 → only the top two come back, still sorted.
    const limited = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners', limit: 2 },
    });
    expect(limited.statusCode).toBe(200);
    const limitedMatches = (limited.json() as { matches: Array<{ score: number }> }).matches;
    expect(limitedMatches).toHaveLength(2);
    expect(limitedMatches[0]!.score).toBeGreaterThanOrEqual(limitedMatches[1]!.score);
    expect(limitedMatches[0]!.score).toBe(matches[0]!.score as number);
  });

  it('(c) PRIVACY: the response never leaks birth fields', async () => {
    mockedLoadCandidates.mockResolvedValue([
      makeCandidate('c1', makeBirth('1991-03-10')),
      makeCandidate('c2', makeBirth('1988-11-22', null)), // unknown time too
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'friends' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { matches: unknown[] }).matches).toHaveLength(2);
    const text = res.body; // the raw serialised JSON
    for (const needle of ['birth', 'lat', 'lon', 'tzIana', 'birth_date']) {
      expect(text).not.toContain(needle);
    }
  });

  it('(c2) unknown-time candidate: timeKnown false and no ascSign', async () => {
    mockedLoadCandidates.mockResolvedValue([makeCandidate('c1', makeBirth('1988-11-22', null))]);
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners' },
    });
    expect(res.statusCode).toBe(200);
    const [m] = (res.json() as { matches: Array<Record<string, unknown>> }).matches;
    expect(m).toMatchObject({ timeKnown: false, ascSign: null });
    expect(m!.sunSign).toEqual(expect.any(String));
  });

  it('(d) a candidate without a self birth record is skipped', async () => {
    mockedLoadCandidates.mockResolvedValue([
      makeCandidate('has-birth', makeBirth('1991-03-10')),
      makeCandidate('no-birth', null),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners' },
    });
    expect(res.statusCode).toBe(200);
    const { matches } = res.json() as { matches: Array<{ userId: string }> };
    expect(matches).toHaveLength(1);
    expect(matches[0]!.userId).toBe('has-birth');
  });

  it('(e) rejects an invalid intent (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'enemies' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('404 no_chart when the caller has no self birth record', async () => {
    mockedLoadBirthData.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'no_chart' });
  });

  it('503 storage_unavailable when a storage read fails (tri-state, not 404/empty)', async () => {
    mockedLoadCandidates.mockRejectedValue(new StorageUnavailableError('db down'));
    const res = await app.inject({
      method: 'POST',
      url: '/matches',
      headers: AUTH,
      payload: { intent: 'partners' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'storage_unavailable' });
  });
});
