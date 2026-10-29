/*
 * Card Shelf — SillyTavern UI extension
 *
 * Browse JanitorAI's Ranking, Trending and Latest bots inside SillyTavern, import one as a
 * normal SillyTavern card, and turn its lorebook (or any lorebook file) into a World Info
 * book linked to the character. Also lets you freeze or hide Datacat Browser's dancing
 * top-bar cat, which keeps repainting the top bar while it plays.
 */

import {
    cardFromJanitor, cardFromPng, DEFAULT_SORTS, detailUrl, detectLorebook, findLorebook, hasDefinition,
    idFromLink, JANITOR_API, JANITOR_SITE, listUrl, lorebookName, normalizeCharacter, normalizeList, pageUrl,
    pngWithCard, routedUrl, routeOrder, shortCount, toWorldInfo,
} from './lib.js';

const MODULE = 'card_shelf';
const VERSION = '1.0.0'; // keep in sync with manifest.json
const LOG = '[CardShelf]';

const DEFAULTS = Object.freeze({
    datacatCat: 'animated', // animated | still | hidden — Datacat Browser's top-bar cat
    topbar: true,           // our own icon in the top bar (a still icon, never animated)
    route: 'auto',          // auto | st | direct | custom — how JanitorAI is reached
    proxy: '',              // custom proxy, {url} = the encoded JanitorAI address
    nsfw: true,             // include NSFW bots in lists
    importOrder: 'janitor', // janitor | janny — which copy of a bot to try first
    lorebook: 'auto',       // auto | ask | off — card lorebook → World Info, linked to the bot
    openChat: true,         // open the bot right after importing it
    api: JANITOR_API,
    sorts: DEFAULT_SORTS,
    tab: 'ranking',
});

const TABS = [
    ['ranking', 'fa-trophy', 'Ranking'],
    ['trending', 'fa-fire', 'Trending'],
    ['latest', 'fa-clock', 'ล่าสุด'],
    ['link', 'fa-link', 'ลิงก์'],
    ['lore', 'fa-book-atlas', 'ลอร์บุ๊ค'],
];
const LIST_TABS = new Set(['ranking', 'trending', 'latest']);

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    for (const [k, v] of Object.entries(DEFAULT_SORTS)) if (!s.sorts[k]) s.sorts[k] = v;
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = {
    ok: (m, t) => globalThis.toastr?.success(m, t ?? 'Card Shelf'),
    info: (m, t) => globalThis.toastr?.info(m, t ?? 'Card Shelf'),
    warn: (m, t) => globalThis.toastr?.warning(m, t ?? 'Card Shelf'),
    err: (m, t) => globalThis.toastr?.error(m, t ?? 'Card Shelf'),
};
const errText = e => String(e?.message ?? e);

// SillyTavern pieces getContext() doesn't offer on every version. Loaded on first use.
let stMods = null;
async function st() {
    if (stMods) return stMods;
    stMods = {};
    try { Object.assign(stMods, await import('../../../world-info.js')); } catch (e) { console.warn(LOG, 'world-info.js', e); }
    return stMods;
}

async function worldNames() {
    const c = ctx();
    if (typeof c.getWorldInfoNames === 'function') return c.getWorldInfoNames();
    const m = await st();
    return Array.isArray(m.world_names) ? [...m.world_names] : [];
}

async function freeWorldName(base) {
    const names = new Set((await worldNames()).map(n => n.toLowerCase()));
    const clean = String(base || 'Lorebook').replace(/[\\/:*?"<>|]/g, '').trim() || 'Lorebook';
    if (!names.has(clean.toLowerCase())) return clean;
    for (let i = 2; i < 1000; i++) {
        const n = `${clean} (${i})`;
        if (!names.has(n.toLowerCase())) return n;
    }
    return `${clean} ${Date.now()}`;
}

// ---------------------------------------------------------------- Datacat's cat
//
// Datacat Browser puts an animated GIF in the top bar. A playing GIF repaints its corner of
// the top bar every frame, which some phones feel as stutter while a reply streams in.
// "still" swaps the GIF for its first frame, "hidden" hides the button with CSS. Neither
// removes Datacat's element, so Datacat's own watcher (which re-adds a missing button)
// stays quiet. Datacat stays reachable from the wand menu → Explore.

const DC_IMG_SEL = '#datacat_browser_topbar_button img, #datacat_browser_wand img';

function applyDatacatCat() {
    const mode = settings().datacatCat;
    document.body.classList.toggle('jb_dc_hidden', mode === 'hidden');
    for (const img of document.querySelectorAll(DC_IMG_SEL)) {
        if (mode === 'still') freezeImage(img); else thawImage(img);
    }
}

function freezeImage(img) {
    if (img.dataset.jbFrozen || img.dataset.jbWaiting) return;
    const draw = () => {
        delete img.dataset.jbWaiting;
        if (settings().datacatCat !== 'still' || img.dataset.jbFrozen) return;
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            img.dataset.jbOrig = img.src;
            img.dataset.jbFrozen = '1';
            img.src = c.toDataURL('image/png');
        } catch (e) { console.warn(LOG, 'could not freeze Datacat icon', e); }
    };
    if (img.complete && img.naturalWidth) draw();
    else { img.dataset.jbWaiting = '1'; img.addEventListener('load', draw, { once: true }); }
}

function thawImage(img) {
    if (!img.dataset.jbFrozen) return;
    img.src = img.dataset.jbOrig;
    delete img.dataset.jbFrozen;
    delete img.dataset.jbOrig;
}

/** Datacat may load after us: watch only the two places it adds its buttons (no subtree). */
function watchDatacat() {
    let queued = false;
    const again = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; applyDatacatCat(); });
    };
    const obs = new MutationObserver(again);
    for (const id of ['top-settings-holder', 'top-bar', 'extensionsMenu']) {
        const el = document.getElementById(id);
        if (el) obs.observe(el, { childList: true });
    }
    for (const ms of [500, 2000, 6000]) setTimeout(again, ms);
}

// ---------------------------------------------------------------- reaching JanitorAI
//
// JanitorAI doesn't allow other sites to read its API from the browser (CORS), so lists go
// through SillyTavern's own CORS proxy (/proxy/, `enableCorsProxy: true` in config.yaml), or
// a proxy you choose. The route that worked is tried first next time.

let goodRoute = null;

class ReachError extends Error {
    constructor(attempts) {
        super(attempts.map(a => `${a.route}: ${a.status || ''} ${a.text}`.trim()).join(' · ') || 'no route');
        this.attempts = attempts;
    }
}

