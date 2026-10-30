import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {CollectingParade,paradeGeometry} from '../../src/features/lobby/CollectingParade';
it('keeps one participant outside before wrapping and many participants evenly spaced',()=>{expect(paradeGeometry(600,1)).toEqual({distance:744,spacing:744,duration:9.3});expect(paradeGeometry(600,50)).toEqual({distance:8000,spacing:160,duration:100});});
it('renders entry order and nicknames without score or ranking',()=>{const html=renderToStaticMarkup(createElement(CollectingParade,{roomId:'room',participants:[{id:'b',joinedOrder:2,nickname:'二番'},{id:'a',joinedOrder:1,nickname:'一番'}]}));expect(html.indexOf('一番')).toBeLessThan(html.indexOf('二番'));expect(html).toContain('結果を集計しています');expect(html).toContain('parade-arm');expect(html).not.toContain('位');});
