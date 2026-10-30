/*
 * Card Shelf — pure helpers (no DOM, no SillyTavern), so they can be tested in Node.
 *
 *  - JanitorAI list JSON → one plain shape the JanitorAI tab draws
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
