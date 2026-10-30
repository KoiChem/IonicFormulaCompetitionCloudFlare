import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {CollectingParade,paradeGeometry} from '../../src/features/lobby/CollectingParade';
it('keeps one participant outside before wrapping and many participants evenly spaced',()=>{expect(paradeGeometry(600,1)).toEqual({distance:744,spacing:744,duration:9.3});expect(paradeGeometry(600,50)).toEqual({distance:8000,spacing:160,duration:100});});
it('renders entry order and nicknames without score or ranking',()=>{const html=renderToStaticMarkup(createElement(CollectingParade,{roomId:'room',participants:[{id:'b',joinedOrder:2,nickname:'二番'},{id:'a',joinedOrder:1,nickname:'一番'}]}));expect(html.indexOf('一番')).toBeLessThan(html.indexOf('二番'));expect(html).toContain('結果を集計しています');expect(html).toContain('parade-arm');expect(html).not.toContain('位');});

it('uses approved reference head proportions and rigid straight legs with fixed short toes',()=>{const html=renderToStaticMarkup(createElement(CollectingParade,{roomId:'room',participants:[{id:'a',nickname:'一番',joinedOrder:1}]}));expect(html).toContain('viewBox="40 110 420 780"');expect(html).toContain('cx="273" cy="286" r="130"');expect(html.match(/d="M273 647L273 842L211 842"/g)).toHaveLength(2);expect(html).toContain('parade-leg-front');expect(html).toContain('parade-leg-back');expect(html).toContain('M273 438V647');expect(html).not.toContain('M50 83');});
