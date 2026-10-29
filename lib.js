/*
 * Card Shelf — pure helpers (no DOM, no SillyTavern), so they can be tested in Node.
 *
 *  - JanitorAI list / character JSON → one plain shape the browser draws
 *  - JanitorAI character → Character Card V2 (what SillyTavern imports)
 *  - any lorebook (SillyTavern, card character_book, JanitorAI, Novel, Agnai, Risu,
 *    a bare list of entries) → a SillyTavern World Info file
 *  - PNG tEXt chunks: write a card into a picture, read one back out
 */

// ---------------------------------------------------------------- JanitorAI

export const JANITOR_SITE = 'https://janitorai.com';
export const JANITOR_API = 'https://janitorai.com/hampter';
export const JANITOR_AVATARS = 'https://ella.janitorai.com/bot-avatars/';

// Tab → the `sort` value JanitorAI's own site sends. Editable in the settings, in case
// JanitorAI renames one.
export const DEFAULT_SORTS = Object.freeze({
    ranking: 'popular',
    trending: 'trending',
    latest: 'latest',
});

/**
 * URL of one page of characters.
 * @param {{ api?: string, sort?: string, page?: number, search?: string, nsfw?: boolean, tags?: string[] }} o
 */
export function listUrl({ api = JANITOR_API, sort = 'popular', page = 1, search = '', nsfw = true, tags = [] } = {}) {
    const q = new URLSearchParams();
    q.set('page', String(Math.max(1, Math.floor(Number(page) || 1))));
    q.set('mode', nsfw ? 'all' : 'sfw');
    q.set('sort', sort);
    if (search) q.set('search', search);
    for (const t of tags) if (t) q.append('custom_tags', t);
    return `${trimSlash(api)}/characters?${q}`;
}

export const detailUrl = (id, api = JANITOR_API) => `${trimSlash(api)}/characters/${encodeURIComponent(id)}`;
export const pageUrl = id => `${JANITOR_SITE}/characters/${encodeURIComponent(id)}`;

const trimSlash = s => String(s || '').replace(/\/+$/, '');

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

/** The character id inside any JanitorAI / JannyAI link (or a bare id). */
export function idFromLink(text) {
    const m = String(text ?? '').match(UUID_RE);
    return m ? m[0].toLowerCase() : '';
}

