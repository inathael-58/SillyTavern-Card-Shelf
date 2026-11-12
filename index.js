/*
 * Card Shelf — SillyTavern UI extension
 *
 * One window with tabs: Datacat, JanitorAI, Chub and RisuRealm.
 *  - JanitorAI lists Trending (24 hours and week), Popular and Latest; tap a bot, "ส่งไป Datacat"
 *    copies its link and switches to the Datacat tab, where Datacat builds the card and imports
 *    it (JanitorAI hides its definitions, Datacat knows how to get them).
 *  - Chub and RisuRealm publish their cards, so "นำเข้า" imports straight into SillyTavern:
 *    Chub through SillyTavern's own "Import from URL", RisuRealm by downloading the .charx
 *    (the only format it still serves for most cards) and handing it to SillyTavern's import.
 * Also lets you freeze or hide Datacat Browser's dancing top-bar cat.
 *
 * The Datacat tab is Datacat Browser's own window (its iframe and import bridge), placed
 * over the Card Shelf window; Card Shelf never talks to datacat.run itself.
 * JanitorAI can't be read from the browser directly (CORS), so its list goes through
 * SillyTavern's proxy. Chub and RisuRealm allow it, so they are read directly, with the
 * proxy only as a fallback.
 */

import { createDiagnostics } from './diagnostics.js';
import {
    cardIconPath, cardTextChunks, charxExtras, DEFAULT_SORTS, pngWithText, zipRead, dockBox, JANITOR_API, megabytes, risuDownloadUrl, risuLoreToBook, risuRegexToST, routedUrl,
    routeOrder, safeFileName, shortCount, dispositionName, SOURCE_IDS, SOURCES, usesRisuSyntax, zipLayout, zipOnly,
} from './lib.js';

const MODULE = 'card_shelf';
const VERSION = '2.3.5'; // keep in sync with manifest.json
const LOG = '[CardShelf]';
const DATACAT_REPO = 'https://github.com/datacat-run/datacat-sillytavern-browser';

const DEFAULTS = Object.freeze({
    datacatCat: 'animated', // animated | still | hidden — Datacat Browser's top-bar cat
    topbar: true,           // our own icon in the top bar (a still icon, never animated)
    tab: 'datacat',         // datacat | janitor | chub | risu — the tab Card Shelf opens on
    jtab: 'trending24',     // trending24 | trending | popular | latest — the JanitorAI list shown
    pick: { chub: 'trending', risu: 'trending' }, // the list shown in the other source tabs
    shown: { janitor: true, chub: true, risu: true }, // which source tabs are in the window
    closeAfterImport: true, // close Card Shelf when an imported bot's chat opens
    nsfw: true,             // include NSFW bots in the lists
    route: 'auto',          // auto | st | direct | custom — how the sites are reached
    proxy: '',              // custom proxy, {url} = the encoded site address
    api: JANITOR_API,       // JanitorAI (kept at the top level as in 2.2)
    sorts: DEFAULT_SORTS,
    chub: { api: SOURCES.chub.api, sorts: SOURCES.chub.sorts },
    risu: { api: SOURCES.risu.api, sorts: SOURCES.risu.sorts },
});

const LISTS = SOURCES.janitor.lists;
// Names used by 2.1 and earlier (and still accepted by /shelf).
const LIST_ALIASES = { ranking: 'popular', trending7: 'trending', week: 'trending', '24h': 'trending24' };
const TAB_ALIASES = { janitorai: 'janitor', jai: 'janitor', chubai: 'chub', characterhub: 'chub', risurealm: 'risu', realm: 'risu' };
const isSource = t => SOURCE_IDS.includes(t);

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? structuredClone(v) : v;
    }
    for (const src of ['chub', 'risu']) {
        const d = DEFAULTS[src];
        if (!s[src] || typeof s[src] !== 'object') s[src] = structuredClone(d);
        if (!s[src].api || (SOURCES[src].oldApis ?? []).includes(s[src].api)) s[src].api = d.api;
        s[src].sorts ??= {};
        for (const [k, v] of Object.entries(d.sorts)) if (s[src].sorts[k] === undefined || s[src].sorts[k] === null) s[src].sorts[k] = v;
        if (!SOURCES[src].lists.some(l => l[0] === s.pick[src])) s.pick[src] = SOURCES[src].lists[0][0];
    }
    for (const src of SOURCE_IDS) if (typeof s.shown[src] !== 'boolean') s.shown[src] = true;
    if (s.sorts.ranking !== undefined) { // 2.1's "Ranking" is now "Popular"
        if (s.sorts.ranking !== 'popular') s.sorts.popular = s.sorts.ranking;
        delete s.sorts.ranking;
    }
    for (const [k, v] of Object.entries(DEFAULT_SORTS)) if (!s.sorts[k]) s.sorts[k] = v;
    delete s.pages; // 2.0's frame buttons
    if (!isSource(s.tab)) s.tab = 'datacat';
    s.jtab = LIST_ALIASES[s.jtab] ?? s.jtab;
    if (!LISTS.some(l => l[0] === s.jtab)) s.jtab = DEFAULTS.jtab;
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

/** API and sort names of a source, from the settings. */
function conf(src) {
    const s = settings();
    return src === 'janitor' ? { api: s.api, sorts: s.sorts } : s[src];
}
const listOf = src => (src === 'janitor' ? settings().jtab : settings().pick[src]);
function setListOf(src, tab) {
    const s = settings();
    if (src === 'janitor') s.jtab = tab; else s.pick[src] = tab;
    saveSettings();
}
const shownSources = () => SOURCE_IDS.filter(src => settings().shown[src]);
const datacatReady = () => typeof window.datacatOpenBrowser === 'function';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const errText = e => String(e?.message ?? e);

// ---------------------------------------------------------------- Datacat's cat
//
// Datacat Browser puts an animated GIF in the top bar. A playing GIF repaints its corner of
// the top bar every frame, which some phones feel as stutter while a reply streams in.
// "still" swaps the GIF for its first frame, "hidden" hides the button with CSS. Neither
// removes Datacat's element, so Datacat's own watcher (which re-adds a missing button)
// stays quiet. Datacat stays reachable from Card Shelf and the wand menu → Explore.

const DC_IMG_SEL = '#datacat_browser_topbar_button img, #datacat_browser_wand img';

function applyDatacatCat() {
    const mode = settings().datacatCat;
    document.body.classList.toggle('cs_dc_hidden', mode === 'hidden');
    for (const img of document.querySelectorAll(DC_IMG_SEL)) {
        if (mode === 'still') freezeImage(img); else thawImage(img);
    }
}

function freezeImage(img) {
    if (img.dataset.csFrozen || img.dataset.csWaiting) return;
    const draw = () => {
        delete img.dataset.csWaiting;
        if (settings().datacatCat !== 'still' || img.dataset.csFrozen) return;
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            img.dataset.csOrig = img.src;
            img.dataset.csFrozen = '1';
            img.src = c.toDataURL('image/png');
        } catch (e) { console.warn(LOG, 'could not freeze Datacat icon', e); }
    };
    if (img.complete && img.naturalWidth) draw();
    else { img.dataset.csWaiting = '1'; img.addEventListener('load', draw, { once: true }); }
}

function thawImage(img) {
    if (!img.dataset.csFrozen) return;
    img.src = img.dataset.csOrig;
    delete img.dataset.csFrozen;
    delete img.dataset.csOrig;
}

/** Datacat may load after us: watch only the places it adds its buttons (no subtree). */
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

// ---------------------------------------------------------------- reaching the sites
//
// JanitorAI doesn't allow other sites to read it from the browser (CORS), so its requests go
// through SillyTavern's own CORS proxy (/proxy/, `enableCorsProxy: true` in config.yaml), or
// a proxy you choose. Chub and RisuRealm do allow it (`cors` in SOURCES): they are read
// directly first, and the proxy is only a fallback. The route that worked for a host is
// tried first next time.

