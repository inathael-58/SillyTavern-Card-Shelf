import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chubListUrl, chubPageUrl, devalueUnflatten, dispositionName, megabytes, normalizeChubList, normalizeRisuList,
    parseCount, risuDownloadUrl, risuListUrl, risuSiteUrl, safeFileName, SOURCE_IDS, SOURCES, unpackSvelteData,
} from '../lib.js';

test('every source has lists, sorts for each list, and an importer', () => {
    assert.deepEqual(SOURCE_IDS, ['janitor', 'chub', 'risu']);
    for (const id of SOURCE_IDS) {
        const s = SOURCES[id];
        assert.ok(s.lists.length >= 3, id);
        for (const [list] of s.lists) assert.ok(list in s.sorts, `${id}.${list}`);
        assert.ok(['datacat', 'st-url', 'charx'].includes(s.importer), id);
        assert.equal(typeof s.listUrl, 'function');
        assert.equal(typeof s.normalize, 'function');
    }
});

test('Chub search URL', () => {
    const u = new URL(chubListUrl({ sort: 'download_count', page: 3, search: 'elf', nsfw: false }));
    assert.equal(u.origin + u.pathname, 'https://gateway.chub.ai/search');
    assert.equal(u.searchParams.get('sort'), 'download_count');
    assert.equal(u.searchParams.get('page'), '3');
    assert.equal(u.searchParams.get('search'), 'elf');
    assert.equal(u.searchParams.get('nsfw'), 'false');
    assert.equal(u.searchParams.get('namespace'), 'characters');
    assert.equal(new URL(chubListUrl({ api: 'https://api.chub.ai/' })).origin, 'https://api.chub.ai');
});

test('Chub nodes are normalized, wrapped in data or not', () => {
    const node = {
        id: 123, name: 'Alice', fullPath: 'kit/alice-the-elf', tagline: 'An <b>elf</b>', topics: ['Fantasy', 'NSFW', 'Elf'],
        starCount: 50, nChats: 1200, nMessages: 9000, avatar_url: 'https://avatars.charhub.io/avatars/kit/alice-the-elf/avatar.webp',
    };
    for (const json of [{ data: { nodes: [node, { name: 'no path' }], count: 80 } }, { nodes: [node], count: 80 }]) {
        const r = normalizeChubList(json, 1);
        assert.equal(r.items.length, 1);
        const a = r.items[0];
        assert.equal(a.id, '123');
        assert.equal(a.creator, 'kit');
        assert.equal(a.url, 'https://chub.ai/characters/kit/alice-the-elf');
        assert.deepEqual(a.tags, ['Fantasy', 'Elf']);
        assert.equal(a.nsfw, true);
        assert.equal(a.stars, 50);
        assert.equal(a.chats, 1200);
        assert.equal(a.description, 'An elf');
    }
    assert.equal(normalizeChubList({ nodes: [{ id: 1, fullPath: 'a/b' }] }).items[0].avatar, 'https://avatars.charhub.io/avatars/a/b/avatar.webp');
    assert.equal(chubPageUrl('a b/c'), 'https://chub.ai/characters/a%20b/c');
});

test('RisuRealm list URL follows the site: sort, page, q, nsfw', () => {
    const u = new URL(risuListUrl({ sort: 'trending', page: 2, search: 'elf', nsfw: true }));
    assert.equal(u.origin + u.pathname, 'https://realm.risuai.net/__data.json');
    assert.equal(u.searchParams.get('sort'), 'trending');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('q'), 'elf');
    assert.equal(u.searchParams.get('nsfw'), 'true');
    // "latest" is an empty sort, which must still be sent (no sort = recommended)
    assert.equal(new URL(risuListUrl({ sort: '' })).searchParams.get('sort'), '');
    // recommended has no pages, and a search there falls back to latest
    const rec = new URL(risuListUrl({ sort: 'recommended', page: 1 }));
    assert.equal(rec.searchParams.get('sort'), 'recommended');
    assert.equal(rec.searchParams.has('page'), false);
    assert.equal(new URL(risuListUrl({ sort: 'recommended', search: 'x' })).searchParams.get('sort'), '');
    assert.equal(new URL(risuListUrl({ nsfw: false })).searchParams.has('nsfw'), false);
    assert.equal(risuDownloadUrl('ab-cd'), 'https://realm.risuai.net/api/v1/download/charx-v3/ab-cd?non_commercial=true');
    assert.equal(risuSiteUrl({ sort: 'downloads', search: 'elf', nsfw: false }), 'https://realm.risuai.net/?sort=downloads&q=elf');
});