/** First value that is not null/undefined/'' among the given keys of obj. */
function pick(obj, ...keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export function avatarUrl(avatar, width = 300) {
    if (!avatar) return '';
    const s = String(avatar);
    if (/^https?:\/\//i.test(s)) return s;
    return `${JANITOR_AVATARS}${s.replace(/^\/+/, '')}${width ? `?width=${width}` : ''}`;
}

function tagNames(raw) {
    const out = [];
    const add = t => {
        const name = typeof t === 'string' ? t : pick(t, 'name', 'slug', 'title');
        const clean = String(name ?? '').trim();
        if (clean && !out.some(x => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
    };
    for (const t of Array.isArray(raw?.tags) ? raw.tags : []) add(t);
    for (const t of Array.isArray(raw?.custom_tags) ? raw.custom_tags : []) add(t);
    return out;
}

/**
 * One character from a list or detail response, in the shape the browser draws.
 * Field names differ between JanitorAI versions, so each one has a few spellings.
 */
export function normalizeCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(pick(raw, 'id', 'character_id', 'uuid') ?? '');
    if (!id) return null;
    const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const creator = raw.creator && typeof raw.creator === 'object' ? raw.creator : {};
    return {
        id,
        name: String(pick(raw, 'name', 'chat_name', 'title') ?? 'Unnamed'),
        avatar: avatarUrl(pick(raw, 'avatar', 'avatar_url', 'image')),
        tags: tagNames(raw),
        nsfw: Boolean(pick(raw, 'is_nsfw', 'nsfw')),
        chats: num(pick(raw, 'total_chat', 'chat_count', 'chats') ?? stats.chat ?? stats.chats),
        messages: num(pick(raw, 'total_message', 'message_count', 'messages') ?? stats.message ?? stats.messages),
        creator: String(pick(raw, 'creator_name', 'creator_username', 'author') ?? pick(creator, 'name', 'username') ?? ''),
        createdAt: String(pick(raw, 'created_at', 'createdAt') ?? ''),
        description: htmlToText(pick(raw, 'description', 'bio', 'tagline') ?? ''),
        url: pageUrl(id),
    };
}

/** A list response → { items, total, page, pages }. */
export function normalizeList(json, page = 1) {
    const arr = Array.isArray(json) ? json
        : (pick(json, 'data', 'characters', 'results', 'items', 'hits') ?? []);
    const items = (Array.isArray(arr) ? arr : []).map(normalizeCharacter).filter(Boolean);
    const total = num(pick(json, 'total', 'count', 'totalHits', 'estimatedTotalHits'));
    const size = num(pick(json, 'size', 'page_size', 'limit', 'per_page')) || items.length || 1;
    const pages = total ? Math.ceil(total / size) : 0;
    return { items, total, page: num(pick(json, 'page')) || page, pages };
}

/** Does a character detail carry its definition? (creators can hide it) */
export function hasDefinition(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (raw.showdefinition === false || raw.show_definition === false) {
        // Hidden on the site, but some responses still include it for the owner.
        return Boolean(String(raw.personality ?? '').trim());
    }
    return Boolean(String(pick(raw, 'personality', 'definition') ?? '').trim()
        || String(pick(raw, 'first_message', 'first_mes') ?? '').trim());
}

/**
 * JanitorAI character detail → Character Card V2.
 * JanitorAI's "personality" box is the whole definition, which is what SillyTavern
 * calls the description; the public blurb becomes the creator notes.
 */
export function cardFromJanitor(raw, { lorebook = null } = {}) {
    const c = normalizeCharacter(raw) ?? { id: '', name: 'Unnamed', tags: [], creator: '', url: '' };
    const firsts = [];
    const pushFirst = v => {
        const s = String(v ?? '').trim();
        if (s && !firsts.includes(s)) firsts.push(s);
    };
    pushFirst(pick(raw, 'first_message', 'first_mes', 'greeting'));
    for (const g of Array.isArray(raw?.first_messages) ? raw.first_messages : []) pushFirst(typeof g === 'string' ? g : pick(g, 'message', 'text', 'content'));
    for (const g of Array.isArray(raw?.alternate_greetings) ? raw.alternate_greetings : []) pushFirst(g);

    const notes = [htmlToText(pick(raw, 'description', 'bio') ?? '')];
    if (c.url) notes.push(`Source: ${c.url}`);

    const data = {
        name: c.name,
        description: String(pick(raw, 'personality', 'definition') ?? ''),
        personality: '',
        scenario: String(pick(raw, 'scenario') ?? ''),
        first_mes: firsts[0] ?? '',
        mes_example: String(pick(raw, 'example_dialogs', 'example_dialog', 'mes_example') ?? ''),
        creator_notes: notes.filter(Boolean).join('\n\n'),
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: firsts.slice(1),
        tags: c.tags,
        creator: c.creator,
        character_version: '',
        extensions: {
            card_shelf: { source: 'janitorai', id: c.id, url: c.url },
        },
    };
    const book = lorebook ? toCharacterBook(lorebook, `${c.name}'s Lorebook`) : null;
    if (book && book.entries.length) data.character_book = book;
    return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/** A lorebook that rides along in a JanitorAI character detail, if there is one. */
export function findLorebook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    for (const k of ['character_book', 'lorebook', 'lore_book', 'world_info', 'lorebooks', 'scripts']) {
        const v = raw[k];
        if (!v) continue;
        if (Array.isArray(v)) {
            // Either a list of entries, or a list of books (take them all as one).
            if (!v.length) continue;
            if (v.every(b => b && typeof b === 'object' && (Array.isArray(b.entries) || isPlainMap(b.entries)))) {
                return { name: pick(v[0], 'name', 'title'), entries: v.flatMap(b => entryList(b.entries)) };
            }
            return { entries: v };
        }
        if (typeof v === 'object' && (Array.isArray(v.entries) || isPlainMap(v.entries) || Array.isArray(v.data))) return v;
    }
    return null;
}

// ---------------------------------------------------------------- text

export function htmlToText(html) {
    let t = String(html ?? '');
    if (!/[<&]/.test(t)) return t.trim();
    t = t.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n')
        .replace(/<\s*(p|div|li|h[1-6]|blockquote)(\s[^>]*)?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    t = t.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, e, dec, hex) => {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        return { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e.toLowerCase()] ?? m;
    });
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, m => (m.length > 2 ? '\n\n' : m)).trim();
}

export function shortCount(n) {
    const v = num(n);
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(v));
}