const goodRoutes = new Map(); // host → route
const forgetRoutes = () => goodRoutes.clear();
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

class ReachError extends Error {
    constructor(attempts) {
        super(attempts.map(a => `${a.route}: ${a.status || ''} ${a.text}`.trim()).join(' · ') || 'no route');
        this.attempts = attempts;
    }
}

/** What a site said in a JSON error body ({ message } / { error }), if anything. */
function siteMessage(text) {
    try {
        const j = JSON.parse(text);
        const m = j?.message ?? j?.error;
        return typeof m === 'string' ? m : '';
    } catch { return ''; }
}

/**
 * Fetch url by each route in turn until `read(response)` succeeds; `read` throws to try the
 * next route. An abort stops at once.
 */
async function viaRoutes(url, read, { signal, accept = 'application/json', cors = false } = {}) {
    const s = settings();
    let order = routeOrder(s.route, s.proxy);
    if (cors) order = ['direct', ...order.filter(r => r !== 'direct')];
    const host = hostOf(url);
    const known = goodRoutes.get(host);
    if (known && order.includes(known)) order = [known, ...order.filter(r => r !== known)];
    const attempts = [];
    for (const route of order) {
        const target = routedUrl(url, route, s.proxy);
        if (!target) continue;
        let res;
        try {
            res = await fetch(target, { headers: { Accept: accept }, cache: 'no-store', referrerPolicy: 'no-referrer', signal });
        } catch (e) {
            if (signal?.aborted) throw e;
            attempts.push({ route, status: 0, text: errText(e) });
            continue;
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            attempts.push({ route, status: res.status, text: text.replace(/\s+/g, ' ').slice(0, 160), msg: siteMessage(text) });
            continue;
        }
        try {
            const out = await read(res);
            goodRoutes.set(host, route);
            return out;
        } catch (e) {
            if (signal?.aborted) throw e;
            attempts.push({ route, status: res.status, text: errText(e) });
        }
    }
    throw new ReachError(attempts);
}

const fetchJson = (url, opts) => viaRoutes(url, async res => {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(/cloudflare|challenge|<html/i.test(text) ? 'cloudflare' : 'not json');
    }
}, opts);

/** What went wrong, in words, with what to do about it. */
function explainReach(err, site = 'เว็บ') {
    const tips = [];
    for (const a of err?.attempts ?? []) {
        if (a.route === 'st' && a.status === 404 && /CORS proxy is disabled/i.test(a.text)) {
            tips.push('พร็อกซีของ SillyTavern ยังปิดอยู่ — เปิดไฟล์ <code>config.yaml</code> ตั้ง <code>enableCorsProxy: true</code> แล้วรีสตาร์ท SillyTavern');
        } else if (a.msg) {
            tips.push(`${esc(site)} ตอบว่า: ${esc(a.msg)} (${esc(a.status)})`);
        } else if (a.status === 403 || a.status === 503 || a.text === 'cloudflare') {
            tips.push(`${esc(site)} (Cloudflare) ไม่ยอมให้เครื่องที่รัน SillyTavern อ่าน (${esc(a.route)} ${a.status || ''}) — ลองใหม่ภายหลัง หรือใช้พร็อกซีอื่นในการตั้งค่า`);
        } else if (a.route === 'direct' && a.status === 0) {
            tips.push(`เบราว์เซอร์บล็อกการอ่าน ${esc(site)} ตรง ๆ (CORS) — ต้องผ่านพร็อกซี`);
        } else if (a.status === 429) {
            tips.push(`${esc(site)} ขอให้ช้าลง (429) — รอสักครู่แล้วลองใหม่`);
        } else {
            tips.push(`${esc(a.route)}: ${esc(a.status || '')} ${esc(a.text)}`);
        }
    }
    return [...new Set(tips)];
}

// ---------------------------------------------------------------- copying a link
//
// The clipboard API only exists on https or localhost; SillyTavern opened as
// http://192.168.x.x on a phone falls back to the old copy command.

async function copyText(text) {
    try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall back below */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
}

// ---------------------------------------------------------------- the window

const ui = {
    root: null,
    open: false,
    tab: 'datacat', // datacat or a source id
    docked: false,
    resize: null,
    searches: Object.fromEntries(SOURCE_IDS.map(src => [src, ''])),
    lists: {},      // listKey() → { src, tab, search, items, page, pages, done, loading, error }
    apiWorked: {},  // src → the API address that answered (a default's alternate, if it had to)
    observer: null,
    noteTimer: null,
    importing: null, // AbortController of the import in progress
};

const listKey = (src = ui.tab) => JSON.stringify([src, listOf(src), ui.searches[src], settings().nsfw, conf(src).api, conf(src).sorts[listOf(src)]]);
const itemKey = it => `${it.src}:${it.id}`;
const allItems = () => Object.values(ui.lists).flatMap(l => l.items);

function buildWindow() {
    const root = document.createElement('div');
    root.id = 'cs_root';
    root.className = 'cs_root';
    root.hidden = true;
    root.innerHTML = `
        <div class="cs_backdrop"></div>
        <section class="cs_panel" role="dialog" aria-modal="true" aria-label="Card Shelf">
            <header class="cs_head">
                <nav class="cs_tabs" role="tablist"></nav>
                <button class="cs_tool cs_close" title="ปิด (Esc)" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
            </header>
            <div class="cs_note" hidden></div>
            <div class="cs_jbar"></div>
            <form class="cs_searchrow">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" class="cs_search" autocomplete="off" spellcheck="false" enterkeyhint="search">
                <i class="fa-solid fa-circle-notch fa-spin cs_spin" hidden></i>
                <button type="button" class="cs_jreload" title="โหลดใหม่"><i class="fa-solid fa-rotate"></i></button>
                <button type="button" class="cs_jout"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </form>
            <div class="cs_body">
                <div class="cs_dock"></div>
                <div class="cs_nodc" hidden>
                    <i class="fa-solid fa-cat"></i>
                    <b>ยังไม่ได้ติดตั้ง Datacat SillyTavern Browser</b>
                    <span>แท็บนี้ใช้หน้าต่างของ Datacat ในการสร้างการ์ดและนำเข้า ติดตั้งจาก Extensions → Install extension แล้ววาง</span>
                    <code>${DATACAT_REPO}</code>
                </div>
                <div class="cs_list"></div>
                <div class="cs_sheet" hidden></div>
            </div>
        </section>`;
    document.body.append(root);

    const q = sel => root.querySelector(sel);
    q('.cs_backdrop').addEventListener('click', closeShelf);
    q('.cs_close').addEventListener('click', closeShelf);
    q('.cs_tabs').addEventListener('click', e => {
        const b = e.target.closest('button[data-tab]');
        if (b) showTab(b.dataset.tab, { remember: true });
    });
    q('.cs_jbar').addEventListener('click', e => {
        const b = e.target.closest('button[data-list]');
        if (!b || !isSource(ui.tab)) return;
        setListOf(ui.tab, b.dataset.list);
        renderList();
    });
    q('.cs_jreload').addEventListener('click', () => { delete ui.lists[listKey()]; forgetRoutes(); renderList(); });
    q('.cs_jout').addEventListener('click', () => {
        if (!isSource(ui.tab)) return;
        const src = SOURCES[ui.tab];
        window.open(src.siteUrl({ sort: conf(ui.tab).sorts[listOf(ui.tab)], search: ui.searches[ui.tab], nsfw: settings().nsfw }), '_blank', 'noopener');
    });
    q('.cs_searchrow').addEventListener('submit', e => {
        e.preventDefault();
        if (!isSource(ui.tab)) return;
        ui.searches[ui.tab] = q('.cs_search').value.trim();
        q('.cs_search').blur();
        renderList();
    });
    q('.cs_search').addEventListener('search', () => {
        if (isSource(ui.tab) && q('.cs_search').value === '' && ui.searches[ui.tab]) { ui.searches[ui.tab] = ''; renderList(); }
    });
    q('.cs_list').addEventListener('click', e => {
        const card = e.target.closest('.cs_card');
        const item = card && allItems().find(i => itemKey(i) === card.dataset.key);
        if (item) openSheet(item);
    });
    renderTabs();
    return root;
}

