/**
 * Accuracy harness (TASK A10).
 *
 * Runs compute `/natal` (via {@link computeNatal}) for every case in
 * `./cases.ts`, computes the per-body degree delta against the cited reference
 * values, and asserts within the documented Moshier tolerances. Consistency-only
 * cases assert engine-internal invariants instead of external references.
 *
 * SIDE EFFECT: after the suite runs it writes `docs/ACCURACY-REPORT.md` with a
 * full results table (case, source, reference vs computed, delta, pass/fail) so
 * the report never drifts from the actual computed numbers. The written file is
 * committed; regenerate by re-running `pnpm --filter @astroapp/compute test`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeNatal, type NatalChartResponse } from '../../src/natal.js';
import { getBackend } from '../../src/ephemeris.js';
import { signFor } from '../../src/astro.js';
import { CASES, type AccuracyCase, type ReferenceCase } from './cases.js';

/** Absolute angular difference on a circle, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

interface ReportRow {
  caseId: string;
  kind: AccuracyCase['kind'];
  body: string;
  reference: string;
  computed: string;
  delta: string;
  tol: string;
  pass: boolean;
}

const rows: ReportRow[] = [];
const backend = getBackend();

/** Find a computed longitude for a body or angle in a chart. */
function computedLongitude(chart: NatalChartResponse, body: string): number | null {
  if (body === 'Ascendant') return chart.ascendant;
  if (body === 'Midheaven') return chart.midheaven;
  const p = chart.planets.find((pl) => pl.name === body);
  return p ? p.absoluteDegree : null;
}

describe(`accuracy harness (backend: ${backend})`, () => {
  for (const c of CASES) {
    describe(`${c.id} — ${c.description}`, () => {
      const chart = computeNatal(c.birth);

      if (c.kind === 'reference') {
        const rc = c as ReferenceCase;
        for (const exp of rc.expect) {
          const label = exp.signOnly ? `${exp.body} (sign only)` : exp.body;
          it(`matches reference: ${label}`, () => {
            const got = computedLongitude(chart, exp.body);
            expect(got).not.toBeNull();
            const gotDeg = got as number;
            const delta = angDiff(gotDeg, exp.absoluteDegree);
            const signGot = signFor(gotDeg);

            // Sign assertion (always, when an expected sign is given).
            if (exp.sign) expect(signGot).toBe(exp.sign);

            const pass = exp.signOnly ? signGot === exp.sign : delta <= exp.tol;
            rows.push({
              caseId: c.id,
              kind: c.kind,
              body: label,
              reference: `${exp.absoluteDegree.toFixed(2)}° (${exp.sign ?? '—'})`,
              computed: `${gotDeg.toFixed(2)}° (${signGot})`,
              delta: exp.signOnly ? 'sign-only' : `${delta.toFixed(3)}°`,
              tol: exp.signOnly ? '—' : `${exp.tol}°`,
              pass,
            });

            if (!exp.signOnly) {
              expect(
                delta,
                `${exp.body}: computed ${gotDeg.toFixed(3)}° vs reference ${exp.absoluteDegree}° (Δ ${delta.toFixed(3)}° > ${exp.tol}°)`,
              ).toBeLessThanOrEqual(exp.tol);
            }
          });
        }
      } else {
        // Consistency-only invariants — NOT an accuracy proof.
        it('is deterministic (recompute yields identical longitudes)', () => {
          const again = computeNatal(c.birth);
          for (const p of chart.planets) {
            const q = again.planets.find((x) => x.name === p.name)!;
            expect(q.absoluteDegree).toBe(p.absoluteDegree);
          }
          expect(again.ascendant).toBe(chart.ascendant);
          expect(again.midheaven).toBe(chart.midheaven);
          rows.push({
            caseId: c.id,
            kind: c.kind,
            body: 'determinism',
            reference: 'self',
            computed: `${chart.planets.length} bodies`,
            delta: '0',
            tol: '—',
            pass: true,
          });
        });

        it('keeps degree-within-sign coherent with absolute longitude', () => {
          for (const p of chart.planets) {
            expect(p.sign).toBe(signFor(p.absoluteDegree));
            expect(p.degree).toBeCloseTo(p.absoluteDegree % 30, 6);
            expect(p.absoluteDegree).toBeGreaterThanOrEqual(0);
            expect(p.absoluteDegree).toBeLessThan(360);
          }
        });

        it('marks retrograde iff the longitudinal speed is negative', () => {
          for (const p of chart.planets) {
            if (typeof p.speed === 'number') {
              expect(p.retrograde).toBe(p.speed < 0);
            }
          }
        });

        if (c.birth.timeKnown) {
          it('returns 12 house cusps and places every body in a valid house', () => {
            expect(chart.housesAvailable).toBe(true);
            expect(chart.houses).toHaveLength(12);
            for (const p of chart.planets) {
              expect(p.house).toBeGreaterThanOrEqual(1);
              expect(p.house).toBeLessThanOrEqual(12);
            }
          });
        } else {
          it('omits houses and flags the unknown-time contract', () => {
            expect(chart.timeKnown).toBe(false);
            expect(chart.housesAvailable).toBe(false);
            expect(chart.houses).toHaveLength(0);
            expect(chart.usedNoonFallback).toBe(true);
            expect(chart.ascendant).toBe(0);
            expect(chart.midheaven).toBe(0);
            for (const p of chart.planets) expect(p.house).toBe(0);
          });
        }

        if (c.expectSunSign) {
          it(`places the Sun in ${c.expectSunSign} (date-derived sanity)`, () => {
            const sun = chart.planets.find((p) => p.name === 'Sun')!;
            expect(sun.sign).toBe(c.expectSunSign);
          });
        }

        // Special handling: sign-cusp case asserts proximity to the boundary.
        if (c.id === 'sign-cusp-aries-taurus') {
          it('places the Sun within ~1.5° of the 30° Aries/Taurus boundary', () => {
            const sun = chart.planets.find((p) => p.name === 'Sun')!;
            // Distance to the 30° boundary (end of Aries / start of Taurus).
            const dist = angDiff(sun.absoluteDegree, 30);
            expect(dist).toBeLessThanOrEqual(1.5);
          });
        }

        rows.push({
          caseId: c.id,
          kind: c.kind,
          body: 'invariants',
          reference: 'engine-internal',
          computed: `${chart.planets.length} bodies, houses=${chart.housesAvailable}`,
          delta: 'n/a',
          tol: '—',
          pass: true,
        });
      }
    });
  }

  afterAll(() => {
    writeAccuracyReport(rows, backend);
  });
});

