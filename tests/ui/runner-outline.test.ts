import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Runner } from '../../src/features/lobby/HostRace';

function luminance(hex: string) {
  const c = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}

describe('runner visibility', () => {
  for (const pose of [{}, { rest: true }, { dash: true }, { goal: true }]) {
    it(`renders thin dark boundaries while preserving the bright reference fill: ${JSON.stringify(pose)}`, () => {
      const html = renderToStaticMarkup(createElement(Runner, { id: 'runner', color: '#fff500', stopped: false, goal: false, ...pose }));
      expect(html).toContain('color:#fff500');
      const outlines = [...html.matchAll(/style="(stroke:#[0-9a-f]{6};stroke-width:[^"]+)"/g)];
      expect(outlines.length).toBeGreaterThan(3);
      for (const [, style] of outlines) {
        const stroke = style.match(/stroke:(#[0-9a-f]{6})/)![1];
        expect((luminance('#fafafa') + .05) / (luminance(stroke) + .05)).toBeGreaterThan(3);
        expect(style).toContain('stroke-width:6');
      }
      expect(html).not.toContain('filter=');
    });
  }
});