// ---------------------------------------------------------------- lorebooks
//
// SillyTavern keeps a World Info file as { entries: { [uid]: entry } }. The defaults below
// mirror SillyTavern's newWorldInfoEntryTemplate, so a converted entry looks exactly like
// one made in the editor.

export const WI_POSITION = Object.freeze({ before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 });
export const WI_LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });

export const ENTRY_TEMPLATE = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '',
    constant: false, vectorized: false, selective: true, selectiveLogic: WI_LOGIC.AND_ANY,
    addMemo: false, order: 100, position: WI_POSITION.before, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4,
    outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
});

const GEN_TYPES = new Set(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);
const isPlainMap = v => v && typeof v === 'object' && !Array.isArray(v);
const entryList = e => Array.isArray(e) ? e : isPlainMap(e) ? Object.values(e) : [];

/** "a, b ,c" or ["a", " b"] → ["a", "b"] */
export function keyList(v) {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map(x => String(x ?? '').trim()).filter(Boolean);
}

const bool = (v, d) => v === undefined || v === null ? d : Boolean(v);
const numOr = (v, d) => {
    const n = Number(v);
    return v === undefined || v === null || v === '' || !Number.isFinite(n) ? d : n;
};

/** Text position names used by cards and other apps → SillyTavern position number. */
function positionOf(e) {
    const ext = e.extensions ?? {};
    if (Number.isFinite(Number(ext.position)) && ext.position !== null && ext.position !== '') return Number(ext.position);
    const p = e.position;
    if (typeof p === 'number' && Number.isFinite(p)) return p;
    const s = String(p ?? '').toLowerCase().replace(/[\s-]/g, '_');
    if (!s) return WI_POSITION.before;
    if (/^(before_char|before|top|start)$/.test(s)) return WI_POSITION.before;
    if (/^(after_char|after|bottom|end)$/.test(s)) return WI_POSITION.after;
    if (/an_?top|authors?_note_top/.test(s)) return WI_POSITION.ANTop;
    if (/an_?bottom|authors?_note_bottom/.test(s)) return WI_POSITION.ANBottom;
    if (/depth/.test(s)) return WI_POSITION.atDepth;
    if (/em_?top|example.*top/.test(s)) return WI_POSITION.EMTop;
    if (/em_?bottom|example.*bottom/.test(s)) return WI_POSITION.EMBottom;
    return WI_POSITION.before;
}

/**
 * One entry from any app → a SillyTavern entry. Knows the Card V2/V3 spelling
 * (keys, secondary_keys, insertion_order, enabled, extensions.*), SillyTavern's own
 * (key, keysecondary, order, disable), Novel (text, displayName), Agnai (keywords,
 * entry, weight), Risu (key "a,b", secondkey, insertorder, alwaysActive) and the
 * common free-form names (triggers, keywords, title, value, priority...).
 */
