/*
 * Card Shelf — SillyTavern UI extension
 *
 * One window, two tabs: Datacat and JanitorAI. The JanitorAI tab lists JanitorAI's Trending
 * (24 hours and week), Popular and Latest bots; tap one, "ส่งไป Datacat" copies its link and switches to the
 * Datacat tab, where Datacat turns it into a card and imports it — Datacat's own import,
 * so first messages and lorebooks come out right. Also lets you freeze or hide Datacat
 * Browser's dancing top-bar cat.
 *
 * The Datacat tab is Datacat Browser's own window (its iframe and import bridge), placed
 * over the Card Shelf window; Card Shelf never talks to datacat.run itself.
 * JanitorAI doesn't let other sites show its pages in a frame, so its list is read from
 * JanitorAI and drawn here instead.
 */

import {
    DEFAULT_SORTS, dockBox, JANITOR_API, listUrl, normalizeList, routedUrl, routeOrder, shortCount, siteUrl,
} from './lib.js';

const MODULE = 'card_shelf';
const VERSION = '2.2.0'; // keep in sync with manifest.json
const LOG = '[CardShelf]';
const DATACAT_REPO = 'https://github.com/datacat-run/datacat-sillytavern-browser';

const DEFAULTS = Object.freeze({
    datacatCat: 'animated', // animated | still | hidden — Datacat Browser's top-bar cat
    topbar: true,           // our own icon in the top bar (a still icon, never animated)
    tab: 'datacat',         // datacat | janitor — the tab Card Shelf opens on
    jtab: 'trending24',     // trending24 | trending | popular | latest — the JanitorAI list shown
    closeAfterImport: true, // close Card Shelf when Datacat opens the imported chat
    nsfw: true,             // include NSFW bots in the JanitorAI lists
    route: 'auto',          // auto | st | direct | custom — how JanitorAI is reached
    proxy: '',              // custom proxy, {url} = the encoded JanitorAI address
    api: JANITOR_API,
    sorts: DEFAULT_SORTS,
});

const LISTS = [
    ['trending24', 'fa-fire', '24 ชม.', 'Trending 24 ชั่วโมง'],
    ['trending', 'fa-fire', 'สัปดาห์', 'Trending สัปดาห์นี้'],
    ['popular', 'fa-trophy', 'Popular', 'Popular'],
    ['latest', 'fa-clock', 'ล่าสุด', 'ล่าสุด'],
];
// Names used by 2.1 and earlier (and still accepted by /shelf).
const LIST_ALIASES = { ranking: 'popular', trending7: 'trending', week: 'trending', '24h': 'trending24' };

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    if (s.sorts.ranking !== undefined) { // 2.1's "Ranking" is now "Popular"
        if (s.sorts.ranking !== 'popular') s.sorts.popular = s.sorts.ranking;
        delete s.sorts.ranking;
    }
    for (const [k, v] of Object.entries(DEFAULT_SORTS)) if (!s.sorts[k]) s.sorts[k] = v;
    delete s.pages; // 2.0's frame buttons
    if (s.tab !== 'janitor') s.tab = 'datacat';
    s.jtab = LIST_ALIASES[s.jtab] ?? s.jtab;
    if (!LISTS.some(l => l[0] === s.jtab)) s.jtab = DEFAULTS.jtab;
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();
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

