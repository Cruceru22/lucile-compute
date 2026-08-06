/**
 * R4 QA PASS — C-series gating audit (extends gatingAudit.r2 for B-series).
 *
 * For each C-series PREMIUM feature this pins the SPECIFIC screen that owns the
 * surface and asserts the `<PremiumGate feature="…">` (or `useFeatureAccess`)
 * lives in THAT file, AND that the same key is `premium` in the entitlement
 * matrix. It also asserts the deliberately-FREE C-series surfaces (the glossary /
 * learning screens and the tropical↔sidereal zodiac toggle) carry NO gate — so a
 * future change that accidentally paywalls a free surface is caught too.
 *
 * Filesystem-scanning lives in the compute workspace because the Expo tsconfig
 * does not provide Node types (same reason as gatingAudit.r2 / securityAudit).
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

/**
 * The C-series premium features, each mapped to the screen that owns its surface
 * and the gate-key that file must contain. The chart-embedded asteroid surface
 * is gated in `ChartScreen.tsx` via `useFeatureAccess('asteroids')` (the wheel +
 * lists hide the four bodies unless entitled AND toggled on) — we assert exactly
 * that, rather than a separate asteroid screen.
 */
const FEATURE_SCREENS: ReadonlyArray<{
  feature: string;
  screen: string;
  gateKey: string;
}> = [
  {
    feature: 'profections',
    screen: 'features/profections/ProfectionsScreen.tsx',
    gateKey: 'profections',
  },
  { feature: 'returns', screen: 'features/returns/ReturnsScreen.tsx', gateKey: 'returns' },
  {
    feature: 'planetary_hours',
    screen: 'features/planetaryHours/PlanetaryHoursScreen.tsx',
    gateKey: 'planetary_hours',
  },
  {
    feature: 'config_search',
    screen: 'features/search/SearchScreen.tsx',
    gateKey: 'config_search',
  },
  // Chart-embedded premium surface (gated by entitlement + a persisted toggle).
  { feature: 'asteroids', screen: 'features/chart/ChartScreen.tsx', gateKey: 'asteroids' },
];

/**
 * Mirror of the entitlement matrix (kept in sync with entitlements.ts). We
 * re-list rather than import because the Expo path aliases (@/...) are not
 * resolvable from the compute workspace; the matrix-logic test lives in the
 * mobile workspace (gatingAudit.test.ts).
 */
const PREMIUM_KEYS = new Set([
  'transit_timeline',
  'progressions',
  'profections',
  'returns',
  'config_search',
  'planetary_hours',
  'synastry',
  'composite',
  'astrocartography',
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

describe('C-series gating audit — every new premium feature is gated on its own screen', () => {
  for (const { feature, screen, gateKey } of FEATURE_SCREENS) {
    it(`${feature} is a premium key AND ${screen} gates on "${gateKey}"`, () => {
      expect(PREMIUM_KEYS.has(feature), `${feature} must be premium`).toBe(true);
      const src = readSrc(screen);
      expect(src.length, `screen file missing: ${screen}`).toBeGreaterThan(0);
      expect(gatesFeature(src, gateKey), `${screen} does not gate on "${gateKey}"`).toBe(true);
    });
  }

  it('the entitlement matrix file marks every C-series feature premium', () => {
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(matrix.length).toBeGreaterThan(0);
    for (const { feature } of FEATURE_SCREENS) {
      const re = new RegExp(`${feature}\\s*:\\s*'premium'`);
      expect(re.test(matrix), `${feature} is not 'premium' in entitlements.ts`).toBe(true);
    }
  });
});

describe('C-series gating audit — glossary/learn + zodiac toggle are intentionally FREE', () => {
  // C4 (glossary + learning) is a free surface: no gate anywhere in its screens.
  const LEARN_SCREENS = [
    'features/learn/LearnScreen.tsx',
    'features/learn/GlossaryView.tsx',
    'features/learn/CourseView.tsx',
  ];
  for (const screen of LEARN_SCREENS) {
    it(`${screen} carries NO premium gate (learning is free)`, () => {
      const src = readSrc(screen);
      expect(src.length, `screen file missing: ${screen}`).toBeGreaterThan(0);
      expect(gatesAnything(src), `${screen} unexpectedly gates a feature`).toBe(false);
    });
  }

  it('glossary + tap_to_learn are FREE in the entitlement matrix', () => {
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(/glossary\s*:\s*'free'/.test(matrix)).toBe(true);
    expect(/tap_to_learn\s*:\s*'free'/.test(matrix)).toBe(true);
  });

  it('C6 zodiac (tropical↔sidereal) toggle is FREE — ZodiacSwitcher carries no gate', () => {
    const src = readSrc('features/chart/ZodiacSwitcher.tsx');
    expect(src.length, 'ZodiacSwitcher.tsx missing').toBeGreaterThan(0);
    expect(gatesAnything(src), 'the zodiac toggle must not be paywalled').toBe(false);
    // There is intentionally NO `zodiac`/`sidereal` feature key in the matrix.
    const matrix = readSrc('features/paywall/entitlements.ts');
    expect(/['"]?zodiac['"]?\s*:\s*'premium'/.test(matrix)).toBe(false);
    expect(/sidereal\s*:\s*'premium'/.test(matrix)).toBe(false);
  });
});
