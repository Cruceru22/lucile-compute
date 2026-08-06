/**
 * Server-side premium-gate audit for two endpoints fixed in this round:
 *
 *   1. `/planetary-hours` — was entirely UNGATED (computed + returned without any
 *      auth). It is now a PREMIUM endpoint and must 401 without a valid token.
 *
 *   2. `/transits` — the FREE tier only gets a single-day "today" highlight; the
 *      multi-day timeline is PREMIUM. A MULTI-DAY window must 401 without a token,
 *      while a SINGLE-DAY window stays unauthenticated (it must NOT 401).
 *
 * As in reportAuth.test.ts we drive the Fastify app via `app.inject()` with the
 * Supabase env UNSET, so `authenticate()` cannot resolve a user: a gated route
 * returns 401, an ungated route does not.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** A minimal-but-valid natal shape the transits schema accepts. */
const NATAL = {
  planets: [
    {
      name: 'Sun',
      sign: 'Aries',
      degree: 10,
      absoluteDegree: 10,
      house: 1,
      retrograde: false,
    },
  ],
};

describe('/planetary-hours — now PREMIUM-gated', () => {
  it('rejects a well-formed request with no Authorization header (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/planetary-hours',
      payload: { date: '2026-06-26', lat: 38.72, lon: -9.14, tzIana: 'Europe/Lisbon' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('still validates the body shape (400) before the gate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/planetary-hours',
      payload: { lat: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('/transits — multi-day window is PREMIUM, single-day stays free', () => {
  it('rejects a MULTI-DAY window with no Authorization header (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/transits',
      payload: {
        natal: NATAL,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z', // ~31 days → premium
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('does NOT 401 a SINGLE-DAY window without a token (free Today/Sky highlight)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/transits',
      payload: {
        natal: NATAL,
        from: '2026-06-26T00:00:00.000Z',
        to: '2026-06-27T00:00:00.000Z', // exactly one day → free
      },
    });
    // The single-day path is unauthenticated: it must compute (200) rather than
    // gate (401). The exact event list is exercised elsewhere; here we only
    // assert the gate did NOT fire.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('events');
  });

  it('still validates the body shape (400) before the gate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/transits',
      payload: { natal: { planets: [] }, from: '', to: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});