async function fetchJson(url) {
    const s = settings();
    let order = routeOrder(s.route, s.proxy);
    if (goodRoute && order.includes(goodRoute)) order = [goodRoute, ...order.filter(r => r !== goodRoute)];
    const attempts = [];
    for (const route of order) {
        const target = routedUrl(url, route, s.proxy);
        if (!target) continue;
        try {
            const res = await fetch(target, { headers: { Accept: 'application/json' }, cache: 'no-store', referrerPolicy: 'no-referrer' });
            const text = await res.text().catch(() => '');
            if (!res.ok) {
                attempts.push({ route, status: res.status, text: text.replace(/\s+/g, ' ').slice(0, 160) });
                continue;
            }
            try {
                const body = JSON.parse(text);
                goodRoute = route;
                return body;
            } catch {
                attempts.push({ route, status: res.status, text: /cloudflare|challenge|<html/i.test(text) ? 'cloudflare' : 'not json' });
            }
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
            tips.push(`JanitorAI (Cloudflare) ไม่ยอมให้เครื่องที่รัน SillyTavern อ่าน (${esc(a.route)} ${a.status || ''}) — ลองใหม่ภายหลัง หรือใช้พร็อกซีอื่นในการตั้งค่า`);
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
    tab: 'datacat',
    docked: false,
    resize: null,
    jtab: 'trending24',
    search: '',
    lists: {},      // listKey() → { tab, search, items, page, pages, done, loading, error }
    observer: null,
    noteTimer: null,
};

const listKey = () => JSON.stringify([ui.jtab, ui.search, settings().nsfw, settings().api, settings().sorts[ui.jtab]]);
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
                <nav class="cs_tabs" role="tablist">
                    <button data-tab="datacat" role="tab"><i class="fa-solid fa-cat"></i><span>Datacat</span></button>
                    <button data-tab="janitor" role="tab"><i class="fa-solid fa-broom"></i><span>JanitorAI</span></button>
                </nav>
                <button class="cs_tool cs_close" title="ปิด (Esc)" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
            </header>
            <div class="cs_note" hidden></div>
            <div class="cs_jbar">
                ${LISTS.map(([id, icon, label, title]) => `<button data-list="${id}" title="${title}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`).join('')}
            </div>
            <form class="cs_searchrow">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" class="cs_search" placeholder="ค้นหาบอทบน JanitorAI" autocomplete="off" spellcheck="false" enterkeyhint="search">
                <i class="fa-solid fa-circle-notch fa-spin cs_spin" hidden></i>
                <button type="button" class="cs_jreload" title="โหลดใหม่"><i class="fa-solid fa-rotate"></i></button>
                <button type="button" class="cs_jout" title="เปิดหน้านี้บนเว็บ JanitorAI"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
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
        if (!b) return;
        ui.jtab = settings().jtab = b.dataset.list;
        saveSettings();
        renderList();
    });
    q('.cs_jreload').addEventListener('click', () => { delete ui.lists[listKey()]; goodRoute = null; renderList(); });
    q('.cs_jout').addEventListener('click', () => {
        const s = settings();
        window.open(siteUrl({ sort: s.sorts[ui.jtab], search: ui.search, nsfw: s.nsfw }), '_blank', 'noopener');
    });
    q('.cs_searchrow').addEventListener('submit', e => {
        e.preventDefault();
        ui.search = q('.cs_search').value.trim();
        q('.cs_search').blur();
        renderList();
    });
    q('.cs_search').addEventListener('search', () => {
        if (q('.cs_search').value === '' && ui.search) { ui.search = ''; renderList(); }
    });
    q('.cs_list').addEventListener('click', e => {
        const card = e.target.closest('.cs_card');
        const item = card && allItems().find(i => i.id === card.dataset.id);
        if (item) openSheet(item);
    });
    return root;
}

function openShelf(tab) {
    tab = LIST_ALIASES[tab] ?? tab;
    if (!ui.root) ui.root = buildWindow();
    const s = settings();
    ui.root.hidden = false;
    ui.open = true;
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => ui.root?.classList.add('cs_in'));
    if (LISTS.some(l => l[0] === tab)) {
        ui.jtab = s.jtab = tab;
        showTab('janitor');
    } else {
        ui.jtab = s.jtab;
        showTab(tab === 'janitor' || tab === 'datacat' ? tab : s.tab);
    }
}