export function convertEntry(e, index) {
    const ext = isPlainMap(e?.extensions) ? e.extensions : {};
    let keys = keyList(pick(e, 'key', 'keys', 'keywords', 'trigger_words', 'activation_keys'));
    if (!keys.length && e?.triggers && !(Array.isArray(e.triggers) && e.triggers.every(x => GEN_TYPES.has(x)))) keys = keyList(e.triggers);
    const secondary = keyList(pick(e, 'keysecondary', 'secondary_keys', 'secondkey', 'secondaryKeys', 'secondary_keywords'));
    const comment = String(pick(e, 'comment', 'name', 'displayName', 'title', 'memo', 'label') ?? '');
    const content = String(pick(e, 'content', 'text', 'entry', 'value', 'description', 'body') ?? '');
    const constant = bool(pick(e, 'constant', 'alwaysActive', 'always_active', 'always_on'), false);
    const disabled = e?.disable !== undefined ? Boolean(e.disable)
        : e?.enabled !== undefined ? !e.enabled
            : e?.disabled !== undefined ? Boolean(e.disabled) : false;
    const order = numOr(pick(e, 'order', 'insertion_order', 'insertorder', 'weight', 'priority')
        ?? e?.contextConfig?.budgetPriority, 100);
    const probability = numOr(pick(ext, 'probability') ?? pick(e, 'probability', 'activationPercent'), 100);

    const out = {
        ...structuredCloneSafe(ENTRY_TEMPLATE),
        uid: index,
        key: keys,
        keysecondary: secondary,
        comment,
        content,
        constant,
        selective: bool(e?.selective, true),
        selectiveLogic: numOr(pick(e, 'selectiveLogic') ?? ext.selectiveLogic, WI_LOGIC.AND_ANY),
        addMemo: bool(e?.addMemo, Boolean(comment)),
        order,
        position: positionOf(e ?? {}),
        disable: disabled,
        displayIndex: numOr(e?.displayIndex ?? ext.display_index, index),
        probability,
        useProbability: bool(e?.useProbability ?? ext.useProbability, true),
        depth: numOr(e?.depth ?? ext.depth, ENTRY_TEMPLATE.depth),
        excludeRecursion: bool(e?.excludeRecursion ?? ext.exclude_recursion, false),
        preventRecursion: bool(e?.preventRecursion ?? ext.prevent_recursion, false),
        delayUntilRecursion: e?.delayUntilRecursion ?? ext.delay_until_recursion ?? 0,
        outletName: String(e?.outletName ?? ext.outlet_name ?? ''),
        group: String(e?.group ?? ext.group ?? ''),
        groupOverride: bool(e?.groupOverride ?? ext.group_override, false),
        groupWeight: numOr(e?.groupWeight ?? ext.group_weight, 100),
        scanDepth: e?.scanDepth ?? ext.scan_depth ?? null,
        caseSensitive: e?.caseSensitive ?? e?.case_sensitive ?? ext.case_sensitive ?? null,
        matchWholeWords: e?.matchWholeWords ?? ext.match_whole_words ?? null,
        useGroupScoring: e?.useGroupScoring ?? ext.use_group_scoring ?? null,
        automationId: String(e?.automationId ?? ext.automation_id ?? ''),
        role: numOr(e?.role ?? ext.role, 0),
        vectorized: bool(e?.vectorized ?? ext.vectorized, false),
        sticky: e?.sticky ?? ext.sticky ?? null,
        cooldown: e?.cooldown ?? ext.cooldown ?? null,
        delay: e?.delay ?? ext.delay ?? null,
        ignoreBudget: bool(e?.ignoreBudget ?? ext.ignore_budget, false),
        // `triggers` is SillyTavern's generation-type filter; only keep it when every value
        // is one of those type names, so a free-form book's keyword list never lands here.
        triggers: [e?.triggers, ext.triggers].find(t => Array.isArray(t) && t.every(x => GEN_TYPES.has(x))) ?? [],
    };
    for (const k of ['matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
        'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes']) {
        const snake = k.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
        out[k] = bool(e?.[k] ?? ext[snake], false);
    }
    return out;
}

function structuredCloneSafe(o) {
    return JSON.parse(JSON.stringify(o));
}