function writeAccuracyReport(allRows: ReportRow[], backendName: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '../../../../docs/ACCURACY-REPORT.md');

  const refRows = allRows.filter((r) => r.kind === 'reference');
  const refCases = new Set(refRows.map((r) => r.caseId));
  const consCases = new Set(allRows.filter((r) => r.kind === 'consistency').map((r) => r.caseId));
  const refFails = refRows.filter((r) => !r.pass);
  const worst = refRows
    .filter((r) => r.delta.endsWith('°'))
    .map((r) => ({ id: r.caseId, body: r.body, d: parseFloat(r.delta) }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 5);

  const lines: string[] = [];
  lines.push('# AstroApp — Accuracy Report (TASK A10)');
  lines.push('');
  lines.push('> Auto-generated by `services/compute/test/accuracy/accuracy.test.ts`. Re-run');
  lines.push('> `pnpm --filter @astroapp/compute test` to regenerate.');
  lines.push('');
  lines.push(`**Active ephemeris backend:** \`${backendName}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total cases: **${refCases.size + consCases.size}**`);
  lines.push(`- Reference-checked cases (cited external ground truth): **${refCases.size}**`);
  lines.push(
    `- Consistency-only cases (engine-internal invariants, NOT accuracy proofs): **${consCases.size}**`,
  );
  lines.push(`- Reference assertions: **${refRows.length}**, failures: **${refFails.length}**`);
  lines.push('');
  lines.push('### Worst reference deltas');
  lines.push('');
  if (worst.length === 0) {
    lines.push('_No numeric reference deltas recorded._');
  } else {
    lines.push('| Case | Body | Δ (deg) |');
    lines.push('| --- | --- | --- |');
    for (const w of worst) lines.push(`| ${w.id} | ${w.body} | ${w.d.toFixed(3)} |`);
  }
  lines.push('');
  lines.push('## Reference-checked results');
  lines.push('');
  lines.push('| Case | Body | Reference | Computed | Δ | Tol | Pass |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of refRows) {
    lines.push(
      `| ${r.caseId} | ${r.body} | ${r.reference} | ${r.computed} | ${r.delta} | ${r.tol} | ${r.pass ? '✅' : '❌'} |`,
    );
  }
  lines.push('');
  lines.push('## Consistency-only cases (engine-internal)');
  lines.push('');
  lines.push('| Case | Result |');
  lines.push('| --- | --- |');
  for (const id of consCases) {
    const r = allRows.find((x) => x.caseId === id && x.body === 'invariants');
    lines.push(`| ${id} | ${r?.computed ?? 'invariants asserted'} |`);
  }
  lines.push('');
  lines.push('## Sources');
  lines.push('');
  for (const c of CASES) {
    if (c.kind === 'reference') {
      lines.push(`- **${c.id}** — ${c.source}`);
      if (c.caveat) lines.push(`  - Caveat: ${c.caveat}`);
    }
  }
  lines.push('');
  lines.push('## Caveats & accuracy limits');
  lines.push('');
  lines.push(
    '- **Moshier vs Swiss `.se1`.** The default backend is the built-in Moshier analytic ephemeris (no data files). Moshier vs full Swiss differ by well under ~0.1° for the Sun and major planets in the modern era; the Moon and angles can drift slightly more. Arc-second production accuracy requires the Swiss `.se1` files **and** the Swiss Ephemeris Professional license — a release blocker tracked in the QA report.',
  );
  lines.push(
    '- **Pre-1970 timezone uncertainty (`preTzDatabaseEra`).** The IANA tz database is only reliable after ~1970. Earlier births inherit local-mean-time / DST ambiguity of minutes, which can move the Ascendant by a degree or more. Pre-1970 angle checks therefore use a wider tolerance and some are sign-only. The compute service flags these charts with `preTzDatabaseEra: true`.',
  );
  lines.push(
    '- **Chiron under Moshier.** Asteroid bodies (Chiron) need the Swiss `seas_*.se1` files; under Moshier they are omitted and reported in `unavailableBodies`.',
  );
  lines.push('');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
}