/** The tab buttons: Datacat, then each source that is switched on in the settings. */
function renderTabs() {
    const nav = ui.root?.querySelector('.cs_tabs');
    if (!nav) return;
    nav.innerHTML = [
        '<button data-tab="datacat" role="tab" title="Datacat"><i class="fa-solid fa-cat"></i><span>Datacat</span></button>',
        ...shownSources().map(src => `<button data-tab="${src}" role="tab" title="${esc(SOURCES[src].name)}"><i class="fa-solid ${SOURCES[src].icon}"></i><span>${esc(SOURCES[src].short)}</span></button>`),
    ].join('');
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('cs_on', b.dataset.tab === ui.tab);
}

/** Turn "/shelf …" words into a tab (and maybe a list): risu, chub downloads, trending24 … */
function parseTarget(arg) {
    const words = String(arg ?? '').toLowerCase().split(/[\s:/]+/).filter(Boolean);
    let tab, list;
    for (const w0 of words) {
        const w = TAB_ALIASES[w0] ?? w0;
        if (w === 'datacat' || isSource(w)) { tab = w; continue; }
        const jl = LIST_ALIASES[w] ?? w;
        const src = tab && isSource(tab) ? tab : 'janitor';
        if (SOURCES[src].lists.some(l => l[0] === jl)) { tab = src; list = jl; }
    }
    return { tab, list };
}

function openShelf(target) {
    if (!ui.root) ui.root = buildWindow();
    const s = settings();
    ui.root.hidden = false;
    ui.open = true;
    DIAG.noteOpen(String(target ?? ''));
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => ui.root?.classList.add('cs_in'));
    const { tab, list } = parseTarget(target);
    try {
        if (tab && list) setListOf(tab, list);
        showTab(tab ?? s.tab);
    } catch (err) {
        DIAG.reportError('วาด Card Shelf ไม่ได้', err);
    }
}

function closeShelf() {
    if (!ui.open) return;
    DIAG.noteClose();
    ui.open = false;
    undockDatacat();
    closeSheet();
    document.removeEventListener('keydown', onKey, true);
    ui.root.classList.remove('cs_in');
    ui.root.hidden = true; // kept, so the list stays where you left it
}

function onKey(e) {
    if (e.key !== 'Escape' || !ui.open) return;
    e.stopPropagation();
    if (!ui.root.querySelector('.cs_sheet').hidden) closeSheet(); else closeShelf();
}

function showTab(tab, { remember = false } = {}) {
    // a source tab that was switched off falls back to Datacat
    ui.tab = isSource(tab) && settings().shown[tab] ? tab : 'datacat';
    if (remember) { settings().tab = ui.tab; saveSettings(); }
    const root = ui.root;
    renderTabs();
    const list = isSource(ui.tab);
    root.classList.toggle('cs_tab_list', list);
    root.classList.toggle('cs_tab_datacat', !list);
    root.dataset.src = list ? ui.tab : '';
    if (list) {
        undockDatacat();
        renderBar();
        renderList({ keep: true });
    } else {
        closeSheet();
        dockDatacat();
    }
}

/** The list buttons, search hint and site button of the current source tab. */
function renderBar() {
    const src = SOURCES[ui.tab];
    const q = sel => ui.root.querySelector(sel);
    const bar = q('.cs_jbar');
    if (bar.dataset.src !== src.id) {
        bar.dataset.src = src.id;
        bar.innerHTML = src.lists.map(([id, icon, label, title]) => `<button data-list="${id}" title="${esc(title)}"><i class="fa-solid ${icon}"></i><span>${esc(label)}</span></button>`).join('');
    }
    q('.cs_search').placeholder = `ค้นหาบอทบน ${src.name}`;
    q('.cs_jout').title = `เปิดหน้านี้บนเว็บ ${src.name}`;
}

/** A short message under the tabs (never covered by Datacat's window). */
function note(html, ms = 6000) {
    const el = ui.root?.querySelector('.cs_note');
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(ui.noteTimer);
    ui.noteTimer = setTimeout(() => {
        el.hidden = true;
        placeDock();
    }, ms);
    placeDock();
}

function setBusy(on) {
    const spin = ui.root?.querySelector('.cs_spin');
    if (spin) spin.hidden = !on;
}

// ---------------------------------------------------------------- lists

/**
 * One page of a source's list. A source whose default API has another address (Chub's
 * gateway / api) tries that one too, and keeps whichever answered.
 */
async function fetchPage(srcId, { tab, page, search }) {
    const src = SOURCES[srcId];
    const c = conf(srcId);
    const apis = [...new Set([ui.apiWorked[srcId] ?? c.api, c.api, ...(c.api === src.api ? src.apiAlternates ?? [] : [])])];
    let last;
    for (const api of apis) {
        try {
            const sort = c.sorts[tab];
            const url = src.listUrl({ api, sort, page, search, nsfw: settings().nsfw });
            const json = await fetchJson(url, { cors: !!src.cors });
            const r = src.normalize(json, page, { sort, search });
            ui.apiWorked[srcId] = api;
            return { ...r, json, route: goodRoutes.get(hostOf(url)) };
        } catch (e) {
            last = e;
            if (!(e instanceof ReachError)) throw e;
        }
    }
    throw last;
}

function renderList({ keep = false } = {}) {
    if (!ui.root || !isSource(ui.tab)) return;
    const src = ui.tab;
    const q = sel => ui.root.querySelector(sel);
    for (const b of ui.root.querySelectorAll('.cs_jbar button[data-list]')) b.classList.toggle('cs_on', b.dataset.list === listOf(src));
    q('.cs_search').value = ui.searches[src];
    const box = q('.cs_list');
    const key = listKey(src);
    // Coming back to the tab: leave the list (and the scroll position) as it was.
    if (keep && box.dataset.key === key && box.childElementCount) return;
    closeSheet();
    ui.observer?.disconnect();
    box.dataset.key = key;
    box.scrollTop = 0;
    const list = ui.lists[key] ??= { src, tab: listOf(src), search: ui.searches[src], items: [], page: 0, pages: 0, done: false, loading: false, error: null };
    box.innerHTML = `
        ${list.search ? `<div class="cs_listnote">ผลค้นหา “${esc(list.search)}”</div>` : ''}
        <div class="cs_grid" role="list"></div>
        <div class="cs_more"></div>`;
    appendCards(box.querySelector('.cs_grid'), list.items, 0, list);
    updateMore(list);
    ui.observer = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) loadMore(key);
    }, { root: box, rootMargin: '600px 0px' });
    ui.observer.observe(box.querySelector('.cs_more'));
    if (!list.items.length && !list.loading && !list.error) loadMore(key);
}

async function loadMore(key) {
    const list = ui.lists[key];
    if (!list || list.loading || list.done || list.error) return;
    list.loading = true;
    setBusy(true);
    refreshMore(key);
    try {
        const page = list.page + 1;
        const r = await fetchPage(list.src, { tab: list.tab, page, search: list.search });
        const seen = new Set(list.items.map(itemKey));
        const fresh = r.items.map(it => ({ ...it, src: list.src })).filter(it => !seen.has(itemKey(it)));
        const start = list.items.length;
        list.items.push(...fresh);
        list.page = page;
        list.pages = r.pages;
        list.done = !fresh.length || Boolean(r.pages && page >= r.pages);
        if (!r.items.length && page === 1 && !list.search) list.empty = JSON.stringify(r.json ?? '').slice(0, 200);
        if (isShown(key)) appendCards(ui.root.querySelector('.cs_grid'), fresh, start, list);
    } catch (e) {
        console.warn(LOG, 'list', e);
        list.error = e;
    } finally {
        list.loading = false;
        setBusy(false);
        refreshMore(key);
    }
}

const isShown = key => ui.root?.querySelector('.cs_list')?.dataset.key === key;

