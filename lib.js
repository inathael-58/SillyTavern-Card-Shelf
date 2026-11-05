/*
 * Card Shelf — pure helpers (no DOM, no SillyTavern), so they can be tested in Node.
 *
 *  - JanitorAI, Chub and RisuRealm list JSON → one plain shape the list tabs draw
 *  - SOURCES: what each list tab shows, where it reads, how its bots are imported
 *  - which way a request goes (SillyTavern's proxy, your proxy, direct)
 *  - where Datacat's window sits inside the Card Shelf window
 */

// ---------------------------------------------------------------- JanitorAI

export const JANITOR_SITE = 'https://janitorai.com';
export const JANITOR_API = 'https://janitorai.com/hampter';
export const JANITOR_AVATARS = 'https://ella.janitorai.com/bot-avatars/';

// Tab → the `sort` value sent to JanitorAI. The names follow the site's own home-page
// segments (janitorai.com/?segment=trending24 …). Editable in the settings, in case
// JanitorAI renames one.
export const DEFAULT_SORTS = Object.freeze({
    trending24: 'trending24',
    trending: 'trending',
    popular: 'popular',
    latest: 'latest',
});
const SEGMENTS = new Set(['trending24', 'trending', 'popular']);

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

/**
 * JanitorAI's own page for a tab, to open in a new window: the home-page segment
 * (?segment=trending24, trending, popular), or the search page for a search or another sort.
 */
export function siteUrl({ sort = 'popular', search = '', nsfw = true } = {}) {
    if (!search && SEGMENTS.has(sort)) return `${JANITOR_SITE}/?segment=${encodeURIComponent(sort)}`;
    const q = new URLSearchParams({ mode: nsfw ? 'all' : 'sfw', sort, page: '1' });
    if (search) q.set('search', search);
    return `${JANITOR_SITE}/search?${q}`;
}

// ---------------------------------------------------------------- Chub

export const CHUB_SITE = 'https://chub.ai';
export const CHUB_API = 'https://gateway.chub.ai';
export const CHUB_AVATARS = 'https://avatars.charhub.io/avatars/';

// Tab → Chub's `sort` value. Editable in the settings.
export const CHUB_SORTS = Object.freeze({
    trending: 'trending_downloads',
    downloads: 'download_count',
    stars: 'star_count',
    latest: 'id',
});

export function chubListUrl({ api = CHUB_API, sort = CHUB_SORTS.trending, page = 1, search = '', nsfw = true, size = 40 } = {}) {
    const q = new URLSearchParams({
        search: search || '',
        first: String(size),
        page: String(Math.max(1, Math.floor(Number(page) || 1))),
        namespace: 'characters',
        sort,
        asc: 'false',
        nsfw: nsfw ? 'true' : 'false',
        nsfl: 'false',
        include_forks: 'true',
    });
    return `${trimSlash(api)}/search?${q}`;
}

export const chubPageUrl = fullPath => `${CHUB_SITE}/characters/${String(fullPath).split('/').map(encodeURIComponent).join('/')}`;

export function chubSiteUrl({ sort = CHUB_SORTS.trending, search = '', nsfw = true } = {}) {
    const q = new URLSearchParams({ search: search || '', sort, nsfw: nsfw ? 'true' : 'false' });
    return `${CHUB_SITE}/search?${q}`;
}

