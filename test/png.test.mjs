import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { cardIconPath, cardTextChunks, crc32, pngWithText, utf8ToBase64 } from '../lib.js';

/** A real 1×1 PNG, optionally with tEXt chunks already in it. */
function tinyPng(texts = []) {
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'latin1');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    return new Uint8Array(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        ...texts.map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'))),
        chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

/** [type, data, crcOk] for every chunk. */
function chunks(png) {
    const b = Buffer.from(png);
    const out = [];
    for (let p = 8; p + 12 <= b.length;) {
        const len = b.readUInt32BE(p);
        const type = b.toString('latin1', p + 4, p + 8);
        const data = b.subarray(p + 8, p + 8 + len);
        out.push([type, data, b.readUInt32BE(p + 8 + len) === crc32(b.subarray(p + 4, p + 8 + len))]);
        p += 12 + len;
    }
    return out;
}

test('crc32 and base64 of UTF-8', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    const text = '미라주 (Mirage) — ทดสอบ ❤️';
    assert.equal(Buffer.from(utf8ToBase64(text), 'base64').toString('utf8'), text);
});

test('a PNG card: text chunks before IEND, old card chunks replaced, CRCs right', () => {
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '미라주', first_mes: 'สวัสดี' } };
    const png = pngWithText(tinyPng([['chara', 'old'], ['Comment', 'keep me']]), cardTextChunks(card));
    const list = chunks(png);
    assert.deepEqual(list.map(c => c[0]), ['IHDR', 'tEXt', 'IDAT', 'tEXt', 'tEXt', 'IEND']);
    assert.ok(list.every(c => c[2]), 'every CRC matches');
    const texts = Object.fromEntries(list.filter(c => c[0] === 'tEXt').map(([, d]) => {
        const s = Buffer.from(d).toString('latin1');
        return [s.slice(0, s.indexOf('\0')), s.slice(s.indexOf('\0') + 1)];
    }));
    assert.equal(texts.Comment, 'keep me'); // other text kept, the old chara gone
    for (const k of ['chara', 'ccv3']) assert.deepEqual(JSON.parse(Buffer.from(texts[k], 'base64').toString('utf8')), card);
    assert.throws(() => pngWithText(new Uint8Array([1, 2, 3]), []));
});

test('card icon path: "main" first, Risu\'s embeded:// spelling too', () => {
    const card = icons => ({ data: { assets: icons } });
    assert.equal(cardIconPath(card([
        { type: 'icon', name: 'iconx', uri: 'embeded://assets/icon/image/iconx.png' },
        { type: 'icon', name: 'main', uri: 'embeded://assets/icon/image/main.png' },
    ])), 'assets/icon/image/main.png');
    assert.equal(cardIconPath(card([{ type: 'icon', name: 'x', uri: 'embedded://a/b.webp' }])), 'a/b.webp');
    assert.equal(cardIconPath(card([{ type: 'icon', name: 'x', uri: '__asset:c.png' }])), 'c.png');
    assert.equal(cardIconPath(card([{ type: 'icon', name: 'x', uri: 'https://example.com/a.png' }])), '');
    assert.equal(cardIconPath(card([{ type: 'emotion', name: 'main', uri: 'embeded://e.png' }])), '');
    assert.equal(cardIconPath({}), '');
});
