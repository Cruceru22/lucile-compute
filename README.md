# @astroapp/compute

> **About this repository**
>
> This is the complete, corresponding source of the `@astroapp/compute` service
> that powers the Lucile iOS app, published to satisfy **AGPL-3.0 §13**: the
> service links the Swiss Ephemeris, which Astrodienst dual-licenses as AGPL-3.0
> or commercial, and every running instance advertises this URL to network
> clients via `/health` and a `Link: …; rel="source"` header.
>
> It is extracted from a private monorepo, so `packages/shared` (the typed I/O
> contract) is vendored here alongside the service rather than resolved as a
> workspace dependency. Nothing else is omitted or modified. The mobile client
> is a separate, independently-licensed work that only consumes this service's
> JSON over the network — see "License" below.
>
> Four test files are omitted here for the same reason: `gatingAudit*` and
> `securityAudit` assert against the mobile app's source (that every premium
> feature is gated on its screen, that no secret is referenced from client
> code). They audit the app, not this service, and cannot run without it. Every
> test that exercises this service's own behaviour is present and passing.

Swiss Ephemeris calculation microservice (Node + TypeScript + Fastify 5).

**All astrological calculations happen here, server-side.** The mobile app and
the future LLM interpretation layer only consume the typed JSON these endpoints
return — the LLM never computes a chart. Accuracy is the brand: output is meant
to match Astro.com / Astro-Seek / professional tools.

Types are the I/O contract from [`@astroapp/shared`](../../packages/shared):
`BirthData`, `Planet`, `House`, `Aspect`, `NatalChart`, `TransitEvent`, etc.

## Quick start

```bash
# from the repo root
pnpm --filter @astroapp/shared build      # build the shared types first
pnpm install
pnpm --filter @astroapp/compute build
PORT=8080 pnpm --filter @astroapp/compute start
# dev (local only, interactive): pnpm --filter @astroapp/compute dev
```