/** One Chub search node → the shape the list draws. */
export function normalizeChubCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const fullPath = String(pick(raw, 'fullPath', 'full_path', 'path') ?? '');
    const id = String(pick(raw, 'id', 'project_id') ?? fullPath);
    if (!id || !fullPath) return null;
    const topics = Array.isArray(raw.topics) ? raw.topics : Array.isArray(raw.tags) ? raw.tags : [];
    const tags = tagNames({ tags: topics });
    const avatar = pick(raw, 'avatar_url', 'avatarUrl', 'max_res_url') ?? `${CHUB_AVATARS}${fullPath}/avatar.webp`;
    return {
        id,
        name: String(pick(raw, 'name', 'title') ?? 'Unnamed'),
        avatar: String(avatar),
        tags: tags.filter(t => !/^nsfw$/i.test(t)),
        nsfw: Boolean(pick(raw, 'nsfw', 'is_nsfw', 'nsfw_image')) || tags.some(t => /^nsfw$/i.test(t)),
        chats: num(pick(raw, 'nChats', 'n_chats', 'chats')),
        messages: num(pick(raw, 'nMessages', 'n_messages', 'messages')),
        downloads: num(pick(raw, 'downloadCount', 'download_count', 'nDownloads')),
        stars: num(pick(raw, 'starCount', 'star_count', 'n_favorites')),
        creator: fullPath.split('/')[0] || '',
        createdAt: String(pick(raw, 'createdAt', 'created_at') ?? ''),
        description: htmlToText(pick(raw, 'tagline', 'description') ?? ''),
        url: chubPageUrl(fullPath),
        badges: [],
    };
}

export function normalizeChubList(json, page = 1) {
    const box = json?.data && !Array.isArray(json.data) ? json.data : json;
    const arr = Array.isArray(box) ? box : (pick(box, 'nodes', 'characters', 'results', 'items') ?? (Array.isArray(json?.data) ? json.data : []));
    const items = (Array.isArray(arr) ? arr : []).map(normalizeChubCharacter).filter(Boolean);
    const total = num(pick(box, 'count', 'total', 'totalCount'));
    const size = num(pick(box, 'first', 'size')) || items.length || 1;
    return { items, total, page, pages: total ? Math.ceil(total / size) : 0 };
}

// ---------------------------------------------------------------- RisuRealm

export const RISU_SITE = 'https://realm.risuai.net';
export const RISU_RESOURCE = 'https://sv.risuai.xyz/resource/';
const RISU_PAGE_SIZE = 30;

// Tab → RisuRealm's `sort` value ('' is the site's own "Latest"). "recommended" is one
// page only on the site, so that tab doesn't scroll for more.
export const RISU_SORTS = Object.freeze({
    trending: 'trending',
    downloads: 'downloads',
    latest: '',
    recommended: 'recommended',
});

/**
 * RisuRealm has no public list API: the list is the data its own pages load
 * (SvelteKit's __data.json), the same one the home page uses.
 */
export function risuListUrl({ api = RISU_SITE, sort = RISU_SORTS.trending, page = 1, search = '', nsfw = true } = {}) {
    const q = new URLSearchParams();
    // "recommended" is a fixed pick without pages or search: a search falls back to latest
    const s = search && sort === 'recommended' ? '' : sort;
    if (s !== undefined && s !== null) q.set('sort', s);
    if (s !== 'recommended') q.set('page', String(Math.max(1, Math.floor(Number(page) || 1))));
    if (search) q.set('q', search);
    if (nsfw) q.set('nsfw', 'true');
    return `${trimSlash(api)}/__data.json?${q}`;
}

export const risuPageUrl = id => `${RISU_SITE}/character/${encodeURIComponent(id)}`;
/** The .charx download: the only format RisuRealm still serves for most cards. */
export const risuDownloadUrl = (id, api = RISU_SITE) => `${trimSlash(api)}/api/v1/download/charx-v3/${encodeURIComponent(id)}?non_commercial=true`;

export function risuSiteUrl({ sort = RISU_SORTS.trending, search = '', nsfw = true } = {}) {
    const q = new URLSearchParams();
    if (sort) q.set('sort', sort);
    if (search) q.set('q', search);
    if (nsfw) q.set('nsfw', 'true');
    const qs = q.toString();
    return `${RISU_SITE}/${qs ? `?${qs}` : ''}`;
}

/** "34.5k" / "1.2M" / "980" → a number. */
export function parseCount(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const m = String(v ?? '').trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb])?$/i);
    if (!m) return 0;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] ?? 1;
    return Math.round(Number(m[1]) * mult) || 0;
}