/** Which app a lorebook came from (for the message shown after converting). */
export function detectLorebook(input) {
    const j = input;
    if (!j || typeof j !== 'object') return '';
    if (Array.isArray(j)) return 'list';
    if (j.spec && isPlainMap(j.data)) return j.data.character_book ? 'card' : 'card-no-book';
    if (isPlainMap(j.data) && j.data.character_book) return 'card';
    if (j.character_book && !j.entries) return 'card';
    if (j.lorebookVersion !== undefined) return 'novel';
    if (j.kind === 'memory') return 'agnai';
    if (j.type === 'risu' || (Array.isArray(j.data) && j.data.some(e => e && 'secondkey' in e))) return 'risu';
    if (isPlainMap(j.entries) && entryList(j.entries).some(e => e && ('key' in e || 'uid' in e))) return 'sillytavern';
    if (Array.isArray(j.entries)) return 'character_book';
    if (isPlainMap(j.entries)) return 'character_book';
    const nested = findLorebook(j);
    if (nested) return 'janitor';
    return '';
}

/** The entries of any lorebook shape, as a plain list. */
function sourceEntries(input) {
    const kind = detectLorebook(input);
    switch (kind) {
        case 'list': return input;
        case 'card': return entryList((input.data?.character_book ?? input.character_book)?.entries);
        case 'risu': return Array.isArray(input.data) ? input.data : [];
        case 'janitor': return entryList(findLorebook(input)?.entries ?? findLorebook(input)?.data);
        case 'sillytavern':
        case 'novel':
        case 'agnai':
        case 'character_book': return entryList(input.entries);
        default: return [];
    }
}

/** Book name the source suggests, if any. */
export function lorebookName(input, fallback = '') {
    const j = input ?? {};
    const name = pick(j.data?.character_book ?? {}, 'name')
        ?? pick(j.character_book ?? {}, 'name')
        ?? (j.spec ? undefined : pick(j, 'name', 'title'))
        ?? (j.data?.name ? `${j.data.name}'s Lorebook` : undefined)
        ?? pick(findLorebook(j) ?? {}, 'name', 'title');
    return String(name ?? fallback).trim() || fallback;
}

/**
 * Any lorebook → SillyTavern World Info data ({ entries }).
 * Entries without content are dropped. Returns { kind, data, count }.
 */
export function toWorldInfo(input) {
    const kind = detectLorebook(input);
    const list = sourceEntries(input).filter(e => e && typeof e === 'object');
    const entries = {};
    let i = 0;
    for (const e of list) {
        const conv = convertEntry(e, i);
        if (!conv.content.trim() && !conv.key.length) continue;
        conv.uid = i;
        conv.displayIndex = i;
        entries[i] = conv;
        i++;
    }
    return { kind, data: { entries }, count: i };
}

/** Any lorebook → Card V2 character_book (to embed into a card). */
export function toCharacterBook(input, name = '') {
    const { data } = toWorldInfo(input);
    const entries = Object.values(data.entries).map((e, id) => ({
        id,
        keys: e.key,
        secondary_keys: e.keysecondary,
        comment: e.comment,
        content: e.content,
        constant: e.constant,
        selective: e.selective,
        insertion_order: e.order,
        enabled: !e.disable,
        position: e.position === WI_POSITION.after ? 'after_char' : 'before_char',
        use_regex: true,
        extensions: {
            position: e.position, depth: e.depth, probability: e.probability, useProbability: e.useProbability,
            selectiveLogic: e.selectiveLogic, display_index: id, role: e.role, group: e.group,
            exclude_recursion: e.excludeRecursion, prevent_recursion: e.preventRecursion,
            case_sensitive: e.caseSensitive, match_whole_words: e.matchWholeWords,
        },
    }));
    return { name: lorebookName(input, name), entries, extensions: {} };
}

// ---------------------------------------------------------------- PNG text chunks

let CRC_TABLE = null;
function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
}

export function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const latin1 = s => Uint8Array.from(String(s), ch => ch.charCodeAt(0) & 0xFF);
const fromLatin1 = b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

function isPng(b) {
    return b && b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);
}

/** Split a PNG into chunks [{ type, data }]. */
export function pngChunks(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isPng(b)) throw new Error('Not a PNG file');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = [];
    let p = 8;
    while (p + 8 <= b.length) {
        const len = dv.getUint32(p);
        const type = fromLatin1(b.subarray(p + 4, p + 8));
        const data = b.subarray(p + 8, p + 8 + len);
        out.push({ type, data });
        p += 12 + len;
        if (type === 'IEND') break;
    }
    return out;
}

