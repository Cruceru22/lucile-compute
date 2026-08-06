/**
 * Vercel serverless entry point for the compute service.
 *
 * The service is a normal long-running Fastify app (`src/index.ts`), and
 * `buildApp()` is already exported and only auto-listens when run directly — so
 * this file adapts it rather than duplicating any routing.
 *
 * ## How the adaptation works
 *
 * Fastify can serve a raw Node `req`/`res` pair through `app.ready()` +
 * `app.server.emit('request', …)`. That is the supported way to run Fastify
 * behind a platform that owns the HTTP server, which Vercel does.
 *
 * The app is built ONCE per warm instance and memoised. Rebuilding per request
 * would re-register every route and re-run `initEphemeris()` on each call.
 *
 * ## Why `src/index.ts` is imported DYNAMICALLY
 *
 * That module calls `initEphemeris()` at module scope, which reads
 * `SWEPH_PATH` once and latches the backend. A static import would therefore
 * run it before this file could point it at the bundled `ephe/` directory, and
 * the service would silently fall back to Moshier — losing Chiron, the four
 * asteroids and arc-second precision, with nothing failing loudly. The dynamic
 * import lets the env be resolved first.
 *
 * ## What to know about running this on Vercel
 *
 * Cold starts are the real cost. `geo-tz` alone is ~69MB of timezone geometry
 * and the ephemeris files add ~4MB, so a cold instance spends real time before
 * it answers — and every scale-to-zero pays it again. On a long-running host
 * that cost is paid once at boot. If first-chart latency is poor after launch,
 * this is why; Fluid Compute or a warmed instance is the fix.
 */
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type App = Awaited<ReturnType<typeof buildAppOnce>>;

/**
 * Point `SWEPH_PATH` at the bundled ephemeris files, if they shipped.
 *
 * `vercel.json` includes `ephe/**`, but where that lands relative to the
 * running function depends on the build layout, so we probe the plausible
 * roots rather than hardcoding one and hoping. An explicit `SWEPH_PATH` from
 * the environment always wins — that is the escape hatch if the layout changes.
 *
 * Finding nothing is not an error: `initEphemeris()` falls back to Moshier.
 */
function resolveEphemerisPath(): string | undefined {
  if (process.env.SWEPH_PATH ?? process.env.EPHE_PATH) return undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'ephe'),
    join(here, '..', 'ephe'),
    join(here, '..', '..', 'ephe'),
  ];
  return candidates.find((p) => existsSync(p));
}

async function buildAppOnce() {
  const ephe = resolveEphemerisPath();
  if (ephe) process.env.SWEPH_PATH = ephe;

  // `../dist/…`, NOT `../src/…`. Importing `../src/index.js` to mean the
  // sibling `.ts` is a TypeScript compile-time convention; at RUNTIME no such
  // file exists, because the build emits to `dist/`. That mismatch surfaces as
  // `FUNCTION_INVOCATION_FAILED` with no other symptom — the build succeeds and
  // the crash only appears on the first request. Types still resolve, since
  // `declaration: true` emits `dist/index.d.ts`.
  //
  // Dynamic: must happen AFTER the env is set — see the note above.
  const { buildApp } = await import('../dist/index.js');
  const app = buildApp();
  // Required before handing raw requests to `app.server`: it wires the router
  // and completes plugin registration.
  await app.ready();
  return app;
}

/** Memoised across invocations on a warm instance. */
let appPromise: Promise<App> | null = null;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!appPromise) appPromise = buildAppOnce();
  const app = await appPromise;
  app.server.emit('request', req, res);
}
