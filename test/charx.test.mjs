import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
    charxExtras, readRisum, risuLoreToBook, risuRegexToST, usesRisuSyntax, zipEntries, zipLayout, zipOnly, zipRead,
} from '../lib.js';

/** A small zip: [name, content (string or bytes), deflate?] … */
function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text, deflate] of files) {
        const nameBytes = Buffer.from(name);
        const raw = Buffer.from(text);
        const data = deflate ? deflateRawSync(raw) : raw;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** A .risum holding `module`, packed the way RisuAI does (RPack encode = inverse of decode). */
function makeRisum(module, decodeTable) {
    const enc = new Uint8Array(256);
    decodeTable.forEach((plain, coded) => { enc[plain] = coded; });
    const json = Buffer.from(JSON.stringify({ type: 'risuModule', module }));
    const out = new Uint8Array(6 + json.length);
    out.set([111, 0]);
    new DataView(out.buffer).setUint32(2, json.length, true);
    out.set(json.map(b => enc[b]), 6);
    return out;
}

const DECODE = Uint8Array.from(atob('LPeEi8ll+7afrrMDLQFpdB/ko+zuXDQhk0oPauJiAp4inP08/HHHxq1ZZwVwbYpEEvokhl+v0XpHzv5QY91RBm8Y4FKoCZ1Wc0y4U2zDoA4Zzz4NfgcyaEbqSPmZLqukSSBeVTU4DLzTsVgWeSgKGuHyzcQ526K6YHJ2fZXvf8jA3jeUv7UUgZIlRazn9WanKzZawRPjSzrojYMbfCewmkLrh6rcVI54JtJXKdS3+C+PiXXwQXfCHv/YFRHlBJcX8zHQmwDXyrRPKjvZsmvaXaE/MGG9kT1O5t++TYKMHSMQmGT0hTN7kEO7qYjx1qUc9sxuuVsLlu3V6cXLCKaAQA=='), c => c.charCodeAt(0));

test('zip: entries are listed and read, stored or deflated', async () => {
    const zip = makeZip([['card.json', '{"spec":"chara_card_v3"}', false], ['notes/long.txt', 'hello '.repeat(200), true]]);
    assert.equal(zipLayout(zip).start, 0);
    assert.deepEqual(zipEntries(zip).map(e => e.name), ['card.json', 'notes/long.txt']);
    assert.equal(new TextDecoder().decode(await zipRead(zip, 'card.json')), '{"spec":"chara_card_v3"}');
    assert.equal(new TextDecoder().decode(await zipRead(zip, 'notes/long.txt')), 'hello '.repeat(200));
    assert.equal(await zipRead(zip, 'missing'), null);
    assert.equal(zipLayout(new Uint8Array([1, 2, 3])), null);
});

test('zip behind a JPEG: found, read, and cut out whole', async () => {
    const zip = makeZip([['card.json', '{"a":1}', true]]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(500).fill(7), 0xff, 0xd9]);
    const both = new Uint8Array([...jpeg, ...zip]);
    assert.equal(zipLayout(both).start, jpeg.length);
    assert.equal(new TextDecoder().decode(await zipRead(both, 'card.json')), '{"a":1}');
    const only = zipOnly(both);
    assert.deepEqual([...only], [...zip]);
    assert.equal(zipOnly(zip), zip); // nothing in front: unchanged
});

test('.risum module is decoded; charx extras come from it', async () => {
    const module = { name: 'm', regex: [{ comment: 'x', in: 'a', out: 'b', type: 'editdisplay' }], lorebook: [{ key: 'k', content: 'c' }], trigger: [{}, {}] };
    const risum = makeRisum(module, DECODE);
    assert.deepEqual(readRisum(risum).regex, module.regex);
    assert.equal(readRisum(new Uint8Array([1, 2, 3, 4, 5, 6])), null);
    const x = await charxExtras(makeZip([['card.json', '{}', true], ['module.risum', Buffer.from(risum), true]]));
    assert.equal(x.regex.length, 1);
    assert.equal(x.lorebook.length, 1);
    assert.equal(x.triggers, 2);
    assert.deepEqual(await charxExtras(makeZip([['card.json', '{}', false]])), { regex: [], lorebook: [], triggers: 0 });
});

test('Risu regex → SillyTavern regex', () => {
    const st = risuRegexToST([
        { comment: '--- section ---', type: 'disabled', in: '', out: '' },
        { comment: 'input', type: 'editinput', in: '/sum', out: 'Summarize' },
        { comment: 'output', type: 'editoutput', in: 'a(b)', out: '$1', ableFlag: true, flag: 'gi<order 2>' },
        { comment: 'prompt', type: 'editprocess', in: 'x', out: 'y' },
        { comment: 'display', type: 'editdisplay', in: 'line1\nline2', out: '<b>$&</b>' },
        { comment: 'off', type: 'disabled', in: 'q', out: '' },
        { comment: 'broken', type: 'editdisplay', in: '(', out: '' },
    ]);
    assert.deepEqual(st.map(s => s.scriptName), ['input', 'output', 'prompt', 'display', 'off']);
    const [input, output, prompt, display, off] = st;
    assert.deepEqual([input.placement, input.findRegex, input.disabled], [[1], '//sum/g', false]);
    assert.deepEqual([output.placement, output.findRegex, output.replaceString], [[2], '/a(b)/gi', '$1']);
    assert.deepEqual([prompt.placement, prompt.promptOnly, prompt.markdownOnly], [[1, 2], true, false]);
    assert.deepEqual([display.placement, display.markdownOnly, display.findRegex], [[1, 2], true, '/line1\\nline2/g']);
    assert.equal(off.disabled, true);
    assert.equal(new Set(st.map(s => s.id)).size, st.length);
    // SillyTavern's own parser reads them back to the same regex
    const regexFromString = input => { const m = input.match(/(\/?)(.+)\1([a-z]*)/i); return new RegExp(m[2], m[3]); };
    assert.equal(regexFromString(input.findRegex).source, new RegExp('/sum').source);
    assert.equal(regexFromString(display.findRegex).source, new RegExp('line1\nline2').source);
    assert.deepEqual(risuRegexToST(null), []);
});

test('Risu lorebook → character_book; Risu syntax is spotted', () => {
    const book = risuLoreToBook([
        { key: 'castle, king', secondkey: 'night', content: 'The castle…', comment: 'Castle', insertorder: 5, selective: true },
        { key: '', content: 'Always', alwaysActive: true },
        { mode: 'folder', comment: 'Folder', content: '' },
    ], 'Tower');
    assert.equal(book.name, 'Tower');
    assert.equal(book.entries.length, 2);
    assert.deepEqual(book.entries[0].keys, ['castle', 'king']);
    assert.deepEqual(book.entries[0].secondary_keys, ['night']);
    assert.equal(book.entries[0].insertion_order, 5);
    assert.equal(book.entries[0].selective, true);
    assert.equal(book.entries[1].constant, true);
    assert.equal(usesRisuSyntax('{{#when::lang::vis::0}}Hello{{/when}}'), true);
    assert.equal(usesRisuSyntax('{{? 1+1}}'), true);
    assert.equal(usesRisuSyntax('Hello {{user}} and {{char}}'), false);
});
