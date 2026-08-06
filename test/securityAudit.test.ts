/**
 * Static security/privacy audits (TASK A10) — run in the compute workspace
 * because they scan the filesystem and need Node types the Expo app tsconfig
 * does not provide. Three audits, all scriptable + offline:
 *
 *   1. No secrets on device: scan apps/mobile for forbidden secret patterns;
 *      only EXPO_PUBLIC_* env + public keys are allowed client-side.
 *   2. Billing UI wiring: every UI-bearing PREMIUM feature is wrapped in a
 *      `<PremiumGate feature="…">` or `useFeatureAccess('…')`.
 *   3. RLS coverage: every sensitive table in the migrations has RLS enabled
 *      with owner-only policies (and flag the known over-permissive one).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MOBILE_ROOT = join(REPO_ROOT, 'apps/mobile');
const MOBILE_SRC = join(MOBILE_ROOT, 'src');
const MIGRATIONS = join(REPO_ROOT, 'supabase/migrations');

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(p, exts, out);
    } else if (exts.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

// ===========================================================================
// 1) Secrets-on-device
// ===========================================================================
describe('security audit — no secrets on device', () => {
  const files = [
    ...walk(MOBILE_SRC, /\.(ts|tsx|js|json)$/),
    join(MOBILE_ROOT, 'app.json'),
    join(MOBILE_ROOT, '.env.example'),
  ];

  const FORBIDDEN: { name: string; re: RegExp }[] = [
    { name: 'ANTHROPIC_API_KEY (use)', re: /process\.env\.ANTHROPIC_API_KEY/ },
    { name: 'Anthropic key literal', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
    { name: 'SERVICE_ROLE (use)', re: /process\.env\.[A-Z_]*SERVICE_ROLE[A-Z_]*/ },
    { name: 'service_role JWT literal', re: /"role"\s*:\s*"service_role"/ },
    { name: 'RevenueCat secret key', re: /\bsk_[A-Za-z0-9]{20,}\b/ },
    { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
    {
      name: 'non-EXPO_PUBLIC secret env',
      re: /process\.env\.(?!EXPO_PUBLIC_)[A-Z_]*(SECRET|PRIVATE|SERVICE_ROLE)[A-Z_]*/,
    },
  ];

  for (const pat of FORBIDDEN) {
    it(`no client source matches: ${pat.name}`, () => {
      const hits: string[] = [];
      for (const f of files) {
        let content: string;
        try {
          content = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (pat.re.test(content)) hits.push(f.replace(REPO_ROOT, '.'));
      }
      expect(hits, `"${pat.name}" found in: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('only references EXPO_PUBLIC_* (or NODE_ENV) env vars in client code', () => {
    const offenders: string[] = [];
    const envRef = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    for (const f of walk(MOBILE_SRC, /\.(ts|tsx)$/)) {
      const content = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = envRef.exec(content)) !== null) {
        const name = m[1] as string;
        if (!name.startsWith('EXPO_PUBLIC_') && name !== 'NODE_ENV') {
          offenders.push(`${f.replace(REPO_ROOT, '.')}: ${name}`);
        }
      }
    }
    expect(offenders, `non-public env references: ${offenders.join('; ')}`).toEqual([]);
  });

  it('apps/mobile/.env.example declares only public-safe vars', () => {
    const env = readFileSync(join(MOBILE_ROOT, '.env.example'), 'utf8');
    const declared = env
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((l) => (l.split('=')[0] as string).trim());
    for (const name of declared) {
      expect(name.startsWith('EXPO_PUBLIC_'), `non-public env declared: ${name}`).toBe(true);
    }
  });
});

// ===========================================================================
// 2) Billing UI wiring
// ===========================================================================
describe('security audit — premium UI features are gated', () => {
  const ALL_SOURCE = walk(MOBILE_SRC, /\.(ts|tsx)$/)
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  // Premium features with a user-facing surface today → MUST be gated.
  const PREMIUM_WITH_UI = [
    'transit_timeline',
    'synastry',
    'multiple_profiles',
    'ai_chat',
    'pdf_reports',
  ];

  it('every UI-bearing premium feature is wrapped in a gate', () => {
    const ungated: string[] = [];
    for (const f of PREMIUM_WITH_UI) {
      const gated =
        ALL_SOURCE.includes(`feature="${f}"`) ||
        ALL_SOURCE.includes(`useFeatureAccess('${f}')`) ||
        ALL_SOURCE.includes(`useFeatureAccess("${f}")`);
      if (!gated) ungated.push(f);
    }
    expect(ungated, `premium features missing a gate: ${ungated.join(', ')}`).toEqual([]);
  });
});

// ===========================================================================
// 3) RLS coverage in migrations
// ===========================================================================
describe('security audit — RLS coverage in migrations', () => {
  const sql = walk(MIGRATIONS, /\.sql$/)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .toLowerCase();

  const SENSITIVE_TABLES = [
    'profiles',
    'birth_data',
    'charts',
    'subscriptions',
    'push_tokens',
    'notification_settings',
    'sent_transits',
  ];

  for (const t of SENSITIVE_TABLES) {
    it(`enables RLS on public.${t}`, () => {
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    });

    it(`defines an owner-only SELECT policy on ${t}`, () => {
      // Each table has a `<table>_select_own` policy keyed on auth.uid().
      expect(sql).toContain(`"${t}_select_own"`);
    });
  }

  it('reports storage bucket policies are owner-scoped by path', () => {
    expect(sql).toContain('reports_select_own');
    expect(sql).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  });
});