async function fetchVia(url, { as = 'json' } = {}) {
    const s = settings();
    let order = routeOrder(s.route, s.proxy);
    if (goodRoute && order.includes(goodRoute)) order = [goodRoute, ...order.filter(r => r !== goodRoute)];
    const attempts = [];
    for (const route of order) {
        const target = routedUrl(url, route, s.proxy);
        if (!target) continue;
        try {
            const res = await fetch(target, {
                headers: { Accept: as === 'json' ? 'application/json' : 'image/*,*/*' },
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
            });
            if (!res.ok) {
                const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
                attempts.push({ route, status: res.status, text });
                continue;
            }
            let body;
            if (as === 'json') {
                const text = await res.text();
                try { body = JSON.parse(text); } catch {
                    attempts.push({ route, status: res.status, text: /cloudflare|challenge|<html/i.test(text) ? 'cloudflare' : 'not json' });
                    continue;
                }
            } else {
                body = await res.blob();
            }
            goodRoute = route;
            return body;
        } catch (e) {
            attempts.push({ route, status: 0, text: errText(e) });
        }
    }
    throw new ReachError(attempts);
}

/** What went wrong, in words, with what to do about it. */
function explainReach(err) {
    const tips = [];
    for (const a of err?.attempts ?? []) {
        if (a.route === 'st' && a.status === 404 && /CORS proxy is disabled/i.test(a.text)) {
            tips.push('พร็อกซีของ SillyTavern ยังปิดอยู่ — เปิดไฟล์ <code>config.yaml</code> ตั้ง <code>enableCorsProxy: true</code> แล้วรีสตาร์ท SillyTavern');
        } else if (a.status === 403 || a.status === 503 || a.text === 'cloudflare') {
            tips.push(`JanitorAI (Cloudflare) ไม่ยอมให้เครื่องนี้อ่าน (${esc(a.route)} ${a.status || ''}) — ลองใหม่ภายหลัง หรือใช้พร็อกซีอื่นในการตั้งค่า`);
        } else if (a.route === 'direct' && a.status === 0) {
            tips.push('เบราว์เซอร์บล็อกการอ่าน JanitorAI ตรง ๆ (CORS) — ต้องผ่านพร็อกซี');
        } else if (a.status === 429) {
            tips.push('JanitorAI ขอให้ช้าลง (429) — รอสักครู่แล้วลองใหม่');
        } else {
            tips.push(`${esc(a.route)}: ${esc(a.status || '')} ${esc(a.text)}`);
        }
    }
    return [...new Set(tips)];
}

// ---------------------------------------------------------------- importing
//
// Two copies of a bot can be imported:
//  - JanitorAI itself: the definition is read from JanitorAI and written into a PNG card
//    (picture + card data) here, then handed to SillyTavern's normal character import.
//    Only works when the creator shows the definition.
//  - JannyAI: SillyTavern's own "Import from external URL" downloads the copy JannyAI keeps
//    of a JanitorAI bot. Works for many bots whose definition is hidden on JanitorAI.

async function importBot(item, { onStep = () => {}, open = settings().openChat } = {}) {
    const s = settings();
    const before = new Set(ctx().characters.map(c => c.avatar));
    const order = s.importOrder === 'janny' ? ['janny', 'janitor'] : ['janitor', 'janny'];
    const failures = [];
    let avatar = null;
    for (const source of order) {
        try {
            onStep(source === 'janitor' ? 'อ่านการ์ดจาก JanitorAI…' : 'ดาวน์โหลดจาก JannyAI…');
            avatar = source === 'janitor' ? await importFromJanitor(item) : await importFromJanny(item, before);
            if (avatar) break;
        } catch (e) {
            console.warn(LOG, source, e);
            failures.push(source === 'janitor' ? `JanitorAI: ${e instanceof ReachError ? explainReach(e).join(' / ') : esc(errText(e))}` : `JannyAI: ${esc(errText(e))}`);
        }
    }
    if (!avatar) throw Object.assign(new Error('import failed'), { html: failures.join('<br>') || 'นำเข้าไม่สำเร็จ' });

    await ctx().getCharacters();
    const chid = ctx().characters.findIndex(c => c.avatar === avatar);
    if (chid < 0) throw new Error('นำเข้าแล้วแต่หาตัวละครไม่เจอ ลองรีเฟรชหน้า');
    onStep('ดูลอร์บุ๊ค…');
    const book = await linkCardLorebook(chid);
    if (open) await ctx().selectCharacterById(chid);
    return { chid, name: ctx().characters[chid]?.name, book };
}

async function importFromJanitor(item) {
    const s = settings();
    const json = await fetchVia(detailUrl(item.id, s.api));
    const raw = json?.data && typeof json.data === 'object' && !Array.isArray(json.data) && !json.id ? json.data : json;
    if (!hasDefinition(raw)) throw new Error('ผู้สร้างซ่อน definition ไว้บน JanitorAI');
    const card = cardFromJanitor(raw, { lorebook: findLorebook(raw) });
    const info = normalizeCharacter(raw) ?? item;
    const png = await cardPng(card, info.avatar?.replace(/\?width=\d+$/, '') || item.avatar);
    return uploadCard(png, card.data.name);
}

async function importFromJanny(item, before) {
    const c = ctx();
    if (typeof c.importFromExternalUrl !== 'function') throw new Error('SillyTavern เวอร์ชันนี้ไม่มี Import from URL');
    await c.importFromExternalUrl(pageUrl(item.id));
    await c.getCharacters();
    const added = c.characters.find(ch => !before.has(ch.avatar));
    if (!added) throw new Error('JannyAI ไม่มีสำเนาของบอทตัวนี้');
    return added.avatar;
}