function closeShelf() {
    if (!ui.open) return;
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
    ui.tab = tab === 'janitor' ? 'janitor' : 'datacat';
    if (remember) { settings().tab = ui.tab; saveSettings(); }
    const root = ui.root;
    for (const b of root.querySelectorAll('.cs_tabs button')) b.classList.toggle('cs_on', b.dataset.tab === ui.tab);
    root.classList.toggle('cs_tab_janitor', ui.tab === 'janitor');
    root.classList.toggle('cs_tab_datacat', ui.tab === 'datacat');
    if (ui.tab === 'janitor') {
        undockDatacat();
        renderList({ keep: true });
    } else {
        closeSheet();
        dockDatacat();
    }
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

// ---------------------------------------------------------------- JanitorAI list

function renderList({ keep = false } = {}) {
    if (!ui.root) return;
    const q = sel => ui.root.querySelector(sel);
    for (const b of ui.root.querySelectorAll('.cs_jbar button[data-list]')) b.classList.toggle('cs_on', b.dataset.list === ui.jtab);
    q('.cs_search').value = ui.search;
    const box = q('.cs_list');
    const key = listKey();
    // Coming back to the tab: leave the list (and the scroll position) as it was.
    if (keep && box.dataset.key === key && box.childElementCount) return;
    closeSheet();
    ui.observer?.disconnect();
    box.dataset.key = key;
    box.scrollTop = 0;
    const list = ui.lists[key] ??= { tab: ui.jtab, search: ui.search, items: [], page: 0, pages: 0, done: false, loading: false, error: null };
    box.innerHTML = `
        ${ui.search ? `<div class="cs_listnote">ผลค้นหา “${esc(ui.search)}”</div>` : ''}
        <div class="cs_grid" role="list"></div>
        <div class="cs_more"></div>`;
    appendCards(box.querySelector('.cs_grid'), list.items, 0, list.tab);
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
    const s = settings();
    list.loading = true;
    setBusy(true);
    refreshMore(key);
    try {
        const page = list.page + 1;
        const json = await fetchJson(listUrl({ api: s.api, sort: s.sorts[list.tab], page, search: list.search, nsfw: s.nsfw }));
        const r = normalizeList(json, page);
        const seen = new Set(list.items.map(i => i.id));
        const fresh = r.items.filter(i => !seen.has(i.id));
        const start = list.items.length;
        list.items.push(...fresh);
        list.page = page;
        list.pages = r.pages;
        list.done = !fresh.length || (r.pages && page >= r.pages);
        if (isShown(key)) appendCards(ui.root.querySelector('.cs_grid'), fresh, start, list.tab);
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
    if (list.error) {
        const tips = list.error instanceof ReachError ? explainReach(list.error) : [esc(errText(list.error))];
        more.innerHTML = `
            <div class="cs_error">
                <b><i class="fa-solid fa-triangle-exclamation"></i> อ่านรายชื่อจาก JanitorAI ไม่ได้</b>
                <ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>
                <div class="cs_row">
                    <button class="menu_button cs_retry"><i class="fa-solid fa-rotate"></i> ลองใหม่</button>
                    <button class="menu_button cs_opensite"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดบนเว็บ JanitorAI</button>
                </div>
                <small>เปิดบนเว็บแล้วคัดลอกลิงก์บอทจากตรงนั้น มาวางในแท็บ Datacat ได้เหมือนกัน</small>
            </div>`;
        more.querySelector('.cs_retry').addEventListener('click', () => { list.error = null; goodRoute = null; updateMore(list); loadMore(listKey()); });
        more.querySelector('.cs_opensite').addEventListener('click', () => ui.root.querySelector('.cs_jout').click());
    } else if (list.loading) {
        more.innerHTML = '<div class="cs_loading"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังโหลด…</div>';
    } else if (list.done) {
        more.innerHTML = list.items.length ? '<div class="cs_end">หมดแล้ว</div>' : '<div class="cs_end">ไม่พบบอท</div>';
    } else {
        more.innerHTML = '<button class="menu_button cs_loadmore">โหลดเพิ่ม</button>';
        more.querySelector('.cs_loadmore').addEventListener('click', () => loadMore(listKey()));
    }
}

function appendCards(grid, items, start, tab) {
    if (!grid || !items.length) return;
    const ranked = tab !== 'latest' && !ui.search;
    grid.insertAdjacentHTML('beforeend', items.map((it, i) => `
        <button class="cs_card" role="listitem" data-id="${esc(it.id)}">
            <span class="cs_cover">
                ${it.avatar ? `<img src="${esc(it.avatar)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-user"></i>'}
                ${ranked ? `<span class="cs_rank">${start + i + 1}</span>` : ''}
                ${it.nsfw ? '<span class="cs_nsfw">NSFW</span>' : ''}
            </span>
            <span class="cs_cname">${esc(it.name)}</span>
            <span class="cs_meta">${it.chats ? `<i class="fa-solid fa-comments"></i> ${shortCount(it.chats)}` : ''}${it.creator ? ` · @${esc(it.creator)}` : ''}</span>
            <span class="cs_tags">${it.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}</span>
        </button>`).join(''));
}

// ---------------------------------------------------------------- bot sheet

function openSheet(item) {
    const sheet = ui.root?.querySelector('.cs_sheet');
    if (!sheet) return;
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
                        ${item.nsfw ? '<span class="cs_nsfw">NSFW</span>' : ''}
                    </div>
                    <div class="cs_tags cs_tagsfull">${item.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
                </div>
            </div>
            <div class="cs_actions">
                <button class="menu_button cs_send"><i class="fa-solid fa-cat"></i> ส่งไป Datacat</button>
                <button class="menu_button cs_copy"><i class="fa-regular fa-copy"></i> คัดลอกลิงก์</button>
                <button class="menu_button cs_openpage"><i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดใน JanitorAI</button>
            </div>
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
    q('.cs_send').addEventListener('click', async () => {
        if (!(await copyText(item.url))) { showLink(); return; }
        showTab('datacat', { remember: false });
        note(`<i class="fa-regular fa-clipboard"></i> คัดลอกลิงก์ <b>${esc(item.name)}</b> แล้ว — วางลงในช่องของ Datacat ได้เลย`);
    });
}

function closeSheet() {
    const sheet = ui.root?.querySelector('.cs_sheet');
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    sheet.innerHTML = '';
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
    el.innerHTML = '<div class="drawer-toggle"><div class="drawer-icon fa-regular fa-compass interactable cs_ticon" title="Card Shelf — Datacat / JanitorAI" tabindex="0"></div></div>';
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
    host.insertAdjacentHTML('beforeend', `
    <div id="cs_settings" class="cs_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Card Shelf <small class="cs_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cs_row"><div id="cs_set_open" class="menu_button"><i class="fa-regular fa-compass"></i> เปิด Card Shelf</div></div>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_topbar"> ไอคอนเข็มทิศบนแถบด้านบน (ไอคอนนิ่ง ไม่มีแอนิเมชัน)</label>
                <label class="cs_field">เปิดมาที่แท็บ
                    <select id="cs_set_tab" class="text_pole">
                        <option value="datacat">Datacat</option>
                        <option value="janitor">JanitorAI</option>
                    </select>
                </label>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_close"> ปิด Card Shelf เมื่อ Datacat นำเข้าเสร็จและเปิดแชทแล้ว</label>
                <label class="checkbox_label"><input type="checkbox" id="cs_set_nsfw"> แสดงบอท NSFW ในรายชื่อ JanitorAI</label>
                <small id="cs_set_nodc" class="cs_setnote cs_warn" hidden>ยังไม่พบ Datacat SillyTavern Browser — แท็บ Datacat ต้องใช้ส่วนขยายนี้: <code>${DATACAT_REPO}</code></small>

                <h4 class="cs_sethead">แมว Datacat บนแถบด้านบน</h4>
                <div class="cs_radios">
                    ${radio('animated', 'เต้นตามปกติ')}
                    ${radio('still', 'หยุดนิ่ง (เป็นรูปนิ่ง กดเปิดได้เหมือนเดิม)')}
                    ${radio('hidden', 'ซ่อน (เปิด Datacat จาก Card Shelf หรือเมนูไม้กายสิทธิ์ → Explore)')}
                </div>
                <small class="cs_setnote">ถ้าจอกระตุกตอนบอทตอบ ลอง “หยุดนิ่ง” หรือ “ซ่อน”</small>

                <details class="cs_adv">
                    <summary>การเชื่อมต่อ JanitorAI</summary>
                    <small class="cs_setnote">รายชื่อในแท็บ JanitorAI อ่านผ่านพร็อกซีของ SillyTavern: ใน <code>config.yaml</code> ตั้ง <code>enableCorsProxy: true</code> แล้วรีสตาร์ท SillyTavern</small>
                    <label class="cs_field">เส้นทาง
                        <select id="cs_set_route" class="text_pole">
                            <option value="auto">อัตโนมัติ (พร็อกซี ST → พร็อกซีที่ตั้งไว้ → ตรง)</option>
                            <option value="st">พร็อกซีของ SillyTavern (/proxy/)</option>
                            <option value="custom">พร็อกซีที่ตั้งเอง</option>
                            <option value="direct">ตรงจากเบราว์เซอร์</option>
                        </select>
                    </label>
                    <label class="cs_field">พร็อกซีที่ตั้งเอง <small>(<code>{url}</code> = ที่อยู่ JanitorAI · พร็อกซีนั้นจะเห็นว่าคุณดูหน้าไหน)</small>
                        <input type="text" id="cs_set_proxy" class="text_pole" placeholder="https://your-proxy.example/?url={url}">
                    </label>
                    <label class="cs_field">API<input type="text" id="cs_set_api" class="text_pole"></label>
                    <div class="cs_sorts">
                        ${LISTS.map(([id, , , title]) => `<label class="cs_field">${title}<input type="text" class="text_pole" data-sort="${id}"></label>`).join('')}
                    </div>
                    <div class="cs_row"><div id="cs_set_test" class="menu_button"><i class="fa-solid fa-plug"></i> ทดสอบการเชื่อมต่อ</div><div id="cs_set_reset" class="menu_button">ค่าเริ่มต้น</div></div>
                    <div id="cs_set_testout" class="cs_setnote"></div>
                </details>
                <small class="cs_setnote">เปิดได้จากไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/shelf</code> (<code>/shelf janitor</code>, <code>/shelf trending24</code>, <code>/shelf trending</code>, <code>/shelf popular</code>, <code>/shelf latest</code>)</small>
            </div>
        </div>
    </div>`);
    const $ = id => document.getElementById(id);
    $('cs_set_open').addEventListener('click', () => openShelf());
    $('cs_set_topbar').checked = !!s.topbar;
    $('cs_set_topbar').addEventListener('change', e => { s.topbar = e.target.checked; saveSettings(); renderTopbar(); });
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
        $('cs_set_api').value = s.api;
        for (const inp of document.querySelectorAll('#cs_settings [data-sort]')) inp.value = s.sorts[inp.dataset.sort];
    };
    fillAdv();
    $('cs_set_route').addEventListener('change', e => { s.route = e.target.value; goodRoute = null; saveSettings(); });
    $('cs_set_proxy').addEventListener('change', e => { s.proxy = e.target.value.trim(); goodRoute = null; saveSettings(); });
    $('cs_set_api').addEventListener('change', e => { s.api = e.target.value.trim().replace(/\/+$/, '') || JANITOR_API; e.target.value = s.api; saveSettings(); });
    for (const inp of document.querySelectorAll('#cs_settings [data-sort]')) {
        inp.addEventListener('change', e => {
            s.sorts[inp.dataset.sort] = e.target.value.trim() || DEFAULT_SORTS[inp.dataset.sort];
            e.target.value = s.sorts[inp.dataset.sort];
            saveSettings();
        });
    }
    $('cs_set_reset').addEventListener('click', () => {
        Object.assign(s, { route: DEFAULTS.route, proxy: '', api: JANITOR_API, sorts: { ...DEFAULT_SORTS } });
        goodRoute = null;
        saveSettings();
        fillAdv();
    });
    $('cs_set_test').addEventListener('click', async () => {
        const out = $('cs_set_testout');
        out.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังทดสอบ…';
        goodRoute = null;
        try {
            const json = await fetchJson(listUrl({ api: s.api, sort: s.sorts[ui.jtab] ?? s.sorts.popular, page: 1, nsfw: s.nsfw }));
            const r = normalizeList(json);
            out.innerHTML = r.items.length
                ? `<span class="cs_good"><i class="fa-solid fa-check"></i> ใช้ได้ ผ่าน ${esc(goodRoute)} · ได้ ${r.items.length} บอท</span>`
                : `ต่อได้ผ่าน ${esc(goodRoute)} แต่ไม่พบรายชื่อบอทในคำตอบ: <code>${esc(JSON.stringify(json).slice(0, 200))}</code>`;
        } catch (e) {
            out.innerHTML = `<span class="cs_bad">ต่อไม่ได้</span><ul>${(e instanceof ReachError ? explainReach(e) : [esc(errText(e))]).map(t => `<li>${t}</li>`).join('')}</ul>`;
        }
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
                helpString: 'เปิด Card Shelf — ใส่ต่อท้ายได้: datacat, janitor, trending24, trending, popular, latest',
            }));
        } else {
            c.registerSlashCommand?.('shelf', run, ['janitor'], 'เปิด Card Shelf', true, true);
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
        globalThis.CardShelf = { open: openShelf, close: closeShelf, version: VERSION };
        console.log(LOG, `v${VERSION} ready`);
    } catch (e) {
        console.error(LOG, 'start failed', e);
    }
});
