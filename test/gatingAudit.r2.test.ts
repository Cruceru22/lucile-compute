/**
 * ROADMAP-V2 QA PASS — B-series gating audit (extends the A10 securityAudit).
 *
 * The A10 `securityAudit.test.ts` proves the *aggregate* invariant: every
 * UI-bearing premium feature appears in a gate somewhere in the bundle. This
 * audit is sharper for the B-series: for each premium feature key it pins the
 * SPECIFIC screen that owns the surface and asserts the gate lives in THAT file
 * (so moving a screen's content out from under its gate is caught), and
 * cross-checks that the same key is `premium` in the entitlement matrix.
 *
 * Mapping rationale (Advanced screen): harmonics/midpoints/antiscia/fixed_stars
 * are one screen (`AdvancedScreen.tsx`) gated as a whole behind `feature="harmonics"`
 * (any one technique requires Premium). So the three sibling keys are gated
 * transitively by the screen-level harmonics gate — we assert exactly that,
 * rather than pretending each has its own independent gate string.
 *
 * Filesystem-scanning lives in the compute workspace because the Expo tsconfig
 * does not provide Node types (same reason as securityAudit).
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

/**
 * The B-series premium features the QA brief enumerates, each mapped to the
 * screen that owns its surface and the gate-key that file must contain. For the
 * Advanced techniques the gate key is the screen-level `harmonics` gate.
 */
const FEATURE_SCREENS: ReadonlyArray<{
  feature: string;
  screen: string;
  gateKey: string;
}> = [
  {
    feature: 'transit_timeline',
    screen: 'features/sky/SkyScreen.tsx',
    gateKey: 'transit_timeline',
  },
  {
    feature: 'progressions',
    screen: 'features/progressions/ProgressionsScreen.tsx',
    gateKey: 'progressions',
  },
  { feature: 'composite', screen: 'features/synastry/SynastryScreen.tsx', gateKey: 'composite' },
  { feature: 'synastry', screen: 'features/synastry/SynastryScreen.tsx', gateKey: 'synastry' },
  { feature: 'harmonics', screen: 'features/advanced/AdvancedScreen.tsx', gateKey: 'harmonics' },
  // Advanced siblings: gated transitively by the screen-level harmonics gate.
  { feature: 'midpoints', screen: 'features/advanced/AdvancedScreen.tsx', gateKey: 'harmonics' },
  { feature: 'antiscia', screen: 'features/advanced/AdvancedScreen.tsx', gateKey: 'harmonics' },
  { feature: 'fixed_stars', screen: 'features/advanced/AdvancedScreen.tsx', gateKey: 'harmonics' },
  { feature: 'ai_chat', screen: 'features/ai/AiChatScreen.tsx', gateKey: 'ai_chat' },
  { feature: 'pdf_reports', screen: 'features/ai/ReportsScreen.tsx', gateKey: 'pdf_reports' },
  {
    feature: 'multiple_profiles',
    screen: 'features/profiles/AddProfileScreen.tsx',
    gateKey: 'multiple_profiles',
  },
];

describe('B-series gating audit — every premium feature is gated on its own screen', () => {
  // Mirror of the entitlement matrix (kept in sync with entitlements.ts). We
  // re-list rather than import because the Expo path aliases (@/...) are not
  // resolvable from the compute workspace; the matrix-logic test lives in the
  // mobile workspace (gatingAudit.test.ts).
  const PREMIUM_KEYS = new Set([
    'transit_timeline',
    'progressions',
    'profections',
    'returns',
    'synastry',
    'composite',
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

  for (const { feature, screen, gateKey } of FEATURE_SCREENS) {
    it(`${feature} is a premium key AND ${screen} gates on "${gateKey}"`, () => {
      expect(PREMIUM_KEYS.has(feature), `${feature} must be premium`).toBe(true);
      const src = readSrc(screen);
      expect(src.length, `screen file missing: ${screen}`).toBeGreaterThan(0);
      expect(gatesFeature(src, gateKey), `${screen} does not gate on "${gateKey}"`).toBe(true);
    });
  }

  it('the entitlement matrix file marks every audited feature premium', () => {
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(matrix.length).toBeGreaterThan(0);
    for (const { feature } of FEATURE_SCREENS) {
      // e.g. `transit_timeline: 'premium'`
      const re = new RegExp(`${feature}\\s*:\\s*'premium'`);
      expect(re.test(matrix), `${feature} is not 'premium' in entitlements.ts`).toBe(true);
    }
  });
});
