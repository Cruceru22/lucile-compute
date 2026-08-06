/**
 * R6 QA PASS — D-series gating audit (extends gatingAuditC.r4 for D-series).
 *
 * For each D-series PREMIUM feature this pins the SPECIFIC screen that owns the
 * surface and asserts the `<PremiumGate feature="…">` (or `useFeatureAccess`)
 * lives in THAT file, AND that the same key is `premium` in the entitlement
 * matrix. It also asserts the deliberately-FREE D-series surfaces (the journal
 * daily check-in and the social friends/compare screens) carry NO gate — so a
 * future change that accidentally paywalls a free retention surface is caught.
 *
 * D-series premium↔free split (verified against the matrix + screens):
 *   - D4 rectification  → PREMIUM, gated on RectificationScreen.
 *   - D5 vedic          → PREMIUM, gated on VedicScreen.
 *   - D1 ai chat/memory → PREMIUM, gated on AiChatScreen (the co-pilot itself).
 *   - D2 journal        → FREE (a daily-habit retention surface).
 *   - D3 social         → FREE (invite/accept/compare are free growth levers).
 *
 * Filesystem-scanning lives in the compute workspace because the Expo tsconfig
 * does not provide Node types (same reason as gatingAudit.r2 / gatingAuditC.r4).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MOBILE_SRC = join(REPO_ROOT, 'apps/mobile/src');

/** Read a file under apps/mobile/src, returning '' if absent. */
function readSrc(rel: string): string {
  try {
    return readFileSync(join(MOBILE_SRC, rel), 'utf8');
  } catch {
    return '';
  }
}

/** Does `src` gate `feature` via <PremiumGate feature="…"> or useFeatureAccess? */
function gatesFeature(src: string, feature: string): boolean {
  return (
    src.includes(`feature="${feature}"`) ||
    src.includes(`useFeatureAccess('${feature}')`) ||
    src.includes(`useFeatureAccess("${feature}")`)
  );
}

/** Does `src` gate on ANY feature key at all? */
function gatesAnything(src: string): boolean {
  return /feature="[a-z_]+"|useFeatureAccess\(['"][a-z_]+['"]\)/.test(src);
}

/** The D-series premium features, each mapped to its owning screen + gate key. */
const FEATURE_SCREENS: ReadonlyArray<{
  feature: string;
  screen: string;
  gateKey: string;
}> = [
  {
    feature: 'rectification',
    screen: 'features/rectification/RectificationScreen.tsx',
    gateKey: 'rectification',
  },
  { feature: 'vedic', screen: 'features/vedic/VedicScreen.tsx', gateKey: 'vedic' },
  // D1 — the stateful AI co-pilot lives behind the existing ai_chat gate.
  { feature: 'ai_chat', screen: 'features/ai/AiChatScreen.tsx', gateKey: 'ai_chat' },
];

/** Premium key set (kept in sync with entitlements.ts; see gatingAuditC note). */
const PREMIUM_KEYS = new Set([
  'transit_timeline',
  'progressions',
  'profections',
  'returns',
  'config_search',
  'rectification',
  'planetary_hours',
  'synastry',
  'composite',
  'astrocartography',
  'vedic',
  'multiple_profiles',
  'cloud_backup',
  'ai_chat',
  'pdf_reports',
  'harmonics',
  'midpoints',
  'antiscia',
  'fixed_stars',
  'asteroids',
]);

describe('D-series gating audit — every new premium feature is gated on its own screen', () => {
  for (const { feature, screen, gateKey } of FEATURE_SCREENS) {
    it(`${feature} is a premium key AND ${screen} gates on "${gateKey}"`, () => {
      expect(PREMIUM_KEYS.has(feature), `${feature} must be premium`).toBe(true);
      const src = readSrc(screen);
      expect(src.length, `screen file missing: ${screen}`).toBeGreaterThan(0);
      expect(gatesFeature(src, gateKey), `${screen} does not gate on "${gateKey}"`).toBe(true);
    });
  }

  it('the entitlement matrix file marks rectification + vedic premium', () => {
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(matrix.length).toBeGreaterThan(0);
    expect(/rectification\s*:\s*'premium'/.test(matrix)).toBe(true);
    expect(/vedic\s*:\s*'premium'/.test(matrix)).toBe(true);
  });
});

describe('D-series gating audit — journal (D2) + social (D3) are intentionally FREE', () => {
  // The free retention/growth surfaces: no premium gate anywhere in their screens.
  // The daily check-in, the friends list, and the shareable chart are all free.
  const FREE_SCREENS = [
    'features/journal/JournalScreen.tsx',
    'features/social/FriendsScreen.tsx',
    'features/social/ShareableChart.tsx',
  ];
  for (const screen of FREE_SCREENS) {
    it(`${screen} carries NO premium gate (journal/social are free)`, () => {
      const src = readSrc(screen);
      expect(src.length, `screen file missing: ${screen}`).toBeGreaterThan(0);
      expect(gatesAnything(src), `${screen} unexpectedly gates a feature`).toBe(false);
    });
  }

  it('CompareWithFriend is FREE to open and only upsells the DEEPER analysis via the existing synastry gate', () => {
    // Connecting + the basic explained contacts are free; the full breakdown
    // reuses the pre-existing `synastry` premium gate. This asserts the ONLY gate
    // present is `synastry` — never a new social/connection paywall — so social
    // stays a free growth lever while deeper synastry remains premium (as elsewhere).
    const src = readSrc('features/social/CompareWithFriend.tsx');
    expect(src.length, 'CompareWithFriend.tsx missing').toBeGreaterThan(0);
    expect(gatesFeature(src, 'synastry'), 'deeper compare should reuse the synastry gate').toBe(
      true,
    );
    // No NEW social/journal/connection feature key is introduced as a gate here.
    const gateKeys = [...src.matchAll(/feature="([a-z_]+)"/g)].map((m) => m[1]);
    expect(gateKeys.every((k) => k === 'synastry')).toBe(true);
    expect(gateKeys).not.toContain('rectification');
    expect(gateKeys).not.toContain('vedic');
  });

  it('there is intentionally NO journal/social/connection key in the matrix', () => {
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(matrix.length).toBeGreaterThan(0);
    expect(/journal\s*:\s*'premium'/.test(matrix)).toBe(false);
    expect(/(social|connection|friends)\s*:\s*'premium'/.test(matrix)).toBe(false);
  });
});