test('devalue: objects, arrays, shared refs and special values', () => {
    const v = devalueUnflatten([{ a: 1, b: 2, c: 3, d: -1 }, 'x', [3, 3], { n: 4 }, 7]);
    assert.equal(v.a, 'x');
    assert.equal(v.b[0], v.b[1]); // the same object twice
    assert.equal(v.b[0], v.c);
    assert.deepEqual(v.c, { n: 7 });
    assert.equal(v.d, undefined);
    assert.ok(devalueUnflatten([['Date', '2020-01-01T00:00:00.000Z']]) instanceof Date);
});

// A __data.json shaped like RisuRealm's, packed by hand.
function risuData(cards, { page = 1, sort = 'trending' } = {}) {
    const flat = [null];
    const put = v => { flat.push(v); return flat.length - 1; };
    const cardIdx = cards.map(c => {
        const o = {};
        for (const [k, v] of Object.entries(c)) o[k] = Array.isArray(v) ? put(v.map(put)) : put(v);
        return put(o);
    });
    flat[0] = { cards: put(cardIdx), page: put(page), sort: put(sort), nsfw: put(true), mode: put('character'), search: put('') };
    return { type: 'data', nodes: [null, { type: 'data', data: flat, uses: {} }] };
}

test('RisuRealm data is unpacked and normalized', () => {
    const card = {
        name: 'Ivy', desc: 'A vampire maid', download: '266.9k', id: '524c522c-ce32-43b6-ac00-21019562994d', img: 'abc123',
        tags: ['female', 'nsfw', 'OC'], haslore: true, hasEmotion: false, hasAsset: true, authorname: 'aukaru', license: 'CC BY-NC 4.0',
    };
    const json = risuData(Array.from({ length: 30 }, (_, i) => ({ ...card, id: `${card.id.slice(0, -2)}${String(i).padStart(2, '0')}` })));
    assert.equal(unpackSvelteData(json).cards.length, 30);
    const r = normalizeRisuList(json, 1);
    assert.equal(r.items.length, 30);
    assert.equal(r.pages, 2); // a full page: there may be more
    const a = r.items[0];
    assert.equal(a.name, 'Ivy');
    assert.equal(a.avatar, 'https://sv.risuai.xyz/resource/abc123');
    assert.equal(a.downloads, 266900);
    assert.equal(a.nsfw, true);
    assert.deepEqual(a.tags, ['female', 'OC']);
    assert.deepEqual(a.badges, ['lorebook', 'assets']);
    assert.equal(a.creator, 'aukaru');
    assert.equal(a.url, `https://realm.risuai.net/character/${a.id}`);
    // a short page is the last; "recommended" is always one page
    assert.equal(normalizeRisuList(risuData([card], { page: 3 }), 3).pages, 3);
    assert.equal(normalizeRisuList(risuData(Array(30).fill(card), { sort: 'recommended' })).pages, 1);
    // what RisuRealm returns for a page that doesn't exist: no cards, so the list ends there
    const past = normalizeRisuList({ type: 'data', nodes: [null, { type: 'data', data: [{ post: 1 }, { error: 2, data: 3 }, 'Internal Server Error', []] }] }, 4);
    assert.deepEqual([past.items.length, past.pages], [0, 4]);
});

test('counts, file names, sizes', () => {
    assert.equal(parseCount('34.5k'), 34500);
    assert.equal(parseCount('1.2M'), 1200000);
    assert.equal(parseCount('980'), 980);
    assert.equal(parseCount(12), 12);
    assert.equal(parseCount(''), 0);
    assert.equal(dispositionName('attachment; filename="alice.png"'), 'alice.png');
    assert.equal(dispositionName('attachment; filename=bob.json'), 'bob.json');
    assert.equal(dispositionName("attachment; filename*=UTF-8''%E0%B8%81.png"), 'ก.png');
    assert.equal(dispositionName(null), '');
    assert.equal(safeFileName('a/b:c?', 'charx'), 'a b c.charx');
    assert.equal(safeFileName('', 'png'), 'character.png');
    assert.equal(megabytes(82163324), '78 MB');
    assert.equal(megabytes(1.5 * 1024 * 1024), '1.5 MB');
});