/** The bot's picture (or a plain placeholder) as a PNG with the card inside it. */
async function cardPng(card, imageUrl) {
    let bitmap = null;
    if (imageUrl) {
        try {
            const blob = await fetchVia(imageUrl, { as: 'blob' });
            bitmap = await createImageBitmap(blob);
        } catch (e) { console.warn(LOG, 'avatar not loaded, using a placeholder', e); }
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap?.width || 400;
    canvas.height = bitmap?.height || 600;
    const g = canvas.getContext('2d');
    if (bitmap) {
        g.drawImage(bitmap, 0, 0);
    } else {
        g.fillStyle = '#2a2833';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#e8e6ef';
        g.font = 'bold 180px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText((card.data.name || '?').trim().charAt(0).toUpperCase(), canvas.width / 2, canvas.height / 2);
    }
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return pngWithCard(new Uint8Array(await blob.arrayBuffer()), card);
}

async function uploadCard(pngBytes, name) {
    const file = new File([pngBytes], `${String(name || 'character').replace(/[\\/:*?"<>|]/g, '_')}.png`, { type: 'image/png' });
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', 'png');
    const headers = { ...ctx().getRequestHeaders() };
    delete headers['Content-Type'];
    const res = await fetch('/api/characters/import', { method: 'POST', headers, body: form, cache: 'no-cache' });
    if (!res.ok) throw new Error(`SillyTavern import ${res.status}`);
    const data = await res.json();
    if (data.error || !data.file_name) throw new Error('SillyTavern ไม่รับไฟล์การ์ด');
    return `${data.file_name}.png`;
}

// ---------------------------------------------------------------- lorebooks

/**
 * The card's embedded lorebook → a World Info book linked to the character, unless the
 * character already has a book linked. Returns the book name, or ''.
 */
async function linkCardLorebook(chid, { mode = settings().lorebook, silent = false } = {}) {
    if (mode === 'off') return '';
    const c = ctx();
    if (c.characters[chid]?.shallow && typeof c.unshallowCharacter === 'function') await c.unshallowCharacter(chid);
    const ch = c.characters[chid];
    const book = ch?.data?.character_book;
    if (!book || !Array.isArray(book.entries) || !book.entries.length) return '';
    const linked = ch.data?.extensions?.world;
    if (linked && (await worldNames()).includes(linked)) return '';

    const name = await freeWorldName(book.name || `${ch.name}'s Lorebook`);
    if (mode === 'ask') {
        const ok = await c.Popup?.show?.confirm?.('การ์ดนี้มีลอร์บุ๊คในตัว', `แปลงเป็นลอร์บุ๊คของ SillyTavern ชื่อ “${esc(name)}” แล้วผูกกับ ${esc(ch.name)} เลยไหม`);
        if (!ok) return '';
    }
    const data = typeof c.convertCharacterBook === 'function'
        ? c.convertCharacterBook(structuredClone(book))
        : toWorldInfo({ spec: 'chara_card_v2', data: { name: ch.name, character_book: book } }).data;
    await saveBook(name, data);
    await c.writeExtensionField(chid, 'world', name);
    if (!silent) toast.ok(`แปลงลอร์บุ๊ค “${name}” (${Object.keys(data.entries).length} รายการ) และผูกกับ ${ch.name} แล้ว`);
    return name;
}

async function saveBook(name, data) {
    const c = ctx();
    if (typeof c.saveWorldInfo === 'function') {
        await c.saveWorldInfo(name, data, true);
    } else {
        const res = await fetch('/api/worldinfo/edit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name, data }) });
        if (!res.ok) throw new Error(`World Info save ${res.status}`);
    }
    if (typeof c.updateWorldInfoList === 'function') await c.updateWorldInfoList();
    else await (await st()).updateWorldInfoList?.();
}

// ---------------------------------------------------------------- browser window

const ui = {
    root: null,
    tab: 'ranking',
    search: '',
    lists: {},      // listKey() → { tab, search, items, page, pages, done, loading, error }
    observer: null,
};

const listKey = () => JSON.stringify([ui.tab, ui.search, settings().nsfw]);

function openBrowser(tab) {
    const s = settings();
    if (tab && TABS.some(t => t[0] === tab)) s.tab = tab;
    ui.tab = s.tab;
    if (ui.root) { renderTab(); return; }
    const root = document.createElement('div');
    root.id = 'jb_root';
    root.className = 'jb_root';
    root.innerHTML = `
        <div class="jb_backdrop"></div>
        <section class="jb_panel" role="dialog" aria-modal="true" aria-label="Card Shelf">
            <header class="jb_head">
                <div class="jb_titlebar">
                    <div class="jb_title"><i class="fa-solid fa-compass"></i><b>JanitorAI</b><i class="fa-solid fa-circle-notch fa-spin jb_spin" hidden></i></div>
                    <div class="jb_tools">
                        <button class="jb_tool jb_site" title="เปิดหน้านี้บนเว็บ JanitorAI"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                        <button class="jb_tool jb_reload" title="โหลดใหม่"><i class="fa-solid fa-rotate"></i></button>
                        <button class="jb_tool jb_close" title="ปิด (Esc)" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <nav class="jb_tabs" role="tablist">${TABS.map(([id, icon, label]) => `<button data-tab="${id}" role="tab"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`).join('')}</nav>
                <form class="jb_searchrow">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" class="jb_search" placeholder="ค้นหาบอทบน JanitorAI" autocomplete="off" spellcheck="false" enterkeyhint="search">
                </form>
            </header>
            <div class="jb_body"></div>
            <div class="jb_sheet" hidden></div>
        </section>`;
    document.body.append(root);
    ui.root = root;
    const q = sel => root.querySelector(sel);
    q('.jb_backdrop').addEventListener('click', closeBrowser);
    q('.jb_close').addEventListener('click', closeBrowser);
    q('.jb_reload').addEventListener('click', () => { delete ui.lists[listKey()]; goodRoute = null; renderTab(); });
    q('.jb_site').addEventListener('click', () => window.open(siteUrl(), '_blank', 'noopener'));
    q('.jb_tabs').addEventListener('click', e => {
        const b = e.target.closest('button[data-tab]');
        if (!b) return;
        ui.tab = settings().tab = b.dataset.tab;
        saveSettings();
        renderTab();
    });
    q('.jb_searchrow').addEventListener('submit', e => {
        e.preventDefault();
        ui.search = q('.jb_search').value.trim();
        if (!LIST_TABS.has(ui.tab)) ui.tab = 'ranking';
        renderTab();
    });
    q('.jb_search').addEventListener('search', () => {
        if (q('.jb_search').value === '' && ui.search) { ui.search = ''; renderTab(); }
    });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => root.classList.add('jb_in'));
    renderTab();
}

function closeBrowser() {
    if (!ui.root) return;
    const root = ui.root;
    ui.root = null;
    ui.observer?.disconnect();
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('jb_in');
    root.classList.add('jb_out');
    setTimeout(() => root.remove(), 200);
}

function onKey(e) {
    if (e.key !== 'Escape' || !ui.root) return;
    e.stopPropagation();
    const sheet = ui.root.querySelector('.jb_sheet');
    if (!sheet.hidden) closeSheet(); else closeBrowser();
}

function siteUrl() {
    const s = settings();
    if (!LIST_TABS.has(ui.tab)) return JANITOR_SITE;
    const p = new URLSearchParams({ mode: s.nsfw ? 'all' : 'sfw', sort: s.sorts[ui.tab], page: '1' });
    if (ui.search) p.set('search', ui.search);
    return `${JANITOR_SITE}/search?${p}`;
}

function setBusy(on) {
    const spin = ui.root?.querySelector('.jb_spin');
    if (spin) spin.hidden = !on;
}

function renderTab() {
    if (!ui.root) return;
    const q = sel => ui.root.querySelector(sel);
    for (const b of ui.root.querySelectorAll('.jb_tabs button')) b.classList.toggle('jb_on', b.dataset.tab === ui.tab);
    q('.jb_searchrow').hidden = !LIST_TABS.has(ui.tab);
    q('.jb_search').value = ui.search;
    closeSheet();
    ui.observer?.disconnect();
    const body = q('.jb_body');
    body.scrollTop = 0;
    if (ui.tab === 'link') return renderLinkTab(body);
    if (ui.tab === 'lore') return renderLoreTab(body);
    renderList(body);
}

// ---------------------------------------------------------------- list tabs

function renderList(body) {
    const key = listKey();
    const list = ui.lists[key] ??= { tab: ui.tab, search: ui.search, items: [], page: 0, pages: 0, done: false, loading: false, error: null };
    const title = ui.search ? `ผลค้นหา “${esc(ui.search)}” · ${TABS.find(t => t[0] === ui.tab)[2]}` : '';
    body.innerHTML = `
        ${title ? `<div class="jb_note">${title}</div>` : ''}
        <div class="jb_grid" role="list"></div>
        <div class="jb_more"></div>`;
    appendCards(body.querySelector('.jb_grid'), list.items, 0);
    updateMore(body, list);
    ui.observer = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) loadMore(key);
    }, { root: body, rootMargin: '600px 0px' });
    ui.observer.observe(body.querySelector('.jb_more'));
    if (!list.items.length && !list.loading && !list.error) loadMore(key);
}