function refreshMore(key) {
    if (!isShown(key)) return;
    updateMore(ui.lists[key]);
    // The observer only reports changes: if the end of the list is still on screen after a
    // page arrived, observe again so it reports "visible" once more and the next page loads.
    const more = ui.root.querySelector('.cs_more');
    if (more && ui.observer && !ui.lists[key].loading) { ui.observer.unobserve(more); ui.observer.observe(more); }
}

function updateMore(list) {
    const more = ui.root?.querySelector('.cs_more');
    if (!more) return;
    const name = SOURCES[list.src].name;
    if (list.error) {
        const tips = list.error instanceof ReachError ? explainReach(list.error, name) : [esc(errText(list.error))];
        const datacatHint = SOURCES[list.src].importer === 'datacat' ? '<small>เปิดบนเว็บแล้วคัดลอกลิงก์บอทจากตรงนั้น มาวางในแท็บ Datacat ได้เหมือนกัน</small>' : '';
        more.innerHTML = `
            <div class="cs_error">
                <b><i class="fa-solid fa-triangle-exclamation"></i> อ่านรายชื่อจาก ${esc(name)} ไม่ได้</b>
                <ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>
                <div class="cs_row">
                    <button class="menu_button cs_retry"><i class="fa-solid fa-rotate"></i> ลองใหม่</button>
                    <button class="menu_button cs_opensite"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดบนเว็บ ${esc(name)}</button>
                </div>
                ${datacatHint}
            </div>`;
        more.querySelector('.cs_retry').addEventListener('click', () => { list.error = null; forgetRoutes(); updateMore(list); loadMore(listKey(list.src)); });
        more.querySelector('.cs_opensite').addEventListener('click', () => ui.root.querySelector('.cs_jout').click());
    } else if (list.loading) {
        more.innerHTML = '<div class="cs_loading"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังโหลด…</div>';
    } else if (list.done) {
        more.innerHTML = list.items.length ? '<div class="cs_end">หมดแล้ว</div>'
            : list.empty ? `<div class="cs_end">ต่อ ${esc(name)} ได้ แต่ไม่พบรายชื่อบอทในคำตอบ — เว็บอาจเปลี่ยนรูปแบบ ลองแก้ API ในการตั้งค่า<br><code>${esc(list.empty)}</code></div>`
                : '<div class="cs_end">ไม่พบบอท</div>';
    } else {
        more.innerHTML = '<button class="menu_button cs_loadmore">โหลดเพิ่ม</button>';
        more.querySelector('.cs_loadmore').addEventListener('click', () => loadMore(listKey(list.src)));
    }
}

/** The main number under a card: chats where the site counts them, else downloads, else stars. */
function mainStat(it) {
    if (it.chats) return ['fa-comments', it.chats];
    if (it.downloads) return ['fa-download', it.downloads];
    if (it.stars) return ['fa-star', it.stars];
    return null;
}

