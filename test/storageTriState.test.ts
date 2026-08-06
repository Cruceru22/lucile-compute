/**
 * Storage tri-state loaders (audit fix #2): a transient DB error must NOT collapse
 * into "row absent". Each loader THROWS `StorageUnavailableError` on a real (non
 * absence) error and returns null/[] ONLY when the read succeeded and the row is
 * genuinely absent — so the endpoints can reply 503 (retryable) instead of a wrong
 * 404 "compute your chart first". `loadPeople(WithBirth)` additionally DEGRADE on a
 * 42703 (relationship column missing) by retrying without it, rather than [].
 */
import { describe, expect, it } from 'vitest';
import {
  StorageUnavailableError,
  loadChart,
  loadChartByBirthDataId,
  loadBirthData,
  loadPeopleWithBirth,
  type AuthedUser,
} from '../src/ai/storage.js';

/**
 * A chainable query-builder stub. Every chain method returns `this`; the chain is
 * thenable AND has `.maybeSingle()`, both resolving to the configured result. A
 * second result can be queued for the degrade-retry path (loadPeople*).
 */
function fakeClient(results: Array<{ data: unknown; error: unknown }>): AuthedUser {
  let call = 0;
  const next = () => results[Math.min(call++, results.length - 1)]!;
  const makeBuilder = () => {
    let settled: { data: unknown; error: unknown } | null = null;
    const settle = () => (settled ??= next());
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = chain;
    builder.maybeSingle = () => Promise.resolve(settle());
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(onF, onR);
    return builder;
  };
  const client = { from: () => makeBuilder() } as unknown as AuthedUser['client'];
  return { client, userId: 'user-1' };
}

const DB_ERROR = { message: 'connection reset', code: '08006' };
const UNDEFINED_COLUMN = { message: 'column relationship does not exist', code: '42703' };

describe('storage tri-state — loadChart', () => {
  it('THROWS StorageUnavailableError on a real DB error', async () => {
    const user = fakeClient([{ data: null, error: DB_ERROR }]);
    await expect(loadChart(user)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('returns null when the read succeeds and the chart is genuinely absent', async () => {
    const user = fakeClient([{ data: null, error: null }]);
    await expect(loadChart(user)).resolves.toBeNull();
  });

  it('returns the chart on a successful read', async () => {
    const chart = { planets: [] };
    const user = fakeClient([{ data: { chart }, error: null }]);
    await expect(loadChart(user)).resolves.toBe(chart);
  });
});

describe('storage tri-state — loadChartByBirthDataId', () => {
  it('THROWS on a real DB error', async () => {
    const user = fakeClient([{ data: null, error: DB_ERROR }]);
    await expect(loadChartByBirthDataId(user, 'b1')).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
  });

  it('returns null on a genuine absence', async () => {
    const user = fakeClient([{ data: null, error: null }]);
    await expect(loadChartByBirthDataId(user, 'b1')).resolves.toBeNull();
  });
});

describe('storage tri-state — loadBirthData', () => {
  it('THROWS on a real DB error (id path)', async () => {
    const user = fakeClient([{ data: null, error: DB_ERROR }]);
    await expect(loadBirthData(user, 'b1')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('THROWS on a real DB error (self path)', async () => {
    const user = fakeClient([{ data: null, error: DB_ERROR }]);
    await expect(loadBirthData(user)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('returns null on a genuine absence (no self row yet)', async () => {
    const user = fakeClient([{ data: null, error: null }]);
    await expect(loadBirthData(user)).resolves.toBeNull();
  });
});

describe('storage degrade — loadPeopleWithBirth on missing relationship column', () => {
  const row = {
    id: 'b2',
    label: 'Alex',
    birth_date: '1990-01-01',
    birth_time: '12:00:00',
    time_known: true,
    lat: 0,
    lon: 0,
    tz_iana: 'UTC',
    house_system: 'placidus',
  };

  it('RETRIES without relationship on 42703 and defaults to "other" (never [])', async () => {
    const user = fakeClient([
      { data: null, error: UNDEFINED_COLUMN }, // first select (with relationship) fails
      { data: [row], error: null }, // retry select (no relationship) succeeds
    ]);
    const people = await loadPeopleWithBirth(user);
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe('Alex');
    expect(people[0]!.relationship).toBe('other');
  });

  it('THROWS on a non-42703 DB error rather than returning []', async () => {
    const user = fakeClient([{ data: null, error: DB_ERROR }]);
    await expect(loadPeopleWithBirth(user)).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