async function loadMore(key) {
    const list = ui.lists[key];
    if (!list || list.loading || list.done || list.error) return;
    const { tab, search } = list;
    const s = settings();
    list.loading = true;
    setBusy(true);
    refreshMore(key);
    try {
        const page = list.page + 1;
        const json = await fetchVia(listUrl({ api: s.api, sort: s.sorts[tab], page, search, nsfw: s.nsfw }));
        const r = normalizeList(json, page);
        const seen = new Set(list.items.map(i => i.id));
        const fresh = r.items.filter(i => !seen.has(i.id));
        const start = list.items.length;
        list.items.push(...fresh);
        list.page = page;
        list.pages = r.pages;
        list.done = !fresh.length || (r.pages && page >= r.pages);
        if (ui.root && key === listKey()) appendCards(ui.root.querySelector('.jb_grid'), fresh, start);
    } catch (e) {
        console.warn(LOG, 'list', e);
        list.error = e;
    } finally {
        list.loading = false;
        setBusy(false);
        refreshMore(key);
    }
}

function refreshMore(key) {
    if (!ui.root || key !== listKey()) return;
    const body = ui.root.querySelector('.jb_body');
    if (!body) return;
    updateMore(body, ui.lists[key]);
    // The observer only reports changes: if the end of the list is still on screen after a
    // page arrived, observe again so it reports "visible" once more and the next page loads.
    const more = body.querySelector('.jb_more');
    if (more && ui.observer && !ui.lists[key].loading) { ui.observer.unobserve(more); ui.observer.observe(more); }
}

function updateMore(body, list) {
    const more = body.querySelector('.jb_more');
    if (!more) return;
    if (list.error) {
        const tips = list.error instanceof ReachError ? explainReach(list.error) : [esc(errText(list.error))];
        more.innerHTML = `
            <div class="jb_error">
                <b><i class="fa-solid fa-triangle-exclamation"></i> อ่านรายชื่อจาก JanitorAI ไม่ได้</b>
                <ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>
                <div class="jb_row">
                    <button class="menu_button jb_retry"><i class="fa-solid fa-rotate"></i> ลองใหม่</button>
                    <button class="menu_button jb_opensite"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดบนเว็บ JanitorAI</button>
                </div>
                <small>เห็นบอทที่ชอบบนเว็บ ก็คัดลอกลิงก์มาวางในแท็บ “ลิงก์” เพื่อนำเข้าได้</small>
            </div>`;
        more.querySelector('.jb_retry').addEventListener('click', () => { list.error = null; goodRoute = null; updateMore(body, list); loadMore(listKey()); });
        more.querySelector('.jb_opensite').addEventListener('click', () => window.open(siteUrl(), '_blank', 'noopener'));
    } else if (list.loading) {
        more.innerHTML = '<div class="jb_loading"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังโหลด…</div>';
    } else if (list.done) {
        more.innerHTML = list.items.length ? '<div class="jb_end">หมดแล้ว</div>' : '<div class="jb_end">ไม่พบบอท</div>';
    } else {
        more.innerHTML = '<button class="menu_button jb_loadmore">โหลดเพิ่ม</button>';
        more.querySelector('.jb_loadmore').addEventListener('click', () => loadMore(listKey()));
    }
}

