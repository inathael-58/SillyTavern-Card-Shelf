import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
    avatarUrl, cardFromJanitor, cardFromPng, crc32, detectLorebook, findLorebook, hasDefinition, htmlToText,
    idFromLink, listUrl, lorebookName, normalizeList, pngReadText, pngWithCard, routeOrder, routedUrl,
    shortCount, toCharacterBook, toWorldInfo, WI_POSITION,
} from '../lib.js';

// A real 1×1 PNG built by hand, so the chunk code is checked against zlib-made data.
function tinyPng() {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.from([0, 255, 0, 0, 255]);
    return new Uint8Array(Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

test('crc32 matches the PNG reference value', () => {
    assert.equal(crc32(new TextEncoder().encode('IEND')), 0xAE426082);
});

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

test('hidden definitions are recognised', () => {
    assert.equal(hasDefinition({ personality: 'p' }), true);
    assert.equal(hasDefinition({ showdefinition: false, personality: '' }), false);
    assert.equal(hasDefinition({ first_message: 'hi' }), true);
    assert.equal(hasDefinition({}), false);
});

test('JanitorAI character becomes a V2 card', () => {
    const card = cardFromJanitor({
        id: 'c3', name: 'Cara', personality: 'DEF', scenario: 'SCN', first_message: 'Hello',
        first_messages: ['Hello', 'Again'], example_dialogs: 'EX', description: 'Public <b>blurb</b>',
        tags: [{ name: 'Fantasy' }], creator_name: 'kit',
    }, { lorebook: { entries: [{ keys: ['sword'], content: 'A blade' }] } });
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.description, 'DEF');
    assert.equal(card.data.scenario, 'SCN');
    assert.equal(card.data.first_mes, 'Hello');
    assert.deepEqual(card.data.alternate_greetings, ['Again']);
    assert.equal(card.data.mes_example, 'EX');
    assert.match(card.data.creator_notes, /Public blurb/);
    assert.match(card.data.creator_notes, /janitorai\.com\/characters\/c3/);
    assert.deepEqual(card.data.tags, ['Fantasy']);
    assert.equal(card.data.extensions.janitor_browser.id, 'c3');
    assert.equal(card.data.character_book.name, "Cara's Lorebook");
    assert.deepEqual(card.data.character_book.entries[0].keys, ['sword']);
});

test('lorebook inside a character detail is found', () => {
    assert.equal(findLorebook({ lorebook: { entries: [{ content: 'x' }] } }).entries.length, 1);
    const many = findLorebook({ lorebooks: [{ name: 'A', entries: [{ content: '1' }] }, { entries: { 0: { content: '2' } } }] });
    assert.equal(many.name, 'A');
    assert.equal(many.entries.length, 2);
    assert.equal(findLorebook({ lorebook: [] }), null);
    assert.equal(findLorebook({}), null);
});

test('card character_book converts like SillyTavern does', () => {
    const card = { spec: 'chara_card_v2', data: { name: 'Dee', character_book: { name: 'Dee world', entries: [
        { keys: ['a', 'b'], secondary_keys: ['c'], content: 'AC', comment: 'first', insertion_order: 5, enabled: true, constant: true, position: 'after_char', extensions: { depth: 2, probability: 40 } },
        { keys: ['z'], content: 'Z', enabled: false, extensions: { position: 4 } },
    ] } } };
    assert.equal(detectLorebook(card), 'card');
    assert.equal(lorebookName(card), 'Dee world');
    const { data, count } = toWorldInfo(card);
    assert.equal(count, 2);
    const [e0, e1] = [data.entries[0], data.entries[1]];
    assert.deepEqual(e0.key, ['a', 'b']);
    assert.deepEqual(e0.keysecondary, ['c']);
    assert.equal(e0.order, 5);
    assert.equal(e0.constant, true);
    assert.equal(e0.position, WI_POSITION.after);
    assert.equal(e0.depth, 2);
    assert.equal(e0.probability, 40);
    assert.equal(e0.addMemo, true);
    assert.equal(e0.disable, false);
    assert.equal(e1.disable, true);
    assert.equal(e1.position, WI_POSITION.atDepth);
    assert.equal(e1.uid, 1);
});

test('Novel, Agnai, Risu and free-form books convert', () => {
    const novel = { lorebookVersion: 5, entries: [{ keys: ['n'], text: 'N', displayName: 'Nov', enabled: true, contextConfig: { budgetPriority: 7 } }] };
    assert.equal(detectLorebook(novel), 'novel');
    const n = toWorldInfo(novel).data.entries[0];
    assert.equal(n.content, 'N'); assert.equal(n.comment, 'Nov'); assert.equal(n.order, 7);

    const agnai = { kind: 'memory', name: 'Ag', entries: [{ keywords: ['g'], entry: 'G', weight: 3, enabled: false, name: 'x' }] };
    assert.equal(detectLorebook(agnai), 'agnai');
    assert.equal(lorebookName(agnai), 'Ag');
    const g = toWorldInfo(agnai).data.entries[0];
    assert.deepEqual(g.key, ['g']); assert.equal(g.order, 3); assert.equal(g.disable, true);

    const risu = { type: 'risu', data: [{ key: 'r1, r2', secondkey: 's', content: 'R', alwaysActive: true, insertorder: 9, comment: 'c' }] };
    assert.equal(detectLorebook(risu), 'risu');
    const r = toWorldInfo(risu).data.entries[0];
    assert.deepEqual(r.key, ['r1', 'r2']); assert.deepEqual(r.keysecondary, ['s']); assert.equal(r.constant, true); assert.equal(r.order, 9);

    const free = [{ triggers: ['castle', 'keep'], title: 'Castle', value: 'Big', priority: 2 }, { title: 'empty' }];
    assert.equal(detectLorebook(free), 'list');
    const f = toWorldInfo(free);
    assert.equal(f.count, 1);
    assert.deepEqual(f.data.entries[0].key, ['castle', 'keep']);
    assert.deepEqual(f.data.entries[0].triggers, []);
    assert.equal(f.data.entries[0].comment, 'Castle');
});

test('SillyTavern world keeps its own settings', () => {
    const st = { entries: { 7: { uid: 7, key: ['k'], keysecondary: [], content: 'K', order: 50, position: 4, depth: 6, disable: false, triggers: ['normal'], group: 'g', sticky: 2 } } };
    assert.equal(detectLorebook(st), 'sillytavern');
    const e = toWorldInfo(st).data.entries[0];
    assert.equal(e.uid, 0);
    assert.equal(e.position, 4); assert.equal(e.depth, 6); assert.deepEqual(e.triggers, ['normal']);
    assert.equal(e.group, 'g'); assert.equal(e.sticky, 2);
});

test('character_book round trip keeps keys, content and position', () => {
    const book = toCharacterBook({ entries: [{ key: ['q'], content: 'Q', position: 1, order: 4 }] }, 'Book');
    assert.equal(book.name, 'Book');
    assert.equal(book.entries[0].position, 'after_char');
    const back = toWorldInfo({ spec: 'chara_card_v2', data: { name: 'x', character_book: book } }).data.entries[0];
    assert.deepEqual(back.key, ['q']); assert.equal(back.content, 'Q'); assert.equal(back.position, 1); assert.equal(back.order, 4);
});

test('card is written into a PNG and read back (UTF-8 safe)', () => {
    const card = { spec: 'chara_card_v2', data: { name: 'ทดสอบ ✨', description: 'ภาษาไทย' } };
    const png = pngWithCard(tinyPng(), card);
    assert.deepEqual(cardFromPng(png), card);
    // writing again replaces, not duplicates
    const again = pngWithCard(png, { ...card, data: { ...card.data, name: 'B' } });
    assert.equal(Object.keys(pngReadText(again)).filter(k => k === 'chara').length, 1);
    assert.equal(cardFromPng(again).data.name, 'B');
    assert.throws(() => pngReadText(new Uint8Array([1, 2, 3])));
});

test('routes', () => {
    assert.equal(routedUrl('https://a.b/c?d=1', 'st'), '/proxy/https://a.b/c?d=1');
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