/**
 * SvelteKit's __data.json packs each page's data with `devalue`: one flat array where
 * objects and arrays hold indices into the same array. Returns the first data node, unpacked.
 */
export function unpackSvelteData(json) {
    const node = Array.isArray(json?.nodes) ? json.nodes.find(n => n && n.type === 'data') : null;
    if (!node) {
        if (json?.type === 'error' || json?.type === 'redirect') throw new Error(`RisuRealm: ${json.type}`);
        return null;
    }
    return devalueUnflatten(node.data);
}

export function devalueUnflatten(values) {
    if (!Array.isArray(values)) return values;
    const memo = new Map();
    const SPECIAL = { '-1': undefined, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 };
    const hydrate = i => {
        if (typeof i !== 'number') return undefined;
        if (i < 0) return SPECIAL[String(i)];
        if (memo.has(i)) return memo.get(i);
        const v = values[i];
        if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
        if (Array.isArray(v)) {
            if (typeof v[0] === 'string') { // [type, ...] for Date, Set, Map, RegExp …
                const [type, ...rest] = v;
                let out;
                switch (type) {
                    case 'Date': out = new Date(rest[0]); break;
                    case 'Set': out = new Set(); memo.set(i, out); for (const x of rest) out.add(hydrate(x)); return out;
                    case 'Map': out = new Map(); memo.set(i, out); for (let k = 0; k < rest.length; k += 2) out.set(hydrate(rest[k]), hydrate(rest[k + 1])); return out;
                    case 'BigInt': out = rest[0]; break;
                    case 'null': {
                        out = Object.create(null); memo.set(i, out);
                        for (let k = 0; k < rest.length; k += 2) out[rest[k]] = hydrate(rest[k + 1]);
                        return out;
                    }
                    default: out = rest.length === 1 ? hydrate(rest[0]) : rest;
                }
                memo.set(i, out);
                return out;
            }
            const arr = [];
            memo.set(i, arr);
            for (const x of v) arr.push(x === -2 ? undefined : hydrate(x));
            return arr;
        }
        const obj = {};
        memo.set(i, obj);
        for (const [k, x] of Object.entries(v)) obj[k] = hydrate(x);
        return obj;
    };
    return hydrate(0);
}

export function risuImage(img) {
    if (!img) return '';
    const s = String(img);
    return /^https?:\/\//i.test(s) ? s : `${RISU_RESOURCE}${s}`;
}

export function normalizeRisuCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? '');
    if (!id) return null;
    const allTags = tagNames({ tags: Array.isArray(raw.tags) ? raw.tags : [] });
    const badges = [];
    if (raw.haslore) badges.push('lorebook');
    if (raw.hasEmotion) badges.push('emotion');
    if (raw.hasAsset) badges.push('assets');
    return {
        id,
        name: String(raw.name || 'Unnamed'),
        avatar: risuImage(raw.img),
        tags: allTags.filter(t => !/^nsfw$/i.test(t)),
        nsfw: allTags.some(t => /^(nsfw|r18)$/i.test(t)),
        chats: 0,
        messages: 0,
        downloads: parseCount(raw.download),
        stars: 0,
        creator: String(raw.authorname || ''),
        createdAt: '',
        description: htmlToText(raw.desc || ''),
        license: String(raw.license || ''),
        url: risuPageUrl(id),
        badges,
    };
}

/** A RisuRealm __data.json → { items, total, page, pages }. */
export function normalizeRisuList(json, page = 1) {
    const data = unpackSvelteData(json); // a page past the end comes back as an error without cards
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    const items = cards.map(normalizeRisuCharacter).filter(Boolean);
    const onePage = data?.sort === 'recommended';
    const more = !onePage && items.length >= RISU_PAGE_SIZE;
    const p = num(data?.page) || page;
    return { items, total: 0, page: p, pages: more ? p + 1 : p };
}