function appendCards(grid, items, start) {
    if (!grid || !items.length) return;
    const ranked = ui.tab !== 'latest' && !ui.search;
    const html = items.map((it, i) => `
        <button class="jb_card" role="listitem" data-id="${esc(it.id)}">
            <span class="jb_cover">
                ${it.avatar ? `<img src="${esc(it.avatar)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-user"></i>'}
                ${ranked ? `<span class="jb_rank">${start + i + 1}</span>` : ''}
                ${it.nsfw ? '<span class="jb_nsfw">NSFW</span>' : ''}
            </span>
            <span class="jb_cname">${esc(it.name)}</span>
            <span class="jb_meta">${it.chats ? `<i class="fa-solid fa-comments"></i> ${shortCount(it.chats)}` : ''}${it.creator ? ` · @${esc(it.creator)}` : ''}</span>
            <span class="jb_tags">${it.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}</span>
        </button>`).join('');
    grid.insertAdjacentHTML('beforeend', html);
    if (!grid.dataset.bound) {
        grid.dataset.bound = '1';
        grid.addEventListener('click', e => {
            const card = e.target.closest('.jb_card');
            if (!card) return;
            const item = Object.values(ui.lists).flatMap(l => l.items).find(i => i.id === card.dataset.id);
            if (item) openSheet(item);
        });
    }
}

// ---------------------------------------------------------------- bot sheet

function openSheet(item) {
    const sheet = ui.root?.querySelector('.jb_sheet');
    if (!sheet) return;
    sheet.hidden = false;
    sheet.innerHTML = `
        <div class="jb_sheetbar">
            <button class="jb_tool jb_back" title="กลับ"><i class="fa-solid fa-arrow-left"></i></button>
            <b>${esc(item.name)}</b>
        </div>
        <div class="jb_sheetbody">
            <div class="jb_hero">
                ${item.avatar ? `<img src="${esc(item.avatar.replace(/\?width=\d+$/, '?width=600'))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}
                <div class="jb_herotext">
                    <h3>${esc(item.name)}</h3>
                    ${item.creator ? `<div class="jb_by">โดย @${esc(item.creator)}</div>` : ''}
                    <div class="jb_stats">
                        ${item.chats ? `<span><i class="fa-solid fa-comments"></i> ${shortCount(item.chats)} แชท</span>` : ''}
                        ${item.messages ? `<span><i class="fa-solid fa-message"></i> ${shortCount(item.messages)} ข้อความ</span>` : ''}
                        ${item.nsfw ? '<span class="jb_nsfw">NSFW</span>' : ''}
                    </div>
                    <div class="jb_tags jb_tagsfull">${item.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
                </div>
            </div>
            <div class="jb_actions">
                <button class="menu_button jb_import"><i class="fa-solid fa-file-import"></i> นำเข้าเข้า SillyTavern</button>
                <button class="menu_button jb_openpage"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดใน JanitorAI</button>
            </div>
            <div class="jb_status" hidden></div>
            ${item.description ? `<div class="jb_desc">${esc(item.description)}</div>` : ''}
        </div>`;
    sheet.querySelector('.jb_back').addEventListener('click', closeSheet);
    sheet.querySelector('.jb_openpage').addEventListener('click', () => window.open(item.url, '_blank', 'noopener'));
    sheet.querySelector('.jb_import').addEventListener('click', e => runImport(item, e.currentTarget, sheet.querySelector('.jb_status')));
    requestAnimationFrame(() => sheet.classList.add('jb_in'));
}

function closeSheet() {
    const sheet = ui.root?.querySelector('.jb_sheet');
    if (!sheet || sheet.hidden) return;
    sheet.classList.remove('jb_in');
    sheet.hidden = true;
    sheet.innerHTML = '';
}

let importing = false;
async function runImport(item, button, status) {
    if (importing) return toast.info('กำลังนำเข้าอีกตัวอยู่');
    importing = true;
    if (button) button.disabled = true;
    const say = (html, cls = '') => { if (status) { status.hidden = false; status.className = `jb_status ${cls}`; status.innerHTML = html; } };
    try {
        const r = await importBot(item, { onStep: t => say(`<i class="fa-solid fa-circle-notch fa-spin"></i> ${esc(t)}`) });
        say(`<i class="fa-solid fa-check"></i> นำเข้า ${esc(r.name)} แล้ว${r.book ? ` · ลอร์บุ๊ค “${esc(r.book)}” ผูกให้แล้ว` : ''}`, 'jb_good');
        toast.ok(`นำเข้า ${r.name} แล้ว`);
        if (settings().openChat) closeBrowser();
    } catch (e) {
        say(`<b>นำเข้าไม่สำเร็จ</b><br>${e.html ?? esc(errText(e))}`, 'jb_bad');
    } finally {
        importing = false;
        if (button) button.disabled = false;
    }
}

// ---------------------------------------------------------------- link tab

function renderLinkTab(body) {
    body.innerHTML = `
        <div class="jb_pane">
            <h4>นำเข้าจากลิงก์ JanitorAI</h4>
            <p class="jb_hint">วางลิงก์หน้าบอท เช่น <code>https://janitorai.com/characters/xxxxxxxx-…_character-ชื่อ</code> (ลิงก์ JannyAI ก็ได้) วางหลายลิงก์ได้ บรรทัดละลิงก์</p>
            <textarea class="text_pole jb_links" rows="5" placeholder="https://janitorai.com/characters/…"></textarea>
            <div class="jb_row"><button class="menu_button jb_golinks"><i class="fa-solid fa-file-import"></i> นำเข้า</button></div>
            <div class="jb_status" hidden></div>
        </div>`;
    const status = body.querySelector('.jb_status');
    body.querySelector('.jb_golinks').addEventListener('click', async e => {
        const ids = [...new Set(body.querySelector('.jb_links').value.split(/\s+/).map(idFromLink).filter(Boolean))];
        if (!ids.length) { status.hidden = false; status.className = 'jb_status jb_bad'; status.textContent = 'ไม่พบลิงก์บอทที่ใช้ได้'; return; }
        // Several links: import them all, open none (the last one would win anyway).
        const open = settings().openChat && ids.length === 1;
        const button = e.currentTarget;
        button.disabled = true;
        const lines = [];
        let opened = false;
        for (const [n, id] of ids.entries()) {
            lines.push(`<i class="fa-solid fa-circle-notch fa-spin"></i> ${n + 1}/${ids.length}`);
            status.hidden = false; status.className = 'jb_status'; status.innerHTML = lines.join('<br>');
            try {
                const r = await importBot({ id, name: id, avatar: '', url: pageUrl(id) }, { open });
                lines[n] = `<i class="fa-solid fa-check"></i> ${esc(r.name)}${r.book ? ` · ลอร์บุ๊ค “${esc(r.book)}”` : ''}`;
                opened = open;
            } catch (err) {
                lines[n] = `<i class="fa-solid fa-xmark"></i> ${esc(id)}<br><small>${err.html ?? esc(errText(err))}</small>`;
            }
            if (status.isConnected) status.innerHTML = lines.join('<br>');
        }
        button.disabled = false;
        if (opened) closeBrowser();
    });
}

// ---------------------------------------------------------------- lorebook tab

function characterOptions(selected) {
    const c = ctx();
    return ['<option value="">— ไม่ผูกกับตัวละคร —</option>']
        .concat(c.characters.map((ch, i) => ({ ch, i })).sort((a, b) => String(a.ch.name).localeCompare(String(b.ch.name)))
            .map(({ ch, i }) => `<option value="${i}"${String(i) === String(selected) ? ' selected' : ''}>${esc(ch.name)}</option>`))
        .join('');
}

function renderLoreTab(body) {
    const cur = ctx().characterId;
    body.innerHTML = `
        <div class="jb_pane">
            <h4>แปลงลอร์บุ๊คให้ใช้ใน SillyTavern ได้</h4>
            <p class="jb_hint">วาง JSON หรือเลือกไฟล์: ลอร์บุ๊คจากการ์ด (character_book) การ์ด PNG/JSON ที่มีลอร์บุ๊คในตัว ลอร์บุ๊คแบบ JanitorAI, NovelAI, Agnai, RisuAI หรือรายการ entry ธรรมดา</p>
            <div class="jb_row">
                <label class="menu_button jb_filebtn"><i class="fa-solid fa-folder-open"></i> เลือกไฟล์<input type="file" accept=".json,.png,application/json,image/png" hidden></label>
                <span class="jb_filename"></span>
            </div>
            <textarea class="text_pole jb_lorejson" rows="7" placeholder='{ "entries": [ { "keys": ["…"], "content": "…" } ] }'></textarea>
            <div class="jb_detect jb_hint"></div>
            <label class="jb_field">ชื่อลอร์บุ๊ค<input type="text" class="text_pole jb_lorename"></label>
            <label class="jb_field">ผูกกับตัวละคร<select class="text_pole jb_lorechar">${characterOptions(cur)}</select></label>
            <div class="jb_row">
                <button class="menu_button jb_loresave"><i class="fa-solid fa-book-medical"></i> สร้างลอร์บุ๊คใน SillyTavern</button>
                <button class="menu_button jb_loredl"><i class="fa-solid fa-download"></i> ดาวน์โหลด JSON</button>
            </div>
            <div class="jb_status jb_lorestatus" hidden></div>
        </div>
        <div class="jb_pane">
            <h4>การ์ดที่มีลอร์บุ๊คในตัวแต่ยังไม่ได้แปลง</h4>
            <p class="jb_hint">เช่น การ์ดที่นำเข้าจาก Datacat หรือที่อื่นแล้วยังไม่ได้กด Import Card Lore จะแปลงแล้วผูกกับตัวละครนั้นให้ (ไม่ทับลอร์บุ๊คที่ผูกไว้แล้ว)</p>
            <div class="jb_row"><button class="menu_button jb_scan"><i class="fa-solid fa-magnifying-glass"></i> ค้นหา</button></div>
            <div class="jb_scanlist"></div>
        </div>`;

    const q = s => body.querySelector(s);
    let parsed = null;
    let nameTouched = false;
    const status = (html, cls = '') => { const el = q('.jb_lorestatus'); el.hidden = false; el.className = `jb_status jb_lorestatus ${cls}`; el.innerHTML = html; };
    const KIND = {
        sillytavern: 'ลอร์บุ๊ค SillyTavern', card: 'การ์ดที่มีลอร์บุ๊คในตัว', 'card-no-book': 'การ์ด (ไม่มีลอร์บุ๊คในตัว)',
        character_book: 'ลอร์บุ๊คแบบการ์ด (character_book)', novel: 'NovelAI Lorebook', agnai: 'Agnai Memory Book',
        risu: 'RisuAI Lorebook', janitor: 'ลอร์บุ๊คในข้อมูลบอท', list: 'รายการ entry',
    };
    const detect = () => {
        const text = q('.jb_lorejson').value.trim();
        parsed = null;
        if (!text) { q('.jb_detect').textContent = ''; return; }
        try { parsed = JSON.parse(text); } catch { q('.jb_detect').textContent = 'ยังไม่ใช่ JSON ที่อ่านได้'; return; }
        const r = toWorldInfo(parsed);
        q('.jb_detect').textContent = r.kind ? `${KIND[r.kind] ?? r.kind} · ${r.count} รายการ` : 'ไม่รู้จักรูปแบบนี้';
        if (!nameTouched) q('.jb_lorename').value = lorebookName(parsed, 'Lorebook');
    };
    q('.jb_lorejson').addEventListener('input', detect);
    q('.jb_lorename').addEventListener('input', () => { nameTouched = true; });
    q('.jb_filebtn input').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        q('.jb_filename').textContent = file.name;
        try {
            let json;
            if (/\.png$/i.test(file.name) || file.type === 'image/png') {
                json = cardFromPng(new Uint8Array(await file.arrayBuffer()));
                if (!json) throw new Error('ไม่พบข้อมูลการ์ดในรูปนี้');
            } else {
                json = JSON.parse(await file.text());
            }
            nameTouched = false;
            q('.jb_lorejson').value = JSON.stringify(json, null, 2);
            detect();
            if (!lorebookName(json) && !nameTouched) q('.jb_lorename').value = file.name.replace(/\.[^.]+$/, '');
        } catch (err) {
            status(`อ่านไฟล์ไม่ได้: ${esc(errText(err))}`, 'jb_bad');
        }
        e.target.value = '';
    });
    const converted = () => {
        if (!parsed) detect();
        if (!parsed) throw new Error('วาง JSON หรือเลือกไฟล์ก่อน');
        const r = toWorldInfo(parsed);
        if (!r.count) throw new Error('ไม่พบ entry ที่แปลงได้');
        return r;
    };
    q('.jb_loresave').addEventListener('click', async () => {
        try {
            const r = converted();
            const wanted = q('.jb_lorename').value.trim() || 'Lorebook';
            const names = await worldNames();
            let name = wanted;
            if (names.some(n => n.toLowerCase() === wanted.toLowerCase())) {
                const overwrite = await ctx().Popup?.show?.confirm?.(`มีลอร์บุ๊คชื่อ “${esc(wanted)}” อยู่แล้ว`, 'กด OK เพื่อเขียนทับ หรือ Cancel เพื่อสร้างเป็นชื่อใหม่');
                if (!overwrite) name = await freeWorldName(wanted);
            }
            await saveBook(name, r.data);
            const chid = q('.jb_lorechar').value;
            let linkedTo = '';
            if (chid !== '') {
                await ctx().writeExtensionField(Number(chid), 'world', name);
                linkedTo = ctx().characters[Number(chid)]?.name ?? '';
            }
            status(`<i class="fa-solid fa-check"></i> สร้าง “${esc(name)}” แล้ว (${r.count} รายการ)${linkedTo ? ` · ผูกกับ ${esc(linkedTo)}` : ''}`, 'jb_good');
            toast.ok(`สร้างลอร์บุ๊ค “${name}” แล้ว`);
        } catch (err) {
            status(esc(errText(err)), 'jb_bad');
        }
    });
    q('.jb_loredl').addEventListener('click', () => {
        try {
            const r = converted();
            const name = q('.jb_lorename').value.trim() || 'Lorebook';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 4)], { type: 'application/json' }));
            a.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } catch (err) {
            status(esc(errText(err)), 'jb_bad');
        }
    });
    q('.jb_scan').addEventListener('click', () => scanEmbedded(q('.jb_scanlist'), q('.jb_scan')));
}

