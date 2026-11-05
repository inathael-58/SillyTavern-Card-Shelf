import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chubListUrl, chubPageUrl, dispositionName, megabytes, normalizeChubList, normalizeRisuList,
    parseCount, risuDownloadUrl, risuListUrl, risuSiteUrl, safeFileName, SOURCE_IDS, SOURCES,
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

/** The query string inside a RisuRealm hub list URL, as key → value. */
function risuQuery(url) {
    const u = new URL(url);
    assert.equal(u.origin, 'https://sv.risuai.xyz');
    assert.ok(u.pathname.startsWith('/realm/'));
    assert.equal(u.searchParams.get('cache'), '30');
    const raw = decodeURIComponent(u.pathname.slice('/realm/'.length));
    return Object.fromEntries(raw.split('&&').map(kv => kv.split('==')));
}

test('RisuRealm list URL is the hub query the RisuAI app sends', () => {
    // pages start at 0 on the hub; ours start at 1
    assert.deepEqual(risuQuery(risuListUrl({ sort: 'trending', page: 2, search: 'elf', nsfw: true })),
        { search: 'elf __shared', page: '1', nsfw: 'true', sort: 'trending', web: 'web' });
    assert.deepEqual(risuQuery(risuListUrl({ sort: 'downloads', nsfw: false })),
        { search: ' __shared', page: '0', nsfw: 'false', sort: 'downloads', web: 'web' });
    // "latest" is an empty sort; "recommended" is page 0 only, and a search there falls back to latest
    assert.equal(risuQuery(risuListUrl({ sort: '' })).sort, '');
    assert.equal(risuQuery(risuListUrl({ sort: 'recommended', page: 3 })).page, '0');
    assert.equal(risuQuery(risuListUrl({ sort: 'recommended', search: 'x' })).sort, '');
    // characters that would break the path are encoded
    assert.equal(risuQuery(risuListUrl({ search: 'a/b?c&&d' })).search, 'a/b?c');
    assert.equal(risuDownloadUrl('ab-cd'), 'https://realm.risuai.net/api/v1/download/dynamic/ab-cd?cors=true');
    assert.equal(risuSiteUrl({ sort: 'downloads', search: 'elf', nsfw: false }), 'https://realm.risuai.net/?sort=downloads&q=elf');
    assert.equal(SOURCES.risu.cors, true);
    assert.equal(SOURCES.chub.cors, true);
    assert.ok(!SOURCES.janitor.cors);
});

test('RisuRealm hub list is normalized', () => {
    const card = {
        name: 'Ivy', desc: 'A vampire maid', download: '266.9k', id: '524c522c-ce32-43b6-ac00-21019562994d', img: 'abc123',
        tags: ['female', 'nsfw', 'OC'], haslore: true, hasEmotion: false, hasAsset: true, authorname: 'aukaru', license: 'CC BY-NC 4.0',
    };
    const full = Array.from({ length: 30 }, (_, i) => ({ ...card, id: `${card.id.slice(0, -2)}${String(i).padStart(2, '0')}` }));
    const r = normalizeRisuList({ cards: full, additionalHTML: '' }, 1, { sort: 'trending' });
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
    assert.equal(normalizeRisuList(full).items.length, 30); // a bare array works too
    // a short page is the last; "recommended" is one page unless it is a search
    assert.equal(normalizeRisuList({ cards: [card] }, 3).pages, 3);
    assert.equal(normalizeRisuList({ cards: full }, 1, { sort: 'recommended' }).pages, 1);
    assert.equal(normalizeRisuList({ cards: full }, 1, { sort: 'recommended', search: 'x' }).pages, 2);
    assert.equal(normalizeRisuList('Invaild Arguments, pages').items.length, 0);
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