function appendCards(grid, items, start, list) {
    if (!grid || !items.length) return;
    const ranked = SOURCES[list.src].ranked(list.tab) && !list.search;
    grid.insertAdjacentHTML('beforeend', items.map((it, i) => {
        const stat = mainStat(it);
        return `
        <button class="cs_card" role="listitem" data-key="${esc(itemKey(it))}">
            <span class="cs_cover">
                ${it.avatar ? `<img src="${esc(it.avatar)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-user"></i>'}
                ${ranked ? `<span class="cs_rank">${start + i + 1}</span>` : ''}
                ${it.nsfw ? '<span class="cs_nsfw">NSFW</span>' : ''}
            </span>
            <span class="cs_cname">${esc(it.name)}</span>
            <span class="cs_meta">${stat ? `<i class="fa-solid ${stat[0]}"></i> ${shortCount(stat[1])}` : ''}${it.creator ? `${stat ? ' · ' : ''}@${esc(it.creator)}` : ''}</span>
            <span class="cs_tags">${it.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}</span>
        </button>`;
    }).join(''));
}

// ---------------------------------------------------------------- bot sheet

const BADGES = {
    lorebook: ['fa-book', 'มีลอร์บุ๊ค'],
    emotion: ['fa-face-smile', 'มีรูปอีโมชัน'],
    assets: ['fa-images', 'มีไฟล์ประกอบ'],
};

function openSheet(item) {
    const sheet = ui.root?.querySelector('.cs_sheet');
    if (!sheet) return;
    const src = SOURCES[item.src];
    const viaDatacat = src.importer === 'datacat';
    sheet.hidden = false;
    sheet.innerHTML = `
        <div class="cs_sheetbar">
            <button class="cs_tool cs_back" title="กลับ"><i class="fa-solid fa-arrow-left"></i></button>
            <b>${esc(item.name)}</b>
        </div>
        <div class="cs_sheetbody">
            <div class="cs_hero">
                ${item.avatar ? `<img src="${esc(item.avatar.replace(/\?width=\d+$/, '?width=600'))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}
                <div class="cs_herotext">
                    <h3>${esc(item.name)}</h3>
                    ${item.creator ? `<div class="cs_by">โดย @${esc(item.creator)}</div>` : ''}
                    <div class="cs_stats">
                        ${item.chats ? `<span><i class="fa-solid fa-comments"></i> ${shortCount(item.chats)} แชท</span>` : ''}
                        ${item.messages ? `<span><i class="fa-solid fa-message"></i> ${shortCount(item.messages)} ข้อความ</span>` : ''}
                        ${item.downloads ? `<span><i class="fa-solid fa-download"></i> ${shortCount(item.downloads)} ดาวน์โหลด</span>` : ''}
                        ${item.stars ? `<span><i class="fa-solid fa-star"></i> ${shortCount(item.stars)}</span>` : ''}
                        ${(item.badges ?? []).filter(b => BADGES[b]).map(b => `<span><i class="fa-solid ${BADGES[b][0]}"></i> ${BADGES[b][1]}</span>`).join('')}
                        ${item.nsfw ? '<span class="cs_nsfw">NSFW</span>' : ''}
                    </div>
                    ${item.license ? `<div class="cs_by">สัญญาอนุญาต: ${esc(item.license)}</div>` : ''}
                    <div class="cs_tags cs_tagsfull">${item.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
                </div>
            </div>
            <div class="cs_actions">
                ${viaDatacat
        ? '<button class="menu_button cs_send"><i class="fa-solid fa-cat"></i> ส่งไป Datacat</button>'
        : '<button class="menu_button cs_import"><i class="fa-solid fa-file-import"></i> นำเข้า</button>'}
                <button class="menu_button cs_copy"><i class="fa-regular fa-copy"></i> คัดลอกลิงก์</button>
                <button class="menu_button cs_openpage"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดใน ${esc(src.name)}</button>
            </div>
            <div class="cs_istatus" hidden></div>
            <label class="cs_linkrow" hidden>คัดลอกเองจากช่องนี้ได้<input type="text" class="text_pole cs_link" readonly value="${esc(item.url)}"></label>
            ${item.description ? `<div class="cs_desc">${esc(item.description)}</div>` : ''}
        </div>`;
    const q = sel => sheet.querySelector(sel);
    const showLink = () => {
        q('.cs_linkrow').hidden = false;
        q('.cs_link').focus();
        q('.cs_link').select();
    };
    q('.cs_back').addEventListener('click', closeSheet);
    q('.cs_openpage').addEventListener('click', () => window.open(item.url, '_blank', 'noopener'));
    q('.cs_copy').addEventListener('click', async () => {
        if (await copyText(item.url)) note(`<i class="fa-solid fa-check"></i> คัดลอกลิงก์ ${esc(item.name)} แล้ว`, 3000);
        else showLink();
    });
    q('.cs_send')?.addEventListener('click', async () => {
        if (!(await copyText(item.url))) { showLink(); return; }
        showTab('datacat', { remember: false });
        note(`<i class="fa-regular fa-clipboard"></i> คัดลอกลิงก์ <b>${esc(item.name)}</b> แล้ว — วางลงในช่องของ Datacat ได้เลย`);
    });
    q('.cs_import')?.addEventListener('click', () => importItem(item, sheet));
}

function closeSheet() {
    const sheet = ui.root?.querySelector('.cs_sheet');
    if (!sheet || sheet.hidden) return;
    ui.importing?.abort();
    sheet.hidden = true;
    sheet.innerHTML = '';
}

// ---------------------------------------------------------------- importing into SillyTavern
//
// Chub: SillyTavern's own "Import from URL" downloads the card on the server and hands back
// the file. RisuRealm: its own importer in SillyTavern asks for a PNG, which RisuRealm no
// longer serves for most cards, so Card Shelf downloads the .charx through the proxy instead.
// Either way the file then goes through SillyTavern's character import (the same one as the
// import button), and the new character's chat is opened.

function requestHeaders({ json = true } = {}) {
    const h = { ...(ctx().getRequestHeaders?.() ?? {}) };
    if (!json) delete h['Content-Type'];
    return h;
}

/** SillyTavern's "Import from URL": the server fetches the card and returns the file. */
async function fileFromStImporter(url, signal) {
    const res = await fetch('/api/content/importURL', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ url }),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SillyTavern ดึงการ์ดไม่ได้ (${res.status}${text ? `: ${text.slice(0, 160)}` : ''})`);
    }
    const kind = res.headers.get('X-Custom-Content-Type');
    if (kind && kind !== 'character') throw new Error(`ลิงก์นี้เป็น ${kind} ไม่ใช่ตัวละคร`);
    const blob = await res.blob();
    const name = dispositionName(res.headers.get('Content-Disposition')) || safeFileName('character', blob.type.includes('json') ? 'json' : 'png');
    return new File([blob], name, { type: blob.type });
}

/**
 * Download a RisuRealm card, reporting bytes (and the total, when known) as they arrive.
 * Read directly (the download allows any site); through the proxy only as a fallback, which
 * passes no headers on, so the kind of file is told by its first bytes.
 */
async function fileFromRisu(item, signal, onBytes) {
    const { blob, kind } = await viaRoutes(risuDownloadUrl(item.id), async res => {
        const total = Number(res.headers.get('Content-Length')) || 0;
        const reader = res.body?.getReader?.();
        const chunks = [];
        let got = 0;
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!chunks.length && value[0] === 0x3c) { // "<": a web page, not a card
                    reader.cancel().catch(() => {});
                    throw new Error('cloudflare');
                }
                chunks.push(value);
                got += value.length;
                onBytes(got, total);
            }
        } else {
            chunks.push(new Uint8Array(await res.arrayBuffer()));
        }
        const head = chunks[0] ?? new Uint8Array();
        const blob = new Blob(chunks);
        let kind = head[0] === 0x50 && head[1] === 0x4b ? 'charx'          // "PK": a zip
            : head[0] === 0x89 && head[1] === 0x50 ? 'png'
                : head[0] === 0x7b ? 'json' : '';
        // a JPEG cover with the .charx zip stuck on its end
        if (!kind && head[0] === 0xff && head[1] === 0xd8 && zipLayout(new Uint8Array(await blob.arrayBuffer()))) kind = 'charx';
        if (!kind) throw new Error('not a card');
        return { blob, kind };
    }, { signal, accept: 'application/charx, application/zip, image/png, application/json, */*', cors: true });
    if (kind === 'json') { // { card, img }: the card without its picture
        const data = JSON.parse(await blob.text());
        const card = data?.card ?? data;
        return { file: new File([JSON.stringify(card)], safeFileName(item.name, 'json'), { type: 'application/json' }) };
    }
    if (kind === 'png') return { file: new File([blob], safeFileName(item.name, 'png'), { type: 'image/png' }) };
    // .charx: keep what SillyTavern leaves out (module.risum), and cut off a JPEG cover in front
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const extras = await charxExtras(bytes).catch(e => { console.warn(LOG, 'charx extras', e); return null; });
    return { file: new File([zipOnly(bytes)], safeFileName(item.name, 'charx'), { type: 'application/zip' }), extras, bytes };
}

/** Any image the browser can show (WebP, JPEG, PNG …) → PNG bytes. No image → a plain grey card. */
async function imageToPng(bytes) {
    let source = null;
    if (bytes?.length) {
        try {
            source = await createImageBitmap(new Blob([bytes]));
        } catch {
            const url = URL.createObjectURL(new Blob([bytes]));
            try {
                source = await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = url;
                });
            } catch { source = null; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
        }
    }
    const canvas = document.createElement('canvas');
    canvas.width = source?.width || 400;
    canvas.height = source?.height || 600;
    const g = canvas.getContext('2d');
    if (source) g.drawImage(source, 0, 0);
    else { g.fillStyle = '#777'; g.fillRect(0, 0, canvas.width, canvas.height); }
    source?.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('สร้างรูป PNG ไม่ได้');
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A .charx turned into an ordinary PNG card: its icon as a PNG, card.json in the text chunks.
 * For when SillyTavern won't take the .charx itself (the emotion images in it are left out).
 */
async function charxToPngFile(bytes, name) {
    const raw = await zipRead(bytes, 'card.json');
    if (!raw) throw new Error('ไม่พบ card.json ในไฟล์ .charx');
    const card = JSON.parse(new TextDecoder().decode(raw));
    const iconPath = cardIconPath(card);
    const icon = iconPath ? await zipRead(bytes, iconPath).catch(() => null) : null;
    const png = pngWithText(await imageToPng(icon), cardTextChunks(card));
    return new File([png], safeFileName(name, 'png'), { type: 'image/png' });
}

/**
 * After a RisuRealm import: give the character the regex scripts (from the card and from its
 * module) and, when the card itself has none, the module's lorebook. Returns what was added
 * and whether the card leans on RisuAI-only features.
 */
async function addRisuExtras(avatar, extras) {
    await ctx().getCharacters?.();
    const ch = ctx().characters.find(c => c.avatar === avatar);
    if (!ch) return null;
    const ext = ch.data?.extensions ?? {};
    const regex = risuRegexToST([...(ext.risuai?.customScripts ?? []), ...(extras?.regex ?? [])]);
    const data = {};
    if (regex.length && !ext.regex_scripts?.length) data.extensions = { regex_scripts: regex };
    const lore = extras?.lorebook ?? [];
    if (lore.length && !ch.data?.character_book?.entries?.length) data.character_book = risuLoreToBook(lore, ch.name);
    if (Object.keys(data).length) {
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ avatar, data }),
        });
        if (!res.ok) {
            console.warn(LOG, 'merge-attributes', res.status, await res.text().catch(() => ''));
            return { failed: true };
        }
    }
    const texts = [ch.first_mes, ch.data?.first_mes, ...(ch.data?.alternate_greetings ?? []), ch.description, ...regex.map(r => r.replaceString)];
    return {
        regex: data.extensions ? regex.filter(r => !r.disabled).length : 0,
        lore: data.character_book ? data.character_book.entries.length : 0,
        risuOnly: texts.some(usesRisuSyntax) || (extras?.triggers ?? 0) > 0,
    };
}

/** SillyTavern's character import. Returns the new character's avatar file name. */
async function importFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', ext);
    form.append('user_name', ctx().name1 ?? '');
    const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers: requestHeaders({ json: false }), cache: 'no-cache' });
    if (!res.ok) throw new Error(`SillyTavern นำเข้าไม่ได้ (${res.status} ${res.statusText})`);
    const data = await res.json().catch(() => ({}));
    if (data.error || !data.file_name) {
        throw new Error(ext === 'charx'
            ? 'SillyTavern นำเข้าไฟล์ .charx ไม่ได้ — SillyTavern อาจเก่าเกินไป (อัปเดตให้รองรับ CharX) หรือไฟล์เสีย'
            : 'SillyTavern นำเข้าการ์ดนี้ไม่ได้ (ไฟล์อาจเสีย)');
    }
    return `${data.file_name}.png`;
}

/** Refresh the character list and open the chat of the given avatar. */
async function openCharacter(avatar) {
    const c = ctx();
    await c.getCharacters?.();
    const index = ctx().characters.findIndex(ch => ch.avatar === avatar);
    if (index < 0 || typeof c.selectCharacterById !== 'function') return false;
    if (settings().closeAfterImport) closeShelf();
    await c.selectCharacterById(index);
    return true;
}

async function importItem(item, sheet) {
    if (ui.importing) return;
    const src = SOURCES[item.src];
    const btn = sheet.querySelector('.cs_import');
    const box = sheet.querySelector('.cs_istatus');
    const say = (html, cls = '') => {
        if (!box.isConnected) return;
        box.hidden = false;
        box.className = `cs_istatus ${cls}`;
        box.innerHTML = html;
    };
    const ctl = new AbortController();
    ui.importing = ctl;
    btn.disabled = true;
    const cancel = '<button class="menu_button cs_cancel"><i class="fa-solid fa-xmark"></i> ยกเลิก</button>';
    const wireCancel = () => box.querySelector('.cs_cancel')?.addEventListener('click', () => ctl.abort());
    try {
        let file;
        let extras = null;
        let charxBytes = null;
        let asPng = false;
        if (src.importer === 'charx') {
            say(`<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังดาวน์โหลดการ์ดจาก ${esc(src.name)}… <b class="cs_bytes"></b> ${cancel}<small>RisuRealm ส่งการ์ดเป็นไฟล์ .charx รวมรูปอีโมชันมาด้วย บางใบใหญ่หลายสิบ MB</small>`);
            wireCancel();
            let last = 0;
            ({ file, extras, bytes: charxBytes } = await fileFromRisu(item, ctl.signal, (got, total) => {
                if (Date.now() - last < 250) return;
                last = Date.now();
                const span = box.querySelector('.cs_bytes');
                if (span) span.textContent = total ? `${megabytes(got)} / ${megabytes(total)} (${Math.floor((got / total) * 100)}%)` : megabytes(got);
            }));
        } else {
            say(`<i class="fa-solid fa-circle-notch fa-spin"></i> SillyTavern กำลังดึงการ์ดจาก ${esc(src.name)}… ${cancel}`);
            wireCancel();
            file = await fileFromStImporter(item.url, ctl.signal);
        }
        say(`<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังนำเข้า ${esc(item.name)} (${megabytes(file.size)})…`);
        let avatar;
        try {
            avatar = await importFile(file);
        } catch (e) {
            if (!charxBytes) throw e;
            // SillyTavern refused the .charx: build a PNG card from it and try that
            console.warn(LOG, 'charx import failed, trying a PNG card', e);
            say(`<i class="fa-solid fa-circle-notch fa-spin"></i> SillyTavern ไม่รับไฟล์ .charx นี้ — ลองนำเข้าแบบการ์ด PNG…`);
            try {
                avatar = await importFile(await charxToPngFile(charxBytes, item.name));
                asPng = true;
            } catch (e2) {
                throw new Error(`${errText(e)} · แบบ PNG: ${errText(e2)}`);
            }
        }
        charxBytes = null;
        globalThis.toastr?.success(`นำเข้า ${esc(item.name)} แล้ว`, 'Card Shelf');
        if (src.importer === 'charx') {
            const added = await addRisuExtras(avatar, extras).catch(e => { console.warn(LOG, 'risu extras', e); return { failed: true }; });
            const lines = [];
            if (asPng) lines.push('SillyTavern ไม่รับไฟล์ .charx นี้ จึงนำเข้าเป็นการ์ด PNG แทน (รูปอีโมชันในไฟล์จะไม่มา)');
            if (added?.regex) lines.push(`เพิ่ม regex ของการ์ด ${added.regex} ตัว — SillyTavern จะถามให้อนุญาตตอนเปิดแชท`);
            if (added?.lore) lines.push(`เพิ่มลอร์บุ๊คจาก module ${added.lore} รายการ`);
            if (added?.failed) lines.push('เพิ่ม regex / ลอร์บุ๊คจาก module ของ RisuAI ไม่สำเร็จ');
            if (added?.risuOnly) lines.push('การ์ดนี้ทำมาสำหรับ RisuAI: ใช้คำสั่งเทมเพลต ({{#when…}}) หรือ Lua trigger ที่ SillyTavern ไม่รองรับ บางส่วนจะเป็นข้อความดิบ');
            if (lines.length) globalThis.toastr?.info(lines.map(esc).join('<br>'), 'Card Shelf', { timeOut: 15000, extendedTimeOut: 5000, escapeHtml: false });
        }
        say(`<i class="fa-solid fa-check"></i> นำเข้าแล้ว — เปิดแชท…`, 'cs_good');
        if (!(await openCharacter(avatar))) say('<i class="fa-solid fa-check"></i> นำเข้าแล้ว — เปิดจากรายชื่อตัวละครได้เลย', 'cs_good');
    } catch (e) {
        if (ctl.signal.aborted) {
            say('ยกเลิกแล้ว');
        } else {
            console.warn(LOG, 'import', e);
            const tips = e instanceof ReachError ? explainReach(e, src.name) : [esc(errText(e))];
            say(`<b><i class="fa-solid fa-triangle-exclamation"></i> นำเข้าไม่ได้</b><ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul><small>ดาวน์โหลดจากหน้าเว็บ (ปุ่ม “เปิดใน ${esc(src.name)}”) แล้วนำเข้าด้วยปุ่มนำเข้าของ SillyTavern ได้เหมือนกัน</small>`, 'cs_bad');
        }
    } finally {
        if (ui.importing === ctl) ui.importing = null;
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------- Datacat inside the window
//
// Datacat Browser keeps its iframe in a fixed layer of its own (so the page inside never
// reloads). Card Shelf asks Datacat to show that layer, then moves the layer over the empty
// area of the Datacat tab with a body class and four CSS variables. Hiding goes through
// Datacat's own "park" event. When Datacat finishes an import it closes its view and fires
// datacat-reskin:close-main-view — Card Shelf closes with it, and the new chat is on screen.

function placeDock() {
    if (!ui.docked || !ui.root) return;
    const dock = ui.root.querySelector('.cs_dock');
    const box = dockBox(dock.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    const st = document.body.style;
    if (!box) return;
    st.setProperty('--cs-dock-left', `${box.left}px`);
    st.setProperty('--cs-dock-top', `${box.top}px`);
    st.setProperty('--cs-dock-width', `${box.width}px`);
    st.setProperty('--cs-dock-height', `${box.height}px`);
}

function dockDatacat() {
    const missing = !datacatReady();
    ui.root.querySelector('.cs_nodc').hidden = !missing;
    ui.root.querySelector('.cs_dock').hidden = missing;
    if (missing) return;
    ui.docked = true;
    placeDock();
    document.body.classList.add('cs_dc_docked');
    try {
        window.datacatOpenBrowser();
    } catch (e) {
        console.warn(LOG, 'Datacat did not open', e);
    }
    if (!ui.resize) {
        const dock = ui.root.querySelector('.cs_dock');
        ui.resize = new ResizeObserver(() => placeDock());
        ui.resize.observe(dock);
        window.addEventListener('resize', placeDock);
    }
}

function undockDatacat() {
    if (!ui.docked) return;
    ui.docked = false;
    window.dispatchEvent(new Event('datacat-browser:park-main-view'));
    document.body.classList.remove('cs_dc_docked');
    ui.resize?.disconnect();
    ui.resize = null;
    window.removeEventListener('resize', placeDock);
}

// Datacat closed its own view: after an import (the chat is open now) or its close button.
window.addEventListener('datacat-reskin:close-main-view', () => {
    if (!ui.open || ui.tab !== 'datacat') return;
    ui.docked = false; // already hidden by Datacat
    document.body.classList.remove('cs_dc_docked');
    if (settings().closeAfterImport) closeShelf();
    else showTab('datacat');
});

// ---------------------------------------------------------------- launchers & settings

function renderTopbar() {
    let el = document.getElementById('cs_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'cs_topbar';
    el.className = 'drawer';
    el.innerHTML = '<div class="drawer-toggle"><div class="drawer-icon fa-regular fa-compass interactable cs_ticon" title="Card Shelf — Datacat / JanitorAI / Chub / RisuRealm" tabindex="0"></div></div>';
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); ui.open ? closeShelf() : openShelf(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openShelf(); });
}

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cs_wand')) return;
    const item = document.createElement('div');
    item.id = 'cs_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-regular fa-compass extensionsMenuExtensionButton"></div><span>Card Shelf</span>';
    item.addEventListener('click', () => openShelf());
    menu.append(item);
}

function renderSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('cs_settings')) return;
    const s = settings();
    const radio = (value, label) => `<label class="checkbox_label"><input type="radio" name="cs_datacatCat" value="${value}"${s.datacatCat === value ? ' checked' : ''}> ${label}</label>`;
    const how = {
        datacat: 'ส่งลิงก์ให้ Datacat สร้างการ์ด',
        'st-url': 'นำเข้าตรงด้วยระบบของ SillyTavern',
        charx: 'ดาวน์โหลดไฟล์ .charx แล้วนำเข้าด้วยระบบของ SillyTavern',
    };
    const sourceAdv = src => `
                    <h4 class="cs_sethead">${esc(SOURCES[src].name)}</h4>
                    <label class="cs_field">API<input type="text" class="text_pole" data-api="${src}"></label>
                    <div class="cs_sorts">
                        ${SOURCES[src].lists.map(([id, , , title]) => `<label class="cs_field">${esc(title)}<input type="text" class="text_pole" data-src="${src}" data-sort="${id}"></label>`).join('')}
                    </div>`;
    host.insertAdjacentHTML('beforeend', `
    <div id="cs_settings" class="cs_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Card Shelf <small class="cs_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${versionLineHtml()}
                <div class="cs_row"><div id="cs_set_open" class="menu_button"><i class="fa-regular fa-compass"></i> เปิด Card Shelf</div></div>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_topbar"> ไอคอนเข็มทิศบนแถบด้านบน (ไอคอนนิ่ง ไม่มีแอนิเมชัน)</label>
                <h4 class="cs_sethead">แท็บ</h4>
                ${SOURCE_IDS.map(src => `<label class="checkbox_label"><input type="checkbox" data-shown="${src}"> ${esc(SOURCES[src].name)} <small>— ${how[SOURCES[src].importer]}</small></label>`).join('')}
                <label class="cs_field">เปิดมาที่แท็บ
                    <select id="cs_set_tab" class="text_pole">
                        <option value="datacat">Datacat</option>
                        ${SOURCE_IDS.map(src => `<option value="${src}">${esc(SOURCES[src].name)}</option>`).join('')}
                    </select>
                </label>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_close"> ปิด Card Shelf เมื่อนำเข้าเสร็จและเปิดแชทแล้ว</label>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_nsfw"> แสดงบอท NSFW ในรายชื่อ</label>
                <small id="cs_set_nodc" class="cs_setnote cs_warn" hidden>ยังไม่พบ Datacat SillyTavern Browser — แท็บ Datacat (และปุ่มส่งไป Datacat ของ JanitorAI) ต้องใช้ส่วนขยายนี้: <code>${DATACAT_REPO}</code></small>

                <h4 class="cs_sethead">แมว Datacat บนแถบด้านบน</h4>
                <div class="cs_radios">
                    ${radio('animated', 'เต้นตามปกติ')}
                    ${radio('still', 'หยุดนิ่ง (เป็นรูปนิ่ง กดเปิดได้เหมือนเดิม)')}
                    ${radio('hidden', 'ซ่อน (เปิด Datacat จาก Card Shelf หรือเมนูไม้กายสิทธิ์ → Explore)')}
                </div>
                <small class="cs_setnote">ถ้าจอกระตุกตอนบอทตอบ ลอง “หยุดนิ่ง” หรือ “ซ่อน”</small>

                <details class="cs_adv">
                    <summary>การเชื่อมต่อ (JanitorAI / Chub / RisuRealm)</summary>
                    <small class="cs_setnote">JanitorAI ต้องอ่านผ่านพร็อกซีของ SillyTavern: ใน <code>config.yaml</code> ตั้ง <code>enableCorsProxy: true</code> แล้วรีสตาร์ท SillyTavern · Chub กับ RisuRealm อ่านตรงได้ ใช้พร็อกซีเป็นทางสำรองเท่านั้น</small>
                    <label class="cs_field">เส้นทาง
                        <select id="cs_set_route" class="text_pole">
                            <option value="auto">อัตโนมัติ (พร็อกซี ST → พร็อกซีที่ตั้งไว้ → ตรง)</option>
                            <option value="st">พร็อกซีของ SillyTavern (/proxy/)</option>
                            <option value="custom">พร็อกซีที่ตั้งเอง</option>
                            <option value="direct">ตรงจากเบราว์เซอร์</option>
                        </select>
                    </label>
                    <label class="cs_field">พร็อกซีที่ตั้งเอง <small>(<code>{url}</code> = ที่อยู่ของเว็บ · พร็อกซีนั้นจะเห็นว่าคุณดูหน้าไหน)</small>
                        <input type="text" id="cs_set_proxy" class="text_pole" placeholder="https://your-proxy.example/?url={url}">
                    </label>
                    <small class="cs_setnote">ถ้าเว็บเปลี่ยนที่อยู่ API หรือชื่อการเรียง (sort) แก้ได้ข้างล่าง ช่องว่าง = ค่าเริ่มต้น</small>
                    ${SOURCE_IDS.map(sourceAdv).join('')}
                    <div class="cs_row"><div id="cs_set_test" class="menu_button"><i class="fa-solid fa-plug"></i> ทดสอบการเชื่อมต่อ</div><div id="cs_set_reset" class="menu_button">ค่าเริ่มต้น</div></div>
                    <div id="cs_set_testout" class="cs_setnote"></div>
                </details>
                <small class="cs_setnote">เปิดได้จากไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/shelf</code> (<code>/shelf janitor</code>, <code>/shelf chub</code>, <code>/shelf risu</code>, <code>/shelf trending24</code>, <code>/shelf chub downloads</code>, <code>/shelf risu latest</code>)</small>
            </div>
        </div>
    </div>`);
    const $ = id => document.getElementById(id);
    const all = sel => document.querySelectorAll(`#cs_settings ${sel}`);
    const forget = () => { ui.lists = {}; ui.apiWorked = {}; forgetRoutes(); };
    $('cs_set_open').addEventListener('click', () => openShelf());
    DIAG.mount($('cs_set_open').parentElement);
    $('cs_set_topbar').checked = !!s.topbar;
    $('cs_set_topbar').addEventListener('change', e => { s.topbar = e.target.checked; saveSettings(); renderTopbar(); });
    for (const inp of all('[data-shown]')) {
        inp.checked = !!s.shown[inp.dataset.shown];
        inp.addEventListener('change', e => {
            s.shown[inp.dataset.shown] = e.target.checked;
            saveSettings();
            if (ui.root) showTab(ui.tab);
        });
    }
    $('cs_set_tab').value = s.tab;
    $('cs_set_tab').addEventListener('change', e => { s.tab = e.target.value; saveSettings(); });
    $('cs_set_close').checked = !!s.closeAfterImport;
    $('cs_set_close').addEventListener('change', e => { s.closeAfterImport = e.target.checked; saveSettings(); });
    $('cs_set_nsfw').checked = !!s.nsfw;
    $('cs_set_nsfw').addEventListener('change', e => { s.nsfw = e.target.checked; saveSettings(); });
    for (const r of document.querySelectorAll('input[name="cs_datacatCat"]')) {
        r.addEventListener('change', e => { if (e.target.checked) { s.datacatCat = e.target.value; saveSettings(); applyDatacatCat(); } });
    }
    const fillAdv = () => {
        $('cs_set_route').value = s.route;
        $('cs_set_proxy').value = s.proxy;
        for (const inp of all('[data-api]')) inp.value = conf(inp.dataset.api).api;
        for (const inp of all('[data-sort]')) inp.value = conf(inp.dataset.src).sorts[inp.dataset.sort];
    };
    fillAdv();
    $('cs_set_route').addEventListener('change', e => { s.route = e.target.value; forget(); saveSettings(); });
    $('cs_set_proxy').addEventListener('change', e => { s.proxy = e.target.value.trim(); forget(); saveSettings(); });
    for (const inp of all('[data-api]')) {
        inp.addEventListener('change', e => {
            const src = inp.dataset.api;
            const value = e.target.value.trim().replace(/\/+$/, '') || SOURCES[src].api;
            if (src === 'janitor') s.api = value; else s[src].api = value;
            e.target.value = value;
            forget();
            saveSettings();
        });
    }
    for (const inp of all('[data-sort]')) {
        inp.addEventListener('change', e => {
            const { src, sort } = inp.dataset;
            const value = e.target.value.trim() || SOURCES[src].sorts[sort];
            conf(src).sorts[sort] = value;
            e.target.value = value;
            saveSettings();
        });
    }
    $('cs_set_reset').addEventListener('click', () => {
        Object.assign(s, {
            route: DEFAULTS.route, proxy: '', api: JANITOR_API, sorts: { ...DEFAULT_SORTS },
            chub: structuredClone(DEFAULTS.chub), risu: structuredClone(DEFAULTS.risu),
        });
        forget();
        saveSettings();
        fillAdv();
    });
    $('cs_set_test').addEventListener('click', async () => {
        const out = $('cs_set_testout');
        out.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังทดสอบ…';
        forgetRoutes();
        ui.apiWorked = {};
        const lines = await Promise.all(SOURCE_IDS.filter(src => s.shown[src]).map(async src => {
            const name = esc(SOURCES[src].name);
            try {
                const r = await fetchPage(src, { tab: listOf(src), page: 1, search: '' });
                const via = { direct: 'อ่านตรง', st: 'ผ่านพร็อกซีของ SillyTavern', custom: 'ผ่านพร็อกซีที่ตั้งเอง' }[r.route] ?? '';
                return r.items.length
                    ? `<li><span class="cs_good"><i class="fa-solid fa-check"></i> ${name}: ใช้ได้ · ได้ ${r.items.length} บอท${via ? ` · ${via}` : ''}</span></li>`
                    : `<li>${name}: ต่อได้ แต่ไม่พบรายชื่อบอทในคำตอบ: <code>${esc(JSON.stringify(r.json).slice(0, 200))}</code></li>`;
            } catch (e) {
                const tips = e instanceof ReachError ? explainReach(e, SOURCES[src].name) : [esc(errText(e))];
                return `<li><span class="cs_bad">${name}: ต่อไม่ได้</span><ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul></li>`;
            }
        }));
        out.innerHTML = lines.length ? `<ul>${lines.join('')}</ul>` : 'ไม่ได้เปิดแท็บไหนไว้';
    });
    // Datacat loads with its own order; check once things have settled.
    setTimeout(() => { $('cs_set_nodc').hidden = datacatReady(); }, 3000);
}

function registerCommand() {
    const c = ctx();
    const run = (_args, value) => { openShelf(String(value ?? '').trim().toLowerCase() || undefined); return ''; };
    try {
        if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'shelf',
                aliases: ['janitor'],
                callback: run,
                helpString: 'เปิด Card Shelf — ใส่ต่อท้ายได้: datacat, janitor, chub, risu, trending24, trending, popular, latest, chub downloads, risu latest …',
            }));
        } else {
            c.registerSlashCommand?.('shelf', run, ['janitor'], 'เปิด Card Shelf', true, true);
        }
    } catch (e) { console.warn(LOG, 'slash command', e); }
    DIAG.registerCommand(c, 'shelf-debug');
}