async function scanEmbedded(box, button) {
    const c = ctx();
    button.disabled = true;
    box.innerHTML = '<div class="jb_loading"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังดูการ์ด…</div>';
    try {
        const names = new Set(await worldNames());
        const found = [];
        for (let i = 0; i < c.characters.length; i++) {
            const ch = c.characters[i];
            if (ch.data?.extensions?.world && names.has(ch.data.extensions.world)) continue;
            if (ch.shallow && typeof c.unshallowCharacter === 'function') {
                box.innerHTML = `<div class="jb_loading"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังดูการ์ด ${i + 1}/${c.characters.length}…</div>`;
                await c.unshallowCharacter(i);
            }
            const book = c.characters[i]?.data?.character_book;
            if (book?.entries?.length) found.push({ i, name: c.characters[i].name, count: book.entries.length });
        }
        if (!found.length) { box.innerHTML = '<div class="jb_end">ไม่มีการ์ดที่ต้องแปลง</div>'; return; }
        box.innerHTML = `
            <ul class="jb_scanitems">${found.map(f => `<li data-i="${f.i}"><span>${esc(f.name)} <small>(${f.count} รายการ)</small></span><button class="menu_button jb_one">แปลง</button></li>`).join('')}</ul>
            <div class="jb_row"><button class="menu_button jb_all"><i class="fa-solid fa-wand-magic-sparkles"></i> แปลงทั้งหมด (${found.length})</button></div>`;
        const one = async li => {
            const name = await linkCardLorebook(Number(li.dataset.i), { mode: 'auto', silent: true });
            li.querySelector('button')?.remove();
            li.insertAdjacentHTML('beforeend', name ? `<small class="jb_good">→ ${esc(name)}</small>` : '<small>ข้าม</small>');
        };
        box.querySelectorAll('.jb_one').forEach(b => b.addEventListener('click', () => one(b.closest('li')).catch(e => toast.err(errText(e)))));
        box.querySelector('.jb_all').addEventListener('click', async e => {
            e.currentTarget.disabled = true;
            for (const li of box.querySelectorAll('li')) {
                if (!li.querySelector('.jb_one')) continue;
                try { await one(li); } catch (err) { li.insertAdjacentHTML('beforeend', `<small class="jb_bad">${esc(errText(err))}</small>`); }
            }
            toast.ok('แปลงลอร์บุ๊คครบแล้ว');
        });
    } catch (e) {
        box.innerHTML = `<div class="jb_status jb_bad">${esc(errText(e))}</div>`;
    } finally {
        button.disabled = false;
    }
}