Copy `.env.example` → `.env` and set `PORT` (default `8080`) and, optionally,
`SWEPH_PATH` (see [Ephemeris files](#ephemeris-files)).

## Ephemeris backend

We use the native **`sweph`** binding (Swiss Ephemeris 2.10). Two backends:

| Backend     | Files needed    | Precision           | Chiron / asteroids |
| ----------- | --------------- | ------------------- | ------------------ |
| **Moshier** | none (built-in) | ~arc-minute, modern | ❌ not available   |
| **Swiss**   | `.se1` data dir | arc-second          | ✅ available       |

The service auto-selects: if `SWEPH_PATH` (or `EPHE_PATH`) points at an existing
directory, it registers it via `swe_set_ephe_path` and uses **Swiss**; otherwise
it falls back to **Moshier** so the service runs anywhere with no downloads.
The active backend is reported in `GET /health` and every `/natal` response
(`ephemerisBackend`). Under Moshier, bodies that need data files (Chiron and the
four major asteroids **Ceres**, **Pallas**, **Juno**, **Vesta** — all from the
`seas_*.se1` asteroid set) are omitted and listed in `unavailableBodies`; they are
never fabricated. Install the `seas_*.se1` files (see [Ephemeris files](#ephemeris-files))
to compute them.

## Endpoints

All POST endpoints take JSON, are Zod-validated (`400` with `issues` on bad
input), and return JSON. `GET /health` → `{ "status": "ok", "ephemerisBackend": "moshier" }`.

### `POST /natal` — natal chart

Request body = `BirthData`:

```json
{
  "date": "1990-06-15",
  "time": "14:30",
  "timeKnown": true,
  "lat": 38.7223,
  "lon": -9.1393,
  "tzIana": "Europe/Lisbon",
  "houseSystem": "placidus"
}
```

Response = `NatalChart` plus additive metadata fields:

```jsonc
{
  "planets": [
    {
      "name": "Sun",
      "sign": "Gemini",
      "degree": 24.189, // degrees within the sign [0,30)
      "absoluteDegree": 84.189, // ecliptic longitude [0,360)
      "house": 9,
      "retrograde": false,
      "speed": 0.955, // deg/day; negative ⇒ retrograde
    },
    // Moon, Mercury … Pluto, Chiron (Swiss only), NorthNode (mean), Lilith (mean apogee)
  ],
  "houses": [{ "number": 1, "cuspDegree": 185.61, "sign": "Libra" } /* …12 */],
  "aspects": [{ "a": "Moon", "b": "Jupiter", "type": "trine", "orb": 0.29, "applying": false }],
  "ascendant": 185.61,
  "midheaven": 96.37,
  "houseSystem": "placidus",
  "computedAt": "2026-06-15T19:49:30.714Z",

  // additive (see "Shared-type reconciliation" below)
  "timeKnown": true,
  "housesAvailable": true,
  "usedNoonFallback": false,
  "preTzDatabaseEra": false,
  "ephemerisBackend": "moshier",
  "unavailableBodies": ["Chiron"],
}
```

Major aspects only: conjunction (0°), sextile (60°), square (90°), trine (120°),
opposition (180°). Default orbs: conj/opp 8°, trine/square 7°, sextile 6°.

### `POST /transits`

Body `{ natal, from, to, stepDays? }` where `natal` is a previously computed
chart (only `planets[].absoluteDegree` are required), `from`/`to` are ISO
datetimes. Returns `{ "events": TransitEvent[] }` — every transiting body vs
every natal planet, for all five major aspects, with the **exact datetime of
exactitude** found by scanning the window (default 1-day step) and bisecting
when the orb crosses zero:

```json
{
  "events": [
    {
      "transitingPlanet": "Mars",
      "natalPlanet": "Sun",
      "aspect": "square",
      "exactAt": "2024-01-12T07:43:18.000Z",
      "orb": 0
    }
  ]
}
```

### `POST /synastry`

Body `{ a: BirthData, b: BirthData }`. Returns `{ aspects }` — A's planets
(field `a`) against B's planets (field `b`), full cross-product, with orb +
applying/separating.

### `POST /progressions`

Body `{ birth: BirthData, target: "2024-06-15T12:00:00Z" }`. Secondary
progressions (day-for-a-year): the chart at age _N_ years is the sky _N_ days
after birth. Returns progressed `planets`, plus `houses`/`ascendant`/
`midheaven` when the birth time is known, `ageYears`, and `progressedInstant`.

## Time handling (accuracy-critical)

- Input is **always** a local civil date/time + an **IANA timezone name**
  (e.g. `Europe/Lisbon`) — never a raw UTC offset. We use **Luxon** to
  interpret the local time in that named zone, which applies the correct
  **historical DST** rules, convert to UTC, then to a Julian Day (UT) for sweph.
- `geo-tz` is available to derive a zone from lat/lon when a caller lacks one.
- **Unknown time** (`timeKnown: false`): houses / Ascendant / MC cannot be
  computed reliably (they move ~1° every 4 minutes), so they are **omitted**
  (`houses: []`, `ascendant`/`midheaven` = `0`) and flagged
  (`housesAvailable: false`). Planet positions are computed for **local noon**
  in the birth zone (`usedNoonFallback: true`) — noon minimises worst-case Moon
  error over the unknown half-day and keeps the calendar date unambiguous.
- **Pre-1970 accuracy limit**: the IANA tz database is only reliable for dates
  after ~1970. Earlier births inherit real timing uncertainty (local-mean-time
  and early DST conventions are spotty), which can shift the Ascendant by
  minutes of arc. Such charts are flagged `preTzDatabaseEra: true`; surface this
  uncertainty to the user.

## House systems

`houseSystem` ∈ `placidus` (`P`), `koch` (`K`), `equal` (`E`), `whole_sign`
(`W`); computed with `swe_houses_ex`.

## Ephemeris files

Moshier (default) needs nothing. For full Swiss precision, Chiron, and the major
asteroids (Ceres, Pallas, Juno, Vesta):

1. Run `./scripts/fetch-ephemeris.sh`, or download by hand from Astrodienst's
   public repo: <https://github.com/aloistr/swisseph/tree/master/ephe>
   (their old `astro.com/ftp/swisseph/ephe` path was retired in September 2023
   and no longer serves the files). Main set: `sepl_*.se1`,
   `semo_*.se1`; asteroids incl. Chiron **and** Ceres/Pallas/Juno/Vesta:
   `seas_*.se1`). Without the `seas_*.se1` set those bodies stay in
   `unavailableBodies`.
2. Put them in a directory, e.g. `services/compute/ephe/`.
3. Set `SWEPH_PATH=/absolute/path/to/ephe` (or `EPHE_PATH`). The service
   switches to the Swiss backend automatically on next start.

**Production uses the `.se1` files** for arc-second accuracy; Moshier is for
dev/test convenience only.

## Tests

```bash
pnpm --filter @astroapp/compute test   # vitest run
```

Reference values come from Astro.com / Astro-Seek and are cited in the test
comments. Because tests run under **Moshier**, longitude assertions use an
honest **±0.5°** tolerance (Moshier vs Swiss differ well under 0.1° for the
major bodies in the modern era; the Moon/Ascendant and pre-1970 charts drift a
bit more). Covered: (1) a modern exact-time birth (J2000 noon @ Greenwich —
Sun/Moon/Mercury/Asc signs+degrees), (2) a **pre-1970** birth (Einstein 1879 —
signs + `preTzDatabaseEra` flag), (3) an **unknown-time** birth (houses omitted/
flagged, planets present), plus transits/synastry/progressions behaviour.

## Docker

Build from the **repo root** (the service depends on `@astroapp/shared`):

```bash
docker build -f services/compute/Dockerfile -t astroapp-compute .
docker run -p 8080:8080 astroapp-compute
```

Multi-stage: stage 1 installs the workspace (with the C/C++ toolchain + python
that `sweph` needs to compile natively), builds shared then compute, and prunes
to production deps; stage 2 is a slim `node:24` runtime. To ship `.se1` files,
place them under `services/compute/ephe/` and uncomment the `COPY`/`ENV
SWEPH_PATH` lines in the Dockerfile.

## License — this service is AGPL-3.0

The Swiss Ephemeris (`sweph` / the `.se1` data) is **dual-licensed** by
Astrodienst AG: **AGPL-3.0** _or_ a **commercial license** (~700 CHF one-time).

Because this service **links the Swiss Ephemeris**, the combined work is covered
by the AGPL. Rather than buy the commercial license, **this compute service is
released under AGPL-3.0** (see [`LICENSE`](./LICENSE)) and its
Corresponding Source is published:

- **Source:** set `PUBLIC_SOURCE_URL` to where this service's source is hosted
  (default in code: `https://github.com/Cruceru22/lucile-compute`).
- **§13 network offer:** every HTTP response carries a `Link: <source>;
  rel="source"` header, and `GET /health` returns `"source": "<url>"`, so any
  network client is told where to obtain the source. This satisfies AGPL §13
  (Remote Network Interaction).
- **Corresponding Source** = this `services/compute` tree **plus**
  [`@astroapp/shared`](../../packages/shared) (compute imports it). The publish
  snapshot bundles both under the repo's AGPL `LICENSE`. You (the copyright
  holder) retain all rights to your own code and may use `@astroapp/shared`
  elsewhere (e.g. the closed mobile app) — AGPL binds licensees, not the author.

### Why the mobile app stays closed-source

The AGPL copyleft extends to the **combined work that links the Swiss Ephemeris
— i.e. this compute service**, not to every program that talks to it. The mobile
app is a **separate program** that communicates only over HTTP (it never links
`sweph` or `@astroapp/shared`-the-AGPL-copy into an AGPL combined work); merely
calling a network service does not make a client a derivative work. So the app
remains closed; only this service is AGPL.

> Grey area, stated honestly: if _only_ your own app calls this service (not the
> public), some argue AGPL §13's "users interacting remotely" still reaches your
> app's end users. Publishing this service's source (done here) is the
> conservative, compliant choice and moots the argument. To avoid AGPL entirely
> and keep this service closed too, either buy the commercial license
> (<https://www.astro.com/swisseph/> → "Swiss Ephemeris License"), or swap
> `sweph` for a permissively-licensed ephemeris (e.g. `astronomy-engine`, MIT).

### Publishing the Corresponding Source

Use [`scripts/publish-compute-agpl.sh`](../../scripts/publish-compute-agpl.sh)
(from the repo root) to assemble a clean public snapshot — `services/compute` +
`packages/shared` + the AGPL `LICENSE`, **excluding `.env` and secrets** — ready
to push to a public repo. The script only stages the snapshot and prints the
push commands; it never pushes on its own.

## Shared-type reconciliation (note for later)

The `/natal` response extends `NatalChart` (from `@astroapp/shared`) with fields
the shared type does not yet carry: `timeKnown`, `housesAvailable`,
`usedNoonFallback`, `preTzDatabaseEra`, `ephemerisBackend`, `unavailableBodies`.
These were added as **additive wrapper fields on the compute response** (the
task forbids editing `packages/shared`). When convenient, reconcile by adding
the metadata to the shared `NatalChart` (or a `NatalChartMeta` wrapper).
