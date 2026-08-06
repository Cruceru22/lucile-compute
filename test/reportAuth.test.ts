/**
 * Server-side entitlement enforcement for the PREMIUM `/report` endpoint (A10).
 *
 * The compute service must NOT trust the client for entitlement. `/report`:
 *   - 401 when no/!invalid bearer token (auth fails);
 *   - 403 when authenticated but not premium;
 * before it ever generates a report. Here we drive the Fastify app via
 * `app.inject()` with the Supabase env UNSET, so `authenticate()` cannot resolve
 * a user and the route returns 401 — proving the gate runs first and the AI/PDF
 * path is unreachable without a verified, premium user.
 *
 * The premium-but-403 and happy paths require a live Supabase (service role +
 * a real JWT) and are documented as a manual procedure in QA-REPORT.md; the
 * `isPremium()` logic itself is unit-checked below in isolation.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';

let app: FastifyInstance;

beforeAll(async () => {
  // Ensure no Supabase env is present so authenticate() returns null (401).
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('/report — server-side auth/entitlement gate', () => {
  it('rejects a well-formed request with no Authorization header (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/report',
      payload: { kind: 'natal', chartId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a bogus bearer token (401) — client cannot self-authorize', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/report',
      headers: { authorization: 'Bearer not-a-real-jwt' },
      payload: { kind: 'natal', chartId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('still validates the body shape (400) before anything else', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/report',
      headers: { authorization: 'Bearer x' },
      payload: { kind: 'not-a-valid-kind' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('health endpoint stays public and reports the backend', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});
