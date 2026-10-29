import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAGES, dockBox, isJanitorUrl, janitorUrl } from '../lib.js';

test('only https JanitorAI addresses are shown in the tab', () => {
    assert.equal(isJanitorUrl('https://janitorai.com/characters/abc'), true);
    assert.equal(isJanitorUrl('https://www.janitorai.com/'), true);
    assert.equal(isJanitorUrl('http://janitorai.com/'), false);
    assert.equal(isJanitorUrl('https://janitorai.com.evil.example/'), false);
    assert.equal(isJanitorUrl('https://notjanitorai.com/'), false);
    assert.equal(isJanitorUrl('javascript:alert(1)'), false);
    assert.equal(isJanitorUrl(''), false);
});

test('page addresses fall back when they are not JanitorAI', () => {
    assert.equal(janitorUrl('janitorai.com/search?sort=popular'), 'https://janitorai.com/search?sort=popular');
    assert.equal(janitorUrl('https://janitorai.com'), 'https://janitorai.com/');
    assert.equal(janitorUrl('https://example.com/', 'X'), 'X');
    assert.equal(janitorUrl('', DEFAULT_PAGES.ranking), DEFAULT_PAGES.ranking);
    for (const url of Object.values(DEFAULT_PAGES)) assert.equal(isJanitorUrl(url), true);
});

test('Datacat window box stays on screen', () => {
    const vp = { width: 400, height: 800 };
    assert.deepEqual(dockBox({ left: 0.4, top: 100.6, width: 400, height: 700 }, vp), { left: 0, top: 101, width: 400, height: 699 });
    assert.deepEqual(dockBox({ left: -20, top: 50, width: 500, height: 900 }, vp), { left: 0, top: 50, width: 400, height: 750 });
    assert.equal(dockBox({ left: 0, top: 0, width: 0, height: 0 }, vp), null);
    assert.equal(dockBox(null, vp), null);
});