// ---------------------------------------------------------------- sources
//
// Each list tab is one source. `importer` is how a bot gets into SillyTavern:
//   datacat — copy the link, Datacat builds and imports the card (JanitorAI hides its definitions)
//   st-url  — SillyTavern's own "Import from URL" (/api/content/importURL)
//   charx   — download the .charx and hand it to SillyTavern's character import

export const SOURCES = Object.freeze({
    janitor: {
        id: 'janitor',
        name: 'JanitorAI',
        short: 'JanitorAI',
        icon: 'fa-broom',
        site: JANITOR_SITE,
        api: JANITOR_API,
        sorts: DEFAULT_SORTS,
        lists: [
            ['trending24', 'fa-fire', '24 ชม.', 'Trending 24 ชั่วโมง'],
            ['trending', 'fa-fire', 'สัปดาห์', 'Trending สัปดาห์นี้'],
            ['popular', 'fa-trophy', 'Popular', 'Popular'],
            ['latest', 'fa-clock', 'ล่าสุด', 'ล่าสุด'],
        ],
        ranked: tab => tab !== 'latest',
        listUrl: listUrl,
        normalize: normalizeList,
        siteUrl: siteUrl,
        importer: 'datacat',
    },
    chub: {
        id: 'chub',
        name: 'Chub',
        short: 'Chub',
        icon: 'fa-boxes-stacked',
        site: CHUB_SITE,
        api: CHUB_API,
        apiAlternates: ['https://api.chub.ai'],
        sorts: CHUB_SORTS,
        lists: [
            ['trending', 'fa-fire', 'Trending', 'Trending'],
            ['downloads', 'fa-download', 'ดาวน์โหลด', 'ดาวน์โหลดมากสุด'],
            ['stars', 'fa-star', 'ดาว', 'ดาวมากสุด'],
            ['latest', 'fa-clock', 'ล่าสุด', 'ล่าสุด'],
        ],
        ranked: tab => tab !== 'latest',
        listUrl: chubListUrl,
        normalize: normalizeChubList,
        siteUrl: chubSiteUrl,
        importer: 'st-url',
    },
    risu: {
        id: 'risu',
        name: 'RisuRealm',
        short: 'Risu',
        icon: 'fa-chess-rook',
        site: RISU_SITE,
        api: RISU_SITE,
        sorts: RISU_SORTS,
        lists: [
            ['trending', 'fa-fire', 'Trending', 'Trending'],
            ['downloads', 'fa-download', 'ดาวน์โหลด', 'ดาวน์โหลดมากสุด'],
            ['recommended', 'fa-thumbs-up', 'แนะนำ', 'แนะนำ'],
            ['latest', 'fa-clock', 'ล่าสุด', 'ล่าสุด'],
        ],
        ranked: tab => tab !== 'latest' && tab !== 'recommended',
        listUrl: risuListUrl,
        normalize: normalizeRisuList,
        siteUrl: risuSiteUrl,
        importer: 'charx',
    },
});
export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));

/** File name from a Content-Disposition header, or ''. */
export function dispositionName(header) {
    const h = String(header ?? '');
    const star = h.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
    const m = h.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
    return m ? (m[2] ?? m[1]).trim() : '';
}

/** A file name that is safe on any OS, keeping the extension. */
export function safeFileName(name, ext) {
    const base = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'character';
    return `${base}.${ext}`;
}

export function megabytes(bytes) {
    const mb = num(bytes) / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
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

// ---------------------------------------------------------------- Datacat window

/**
 * Where Datacat's window should sit: the Card Shelf area below the tabs, in whole pixels,
 * never outside the screen. Returns null when there's nothing to show it in.
 */
export function dockBox(rect, viewport) {
    if (!rect || !viewport) return null;
    const left = Math.max(0, Math.round(rect.left));
    const top = Math.max(0, Math.round(rect.top));
    const right = Math.min(viewport.width, Math.round(rect.left + rect.width));
    const bottom = Math.min(viewport.height, Math.round(rect.top + rect.height));
    const width = right - left;
    const height = bottom - top;
    if (width < 40 || height < 40) return null;
    return { left, top, width, height };
}
