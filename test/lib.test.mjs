import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarUrl, dockBox, idFromLink, listUrl, normalizeList, routeOrder, routedUrl, shortCount, htmlToText, siteUrl } from '../lib.js';

test('list URL carries page, mode, sort, search and tags', () => {
    const u = new URL(listUrl({ sort: 'trending', page: 2, search: 'elf', nsfw: false, tags: ['Fantasy', 'Elf'] }));
    assert.equal(u.origin + u.pathname, 'https://janitorai.com/hampter/characters');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('mode'), 'sfw');
    assert.equal(u.searchParams.get('sort'), 'trending');
    assert.equal(u.searchParams.get('search'), 'elf');
    assert.deepEqual(u.searchParams.getAll('custom_tags'), ['Fantasy', 'Elf']);
    assert.equal(new URL(listUrl({ page: 0 })).searchParams.get('page'), '1');
});

test('id is found inside JanitorAI and JannyAI links', () => {
    const id = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
    assert.equal(idFromLink(`https://janitorai.com/characters/${id}_character-alice`), id);
    assert.equal(idFromLink(`https://jannyai.com/characters/${id.toUpperCase()}_character-alice`), id);
    assert.equal(idFromLink('nothing here'), '');
});

test('list response is normalized whatever the field spelling', () => {
    const r = normalizeList({
        data: [
            { id: 'a1', name: 'Alice', avatar: 'x.webp', tags: [{ id: 1, name: 'Romance' }], custom_tags: ['romance', 'Elf'], is_nsfw: true, total_chat: 12345, total_message: 99, creator_name: 'kit', description: '<p>Hi &amp; bye</p>' },
            { id: 'b2', chat_name: 'Bob', stats: { chat: 7 } },
            { name: 'no id' },
        ],
        total: 160, size: 80, page: 1,
    });
    assert.equal(r.items.length, 2);
    assert.equal(r.pages, 2);
    const [a, b] = r.items;
    assert.equal(a.avatar, 'https://ella.janitorai.com/bot-avatars/x.webp?width=300');
    assert.deepEqual(a.tags, ['Romance', 'Elf']);
    assert.equal(a.nsfw, true);
    assert.equal(a.chats, 12345);
    assert.equal(a.description, 'Hi & bye');
    assert.equal(a.url, 'https://janitorai.com/characters/a1');
    assert.equal(b.name, 'Bob');
    assert.equal(b.chats, 7);
    assert.equal(normalizeList([{ id: 'z' }]).items[0].id, 'z');
    assert.equal(avatarUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
});


test('JanitorAI page for opening in a new window', () => {
    assert.equal(siteUrl({ sort: 'trending24' }), 'https://janitorai.com/?segment=trending24');
    assert.equal(siteUrl({ sort: 'trending' }), 'https://janitorai.com/?segment=trending');
    assert.equal(siteUrl({ sort: 'popular' }), 'https://janitorai.com/?segment=popular');
    assert.equal(new URL(siteUrl({ sort: 'latest' })).pathname, '/search');
    const u = new URL(siteUrl({ sort: 'trending', search: 'elf', nsfw: false }));
    assert.equal(u.origin + u.pathname, 'https://janitorai.com/search');
    assert.equal(u.searchParams.get('sort'), 'trending');
    assert.equal(u.searchParams.get('mode'), 'sfw');
    assert.equal(u.searchParams.get('search'), 'elf');
});

test('routes', () => {
    assert.equal(routedUrl('https://a.b/c?d=1&e=2', 'st'), '/proxy/https%3A%2F%2Fa.b%2Fc%3Fd%3D1%26e%3D2');
    assert.equal(routedUrl('https://a.b/c', 'custom', 'https://p.x/?url={url}'), 'https://p.x/?url=https%3A%2F%2Fa.b%2Fc');
    assert.equal(routedUrl('https://a.b/c', 'custom', 'https://p.x/'), 'https://p.x/https%3A%2F%2Fa.b%2Fc');
    assert.equal(routedUrl('https://a.b/c', 'custom', ''), '');
    assert.deepEqual(routeOrder('auto'), ['st', 'direct']);
    assert.deepEqual(routeOrder('auto', 'https://p/'), ['st', 'custom', 'direct']);
    assert.deepEqual(routeOrder('custom'), ['st']);
});

test('text helpers', () => {
    assert.equal(htmlToText('a<br>b<p>c</p><script>x</script>&#3588;'), 'a\nb\nc\nค');
    assert.equal(shortCount(999), '999');
    assert.equal(shortCount(1234), '1.2k');
    assert.equal(shortCount(25000), '25k');
    assert.equal(shortCount(3_400_000), '3.4M');
});

test('Datacat window box stays on screen', () => {
    const vp = { width: 400, height: 800 };
    assert.deepEqual(dockBox({ left: 0.4, top: 100.6, width: 400, height: 700 }, vp), { left: 0, top: 101, width: 400, height: 699 });
    assert.deepEqual(dockBox({ left: -20, top: 50, width: 500, height: 900 }, vp), { left: 0, top: 50, width: 400, height: 750 });
    assert.equal(dockBox({ left: 0, top: 0, width: 0, height: 0 }, vp), null);
    assert.equal(dockBox(null, vp), null);
});