// ---------------------------------------------------------------- version check + hard refresh
//
// SillyTavern loads extension files by a fixed URL, and browsers (and home-screen web apps on
// iOS, which rarely reload for real) keep the old files cached after "Update". Compare with the
// manifest on the server; if it is newer, say so, and offer to refetch every file and reload.

const BASE_URL = new URL('.', import.meta.url);
/** Every file of the extension, so a hard refresh can replace all of them in the browser cache. */
const FILES = ['index.js', 'lib.js', 'diagnostics.js', 'style.css', 'manifest.json'];

// Extensions > Card Shelf > Diagnose (and /shelf-debug): opens the shelf, measures it, reports.
const DIAG = createDiagnostics({
    name: 'Card Shelf',
    version: VERSION,
    baseUrl: BASE_URL,
    open: () => openShelf(),
    close: () => closeShelf(),
    isOpen: () => !!ui.open,
    overlay: () => ui.root,
    frame: () => ui.root?.querySelector('.cs_panel'),
    state: () => `tab=${settings().tab}`,
});
let remoteVersion = '';
let versionCheckedAt = 0;
let versionToastShown = false;
const newerVersion = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
async function fetchRemoteVersion() {
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return '';
        return String((await res.json())?.version ?? '');
    } catch { return ''; }
}
/** The "running vX · installed vY" line with its two buttons; put it anywhere in the UI. */
function versionLineHtml() {
    return `<div class="cs_verline">ที่รันอยู่: <b>v${VERSION}</b> <span data-cs-remote></span>
        <div class="cs_verbtns"><div class="menu_button" data-cs-check><i class="fa-solid fa-rotate"></i> เช็คเวอร์ชัน</div><div class="menu_button" data-cs-reload><i class="fa-solid fa-cloud-arrow-down"></i> โหลดเวอร์ชันล่าสุด</div></div></div>`;
}
function showRemoteVersion(scope = document) {
    const stale = remoteVersion && newerVersion(remoteVersion, VERSION);
    scope.querySelectorAll('[data-cs-remote]').forEach(el => {
        el.innerHTML = !remoteVersion ? '' : stale
            ? `· ติดตั้งไว้ <b>v${esc(remoteVersion)}</b> <span class="cs_stale">ยังไม่ได้โหลด กด “โหลดเวอร์ชันล่าสุด”</span>`
            : '· เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว';
    });
}
async function checkForNewVersion(force = false) {
    if (!force && Date.now() - versionCheckedAt < 10 * 60_000) return remoteVersion;
    versionCheckedAt = Date.now();
    remoteVersion = await fetchRemoteVersion();
    showRemoteVersion();
    if (remoteVersion && newerVersion(remoteVersion, VERSION) && !versionToastShown) {
        versionToastShown = true;
        globalThis.toastr?.info(`ติดตั้ง v${esc(remoteVersion)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Card Shelf', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => reloadWithFreshFiles(),
        });
    }
    return remoteVersion;
}
async function reloadWithFreshFiles() {
    try {
        globalThis.toastr?.info('กำลังดึงไฟล์ใหม่…', 'Card Shelf', { timeOut: 2000 });
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below runs the new files
        await Promise.all(FILES.map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}
function watchVersion() {
    document.addEventListener('click', e => {
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest('[data-cs-reload]')) reloadWithFreshFiles();
        else if (t?.closest('[data-cs-check]')) checkForNewVersion(true);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(() => checkForNewVersion(true), 3000);
}

// ---------------------------------------------------------------- start

jQuery(() => {
    try {
        settings();
        renderSettingsPanel();
        watchVersion();
        renderTopbar();
        addWandItem();
        registerCommand();
        applyDatacatCat();
        watchDatacat();
        setTimeout(() => { renderTopbar(); addWandItem(); }, 1500);
        globalThis.CardShelf = { open: openShelf, close: closeShelf, version: VERSION };
        console.log(LOG, `v${VERSION} ready`);
    } catch (e) {
        console.error(LOG, 'start failed', e);
    }
});
