/**
 * Directed profections — verified against the worked example from the source
 * lecture: Ascendant 27°59′ Aquarius, profected 8th house this year, directed
 * point starting ~28° Virgo on the birthday and moving 30°/year. Documented
 * anchors from that example:
 *   - Dec 15 → ~3° Libra
 *   - Jan 20 → ~6° Libra, sextile natal Mars at 6° Leo
 *   - Apr 27 → ~14° Libra, crossing the Mercury→Jupiter Egyptian bound in Libra
 */
import { describe, expect, it } from 'vitest';
import type { NatalChart, Planet } from '@astroapp/shared';

import { directedProfectionsInRange, directedProfectionMonths } from '@astroapp/shared';

function planet(name: Planet['name'], absoluteDegree: number, house = 1): Planet {
  const sign = [
    'Aries',
    'Taurus',
    'Gemini',
    'Cancer',
    'Leo',
    'Virgo',
    'Libra',
    'Scorpio',
    'Sagittarius',
    'Capricorn',
    'Aquarius',
    'Pisces',
  ][Math.floor((((absoluteDegree % 360) + 360) % 360) / 30)] as Planet['sign'];
  return {
    name,
    sign,
    degree: ((absoluteDegree % 30) + 30) % 30,
    absoluteDegree: ((absoluteDegree % 360) + 360) % 360,
    house,
    retrograde: false,
  };
}

// Minimal chart: ASC 27°59′ Aquarius (327.983°), natal Mars at 6° Leo (126°).
// Sun placed in the 10th house (above horizon → day chart) just so Lots resolve.
const CHART: NatalChart = {
  planets: [
    planet('Sun', 200, 10), // 20° Libra, 10th house → day chart
    planet('Moon', 50, 12),
    planet('Mars', 126, 6), // 6° Leo
  ],
  houses: [],
  aspects: [],
  ascendant: 327.983,
  midheaven: 240,
  houseSystem: 'whole_sign',
  computedAt: '2024-01-01T00:00:00.000Z',
  housesAvailable: true,
  timeKnown: true,
};

const BIRTH = '1993-10-15'; // age 31 on 2024-10-15 → (31 mod 12)+1 = 8th profected house
const FROM = '2024-10-15T00:00:00Z';
const TO = '2025-10-15T00:00:00Z';

describe('directedProfectionsInRange — golden lecture example', () => {
  const res = directedProfectionsInRange(CHART, BIRTH, FROM, TO);

  it('is available with a known birth time', () => {
    expect(res.available).toBe(true);
  });

  it('finds the directed point sextile natal Mars around Jan 20 2025', () => {
    const hit = res.activations.find(
      (a) => a.kind === 'aspect' && a.aspect === 'sextile' && a.target === 'natal Mars',
    );
    expect(hit).toBeTruthy();
    // ~6° Libra, ~Jan 20 2025 (allow a few days for calendar rounding).
    expect(hit!.exactDate >= '2025-01-15' && hit!.exactDate <= '2025-01-25').toBe(true);
    expect(hit!.directedPosition).toMatch(/Libra/);
    expect(Math.round(hit!.directedLongitude)).toBe(186); // 6° Libra
  });

  it('finds the Mercury→Jupiter Egyptian-bound crossing at 14° Libra around Apr 27 2025', () => {
    const hit = res.activations.find(
      (a) => a.kind === 'bound' && a.fromBoundRuler === 'Mercury' && a.toBoundRuler === 'Jupiter',
    );
    expect(hit).toBeTruthy();
    expect(hit!.exactDate >= '2025-04-20' && hit!.exactDate <= '2025-05-05').toBe(true);
    expect(hit!.directedPosition).toMatch(/Libra/);
    expect(Math.round(hit!.directedLongitude)).toBe(194); // 14° Libra
  });

  it('produces tight orb windows (a couple of weeks each side, not months)', () => {
    const hit = res.activations.find((a) => a.target === 'natal Mars' && a.aspect === 'sextile')!;
    const span =
      (new Date(hit.windowEnd).getTime() - new Date(hit.windowStart).getTime()) / 86_400_000;
    // 1.5° orb at ~12.17 days/° ≈ 37-day total window.
    expect(span).toBeGreaterThan(20);
    expect(span).toBeLessThan(50);
  });
});

describe('directedProfectionsInRange — guards', () => {
  it('degrades when the birth time (Ascendant) is unknown', () => {
    const noAsc: NatalChart = { ...CHART, ascendant: null, housesAvailable: false };
    const res = directedProfectionsInRange(noAsc, BIRTH, FROM, TO);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/Ascendant|birth time/i);
  });

  it('rejects an inverted window', () => {
    const res = directedProfectionsInRange(CHART, BIRTH, TO, FROM);
    expect(res.available).toBe(false);
  });
});

describe('directedProfectionMonths', () => {
  it('buckets activations into 12 labelled months', () => {
    const out = directedProfectionMonths(CHART, BIRTH, FROM);
    expect(out.available).toBe(true);
    expect(out.months).toHaveLength(12);
    expect(out.months[0]!.label).toMatch(/2024/);
    // The January 2025 bucket should mention the Mars sextile.
    const jan = out.months.find((m) => m.label.startsWith('January 2025'));
    expect(jan!.list).toMatch(/Mars/);
  });
});