function joinChunks(chunks) {
    const size = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
    const out = new Uint8Array(size);
    out.set(PNG_SIG, 0);
    const dv = new DataView(out.buffer);
    let p = 8;
    for (const c of chunks) {
        const typeBytes = latin1(c.type);
        dv.setUint32(p, c.data.length);
        out.set(typeBytes, p + 4);
        out.set(c.data, p + 8);
        const crcIn = new Uint8Array(4 + c.data.length);
        crcIn.set(typeBytes, 0);
        crcIn.set(c.data, 4);
        dv.setUint32(p + 8 + c.data.length, crc32(crcIn));
        p += 12 + c.data.length;
    }
    return out;
}

/** tEXt chunks of a PNG as { keyword: text }. */
export function pngReadText(bytes) {
    const out = {};
    for (const c of pngChunks(bytes)) {
        if (c.type !== 'tEXt') continue;
        const zero = c.data.indexOf(0);
        if (zero < 0) continue;
        out[fromLatin1(c.data.subarray(0, zero))] = fromLatin1(c.data.subarray(zero + 1));
    }
    return out;
}

/** Put text chunks into a PNG (replacing ones with the same keyword) just before IEND. */
export function pngWriteText(bytes, entries) {
    const keys = Object.keys(entries).map(k => k.toLowerCase());
    const chunks = pngChunks(bytes).filter(c => {
        if (c.type !== 'tEXt') return true;
        const zero = c.data.indexOf(0);
        return !keys.includes(fromLatin1(c.data.subarray(0, Math.max(0, zero))).toLowerCase());
    });
    const end = chunks.findIndex(c => c.type === 'IEND');
    const add = Object.entries(entries).map(([k, v]) => {
        const kb = latin1(k);
        const vb = latin1(v);
        const data = new Uint8Array(kb.length + 1 + vb.length);
        data.set(kb, 0);
        data.set(vb, kb.length + 1);
        return { type: 'tEXt', data };
    });
    chunks.splice(end < 0 ? chunks.length : end, 0, ...add);
    return joinChunks(chunks);
}

// UTF-8 ⇄ base64, in both Node and the browser.
export function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function base64ToUtf8(b64) {
    const bin = atob(String(b64).trim());
    return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}

/** A card JSON written into a PNG the way SillyTavern reads it (chara, base64). */
export function pngWithCard(pngBytes, card) {
    return pngWriteText(pngBytes, { chara: utf8ToBase64(JSON.stringify(card)) });
}

/** The card inside a PNG (V3 ccv3 first, like SillyTavern), or null. */
export function cardFromPng(pngBytes) {
    const t = pngReadText(pngBytes);
    const key = Object.keys(t).find(k => k.toLowerCase() === 'ccv3') ?? Object.keys(t).find(k => k.toLowerCase() === 'chara');
    if (!key) return null;
    try { return JSON.parse(base64ToUtf8(t[key])); } catch { return null; }
}

// ---------------------------------------------------------------- fetching

/**
 * Build the URL a request should go through. route: st | direct | custom.
 * SillyTavern's /proxy/ reads the target from the path, so an unencoded "?page=2&sort=…"
 * would be taken as the proxy's own query and dropped; the whole URL is encoded instead.
 */
export function routedUrl(url, route, customTemplate = '') {
    switch (route) {
        case 'st': return `/proxy/${encodeURIComponent(url)}`;
        case 'custom': {
            const tpl = String(customTemplate || '').trim();
            if (!tpl) return '';
            return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url);
        }
        default: return url;
    }
}

/** Routes to try, in order, for a setting value. */
export function routeOrder(setting, customTemplate = '') {
    const custom = String(customTemplate || '').trim() ? ['custom'] : [];
    switch (setting) {
        case 'st': return ['st'];
        case 'direct': return ['direct'];
        case 'custom': return custom.length ? custom : ['st'];
        default: return ['st', ...custom, 'direct'];
    }
}
