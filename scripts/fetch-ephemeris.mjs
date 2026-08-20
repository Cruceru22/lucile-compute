#!/usr/bin/env node
/**
 * Download the Swiss Ephemeris data files into ./ephe.
 *
 * Node rather than bash+curl because this also runs during the Vercel build,
 * and a build image is not guaranteed to have `curl` — Node is the one thing
 * that is certainly present.
 *
 * Without the `.se1` files the service falls back to the built-in Moshier
 * ephemeris, which cannot place Chiron or the four major asteroids (they come
 * back in `unavailableBodies`) and is lower precision. `/health` reports which
 * backend is live, so a deploy that silently lost them is visible immediately.
 *
 * Without `sefstars.txt` the fixed-star technique on /advanced degrades to
 * `available:false` — and that one is NOT visible in `/health`, so a deploy
 * that loses it shows up only as the Advanced screen's "catalogue not
 * installed" card. This is the file whose absence made fixed stars look broken.
 *
 * SOURCE: Astrodienst's own public repository. Their old FTP path
 * (astro.com/ftp/swisseph/ephe) was retired in September 2023 and now only
 * redirects readers to this repo.
 *
 * NOT COMMITTED: ~4MB of binary data that is not ours to redistribute. Fetching
 * at build time keeps the provenance obvious and this repository clean.
 *
 * RANGE: `_18`/`_24` are Astrodienst's 600-year blocks, covering 1800–2399 —
 * every living person's chart plus the transits and progressions this service
 * computes. Add `_12` (1200–1799) only if historical charts are ever needed.
 *
 * NON-FATAL BY DESIGN: a failed download logs loudly and exits 0. The service
 * still runs on Moshier, and failing the whole deploy because Astrodienst was
 * briefly unreachable would be a worse outcome than reduced precision.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/aloistr/swisseph/master/ephe';
// `seas_*` is the one whose absence silently costs you Chiron. `sefstars.txt`
// is the fixed-star catalogue — a ~140KB text file, not an .se1 block, and the
// only thing `swe_fixstar2_ut` reads. `computeFixedStars` probes the WHOLE
// curated list and refuses a partial result, so missing this file means the
// technique reports "catalogue not installed" rather than a Spica-only answer.
const FILES = [
  'sepl_18.se1',
  'sepl_24.se1',
  'semo_18.se1',
  'semo_24.se1',
  'seas_18.se1',
  'seas_24.se1',
  'sefstars.txt',
];

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'ephe');

async function alreadyThere(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(dest, { recursive: true });
  console.log(`Fetching Swiss Ephemeris files into ${dest}`);

  let bytes = 0;
  for (const name of FILES) {
    const target = join(dest, name);
    if (await alreadyThere(target)) {
      console.log(`  = ${name} (already present)`);
      continue;
    }
    const res = await fetch(`${BASE}/${name}`);
    // Check status explicitly: without it an HTML error page would be written
    // to a .se1 file and fail much later, far less clearly.
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(target, buf);
    bytes += buf.length;
    console.log(`  ↓ ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  console.log(`Done — ${(bytes / 1024 / 1024).toFixed(1)} MB downloaded.`);
}

main().catch((err) => {
  console.warn('\n  WARNING: could not fetch the ephemeris files.');
  console.warn(`  ${err instanceof Error ? err.message : String(err)}`);
  console.warn('  The service will run on the Moshier backend: no Chiron, no');
  console.warn('  asteroids, lower precision. /health will report "moshier".\n');
  process.exit(0); // see the note above — never fail a deploy over this
});