// ---------------------------------------------------------------- launchers & settings

function renderTopbar() {
    let el = document.getElementById('jb_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'jb_topbar';
    el.className = 'drawer';
    el.innerHTML = '<div class="drawer-toggle"><div class="drawer-icon fa-regular fa-compass interactable jb_ticon" title="Card Shelf — Ranking / Trending" tabindex="0"></div></div>';
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); openBrowser(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openBrowser(); });
}

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('jb_wand')) return;
    const item = document.createElement('div');
    item.id = 'jb_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-compass extensionsMenuExtensionButton"></div><span>Card Shelf</span>';
    item.addEventListener('click', () => openBrowser());
    menu.append(item);
}

function renderSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('jb_settings')) return;
    const s = settings();
    const radio = (name, value, label) => `<label class="checkbox_label"><input type="radio" name="${name}" value="${value}"${s[name.replace('jb_', '')] === value ? ' checked' : ''}> ${label}</label>`;
    host.insertAdjacentHTML('beforeend', `
    <div id="jb_settings" class="jb_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Card Shelf <small class="jb_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="jb_row"><div id="jb_set_open" class="menu_button"><i class="fa-solid fa-compass"></i> เปิด Card Shelf</div></div>
                <label class="checkbox_label"><input type="checkbox" id="jb_set_topbar"> ไอคอนเข็มทิศบนแถบด้านบน (ไอคอนนิ่ง ไม่มีแอนิเมชัน)</label>

                <h4 class="jb_sethead">แมว Datacat บนแถบด้านบน</h4>
                <div class="jb_radios">
                    ${radio('jb_datacatCat', 'animated', 'เต้นตามปกติ')}
                    ${radio('jb_datacatCat', 'still', 'หยุดนิ่ง (เป็นรูปนิ่ง กดเปิดได้เหมือนเดิม)')}
                    ${radio('jb_datacatCat', 'hidden', 'ซ่อน (ยังเปิดได้จากเมนูไม้กายสิทธิ์ → Explore)')}
                </div>
                <small class="jb_setnote">ใช้กับ Datacat SillyTavern Browser · ถ้าจอกระตุกตอนบอทตอบ ลอง “หยุดนิ่ง” หรือ “ซ่อน”</small>

                <h4 class="jb_sethead">นำเข้าบอท</h4>
                <label class="jb_field">ลองดึงจาก
                    <select id="jb_set_order" class="text_pole">
                        <option value="janitor">JanitorAI ก่อน แล้วค่อย JannyAI</option>
                        <option value="janny">JannyAI ก่อน แล้วค่อย JanitorAI</option>
                    </select>
                </label>
                <label class="jb_field">ลอร์บุ๊คในการ์ด
                    <select id="jb_set_lore" class="text_pole">
                        <option value="auto">แปลงเป็นลอร์บุ๊ค ST แล้วผูกให้เลย</option>
                        <option value="ask">ถามก่อน</option>
                        <option value="off">ไม่ต้องทำ</option>
                    </select>
                </label>
                <label class="checkbox_label"><input type="checkbox" id="jb_set_open_chat"> เปิดแชทกับบอทหลังนำเข้า</label>
                <label class="checkbox_label"><input type="checkbox" id="jb_set_nsfw"> แสดงบอท NSFW ในรายการ</label>

                <details class="jb_adv">
                    <summary>การเชื่อมต่อ JanitorAI</summary>
                    <label class="jb_field">เส้นทาง
                        <select id="jb_set_route" class="text_pole">
                            <option value="auto">อัตโนมัติ (พร็อกซี ST → พร็อกซีที่ตั้งไว้ → ตรง)</option>
                            <option value="st">พร็อกซีของ SillyTavern (/proxy/)</option>
                            <option value="custom">พร็อกซีที่ตั้งเอง</option>
                            <option value="direct">ตรงจากเบราว์เซอร์</option>
                        </select>
                    </label>
                    <label class="jb_field">พร็อกซีที่ตั้งเอง <small>(<code>{url}</code> = ที่อยู่ JanitorAI)</small>
                        <input type="text" id="jb_set_proxy" class="text_pole" placeholder="https://your-proxy.example/?url={url}">
                    </label>
                    <label class="jb_field">API<input type="text" id="jb_set_api" class="text_pole"></label>
                    <div class="jb_sorts">
                        <label class="jb_field">Ranking sort<input type="text" class="text_pole" data-sort="ranking"></label>
                        <label class="jb_field">Trending sort<input type="text" class="text_pole" data-sort="trending"></label>
                        <label class="jb_field">ล่าสุด sort<input type="text" class="text_pole" data-sort="latest"></label>
                    </div>
                    <div class="jb_row"><div id="jb_set_test" class="menu_button"><i class="fa-solid fa-plug"></i> ทดสอบการเชื่อมต่อ</div><div id="jb_set_reset" class="menu_button">ค่าเริ่มต้น</div></div>
                    <div id="jb_set_testout" class="jb_setnote"></div>
                    <small class="jb_setnote">JanitorAI ไม่ให้เว็บอื่นอ่าน API ตรง ๆ ต้องเปิดพร็อกซีของ SillyTavern: ใน <code>config.yaml</code> ตั้ง <code>enableCorsProxy: true</code> แล้วรีสตาร์ท · พร็อกซีที่ตั้งเองจะเห็นว่าคุณเปิดดูบอทไหน</small>
                </details>
                <small class="jb_setnote">เปิดได้จากไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/janitor</code> (<code>/janitor trending</code>, <code>/janitor lore</code>)</small>
            </div>
        </div>
    </div>`);
    const $ = id => document.getElementById(id);
    $('jb_set_open').addEventListener('click', () => openBrowser());
    $('jb_set_topbar').checked = !!s.topbar;
    $('jb_set_topbar').addEventListener('change', e => { s.topbar = e.target.checked; saveSettings(); renderTopbar(); });
    for (const r of document.querySelectorAll('input[name="jb_datacatCat"]')) {
        r.addEventListener('change', e => { if (e.target.checked) { s.datacatCat = e.target.value; saveSettings(); applyDatacatCat(); } });
    }
    const bindSelect = (id, key) => { $(id).value = s[key]; $(id).addEventListener('change', e => { s[key] = e.target.value; saveSettings(); }); };
    bindSelect('jb_set_order', 'importOrder');
    bindSelect('jb_set_lore', 'lorebook');
    bindSelect('jb_set_route', 'route');
    $('jb_set_route').addEventListener('change', () => { goodRoute = null; });
    $('jb_set_open_chat').checked = !!s.openChat;
    $('jb_set_open_chat').addEventListener('change', e => { s.openChat = e.target.checked; saveSettings(); });
    $('jb_set_nsfw').checked = !!s.nsfw;
    $('jb_set_nsfw').addEventListener('change', e => { s.nsfw = e.target.checked; saveSettings(); });
    const fillAdv = () => {
        $('jb_set_proxy').value = s.proxy;
        $('jb_set_api').value = s.api;
        for (const inp of document.querySelectorAll('#jb_settings [data-sort]')) inp.value = s.sorts[inp.dataset.sort];
        $('jb_set_route').value = s.route;
    };
    fillAdv();
    $('jb_set_proxy').addEventListener('change', e => { s.proxy = e.target.value.trim(); goodRoute = null; saveSettings(); });
    $('jb_set_api').addEventListener('change', e => { s.api = e.target.value.trim().replace(/\/+$/, '') || JANITOR_API; e.target.value = s.api; saveSettings(); });
    for (const inp of document.querySelectorAll('#jb_settings [data-sort]')) {
        inp.addEventListener('change', e => { s.sorts[inp.dataset.sort] = e.target.value.trim() || DEFAULT_SORTS[inp.dataset.sort]; e.target.value = s.sorts[inp.dataset.sort]; ui.lists = {}; saveSettings(); });
    }
    $('jb_set_reset').addEventListener('click', () => {
        Object.assign(s, { route: DEFAULTS.route, proxy: '', api: JANITOR_API, sorts: { ...DEFAULT_SORTS } });
        goodRoute = null; ui.lists = {};
        saveSettings(); fillAdv();
    });
    $('jb_set_test').addEventListener('click', async () => {
        const out = $('jb_set_testout');
        out.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังทดสอบ…';
        goodRoute = null;
        try {
            const json = await fetchVia(listUrl({ api: s.api, sort: s.sorts.ranking, page: 1, nsfw: s.nsfw }));
            const r = normalizeList(json);
            out.innerHTML = r.items.length
                ? `<span class="jb_good"><i class="fa-solid fa-check"></i> ใช้ได้ ผ่าน ${esc(goodRoute)} · ได้ ${r.items.length} บอท</span>`
                : `ต่อได้ผ่าน ${esc(goodRoute)} แต่ไม่พบรายชื่อบอทในคำตอบ: <code>${esc(JSON.stringify(json).slice(0, 200))}</code>`;
        } catch (e) {
            out.innerHTML = `<span class="jb_bad">ต่อไม่ได้</span><ul>${(e instanceof ReachError ? explainReach(e) : [esc(errText(e))]).map(t => `<li>${t}</li>`).join('')}</ul>`;
        }
    });
}

function registerCommand() {
    const c = ctx();
    const run = (_args, value) => { openBrowser(String(value ?? '').trim().toLowerCase() || undefined); return ''; };
    try {
        if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'janitor',
                aliases: ['shelf'],
                callback: run,
                helpString: 'เปิด Card Shelf — ใส่แท็บได้: ranking, trending, latest, link, lore',
            }));
        } else {
            c.registerSlashCommand?.('janitor', run, [], 'เปิด Card Shelf', true, true);
        }
    } catch (e) { console.warn(LOG, 'slash command', e); }
}

// ---------------------------------------------------------------- start

jQuery(() => {
    try {
        settings();
        renderSettingsPanel();
        renderTopbar();
        addWandItem();
        registerCommand();
        applyDatacatCat();
        watchDatacat();
        setTimeout(() => { renderTopbar(); addWandItem(); }, 1500);
        globalThis.CardShelf = { open: openBrowser, version: VERSION };
        console.log(LOG, `v${VERSION} ready`);
    } catch (e) {
        console.error(LOG, 'start failed', e);
    }
});
