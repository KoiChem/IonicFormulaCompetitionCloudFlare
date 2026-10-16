import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Runner } from '../../src/features/lobby/HostRace';

const poses = [{}, { rest: true }, { dash: true }, { goal: true }];
describe('runner outer silhouette', () => {
  for (const pose of poses) {
    it(`outlines the composite body once, excluding decorations: ${JSON.stringify(pose)}`, () => {
      const html = renderToStaticMarkup(createElement(Runner, { id: 'runner', color: '#fff500', stopped: false, goal: false, ...pose }));
      expect(html).toContain('color:#fff500');
      expect(html.match(/ filter=/g)).toHaveLength(1);
      expect(html).toMatch(/<g class="runner-body" filter="url\(#[^)]+\)">/);
      expect(html).toContain('<feMorphology in="SourceAlpha" operator="dilate" radius="1"');
      expect(html).toContain('operator="out"');
      expect(html).toContain('<feMergeNode in="SourceGraphic"');
      expect(html).not.toContain('stroke-width:6');
      expect(html).not.toContain('style="stroke:');
      for (const tag of html.matchAll(/<[^>]+class="[^"]*(?:runner-shadow|runner-sweat|runner-joy-ray|runner-dash-speed|runner-rest-sleep)[^"]*"[^>]*>/g)) {
        expect(tag[0]).not.toContain('filter=');
      }
      const bodyStart = html.indexOf('<g class="runner-body"');
      const tags = html.slice(bodyStart).match(/<\/?g\b[^>]*>|<[^>]+>/g)!;
      let depth = 0;
      for (const tag of tags) {
        if (/^<g\b/.test(tag)) depth++;
        if (depth > 0) expect(tag).not.toMatch(/class="[^"]*(?:runner-shadow|runner-sweat|runner-joy-ray|runner-dash-speed|runner-rest-sleep)/);
        if (tag === '</g>' && --depth === 0) break;
      }
    });
  }
  it('keeps filter references unique across runners in the same render', () => {
    const html = renderToStaticMarkup(createElement('div', null, ...poses.map((pose, index) => createElement(Runner, { key: index, id: 'same-id', goal: false, stopped: false, ...pose }))));
    const ids = [...html.matchAll(/<filter id="([^"]+)"/g)].map(match => match[1]);
    const references = [...html.matchAll(/ filter="url\(#([^)]+)\)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(references).toEqual(ids);
  });
});
