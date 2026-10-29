/*
 * Card Shelf — SillyTavern UI extension
 *
 * One window, two tabs: Datacat and JanitorAI. Look around JanitorAI (Ranking, Trending),
 * copy a bot's link, switch to the Datacat tab and let Datacat turn it into a card and
 * import it — Datacat's own import, so first messages and lorebooks come out right.
 * Also lets you freeze or hide Datacat Browser's dancing top-bar cat.
 *
 * The Datacat tab is Datacat Browser's own window (its iframe and import bridge), placed
 * over the Card Shelf window; Card Shelf never talks to datacat.run itself.
 */

import { DEFAULT_PAGES, dockBox, janitorUrl } from './lib.js';

const MODULE = 'card_shelf';
const VERSION = '2.0.0'; // keep in sync with manifest.json
const LOG = '[CardShelf]';
const DATACAT_REPO = 'https://github.com/datacat-run/datacat-sillytavern-browser';

const DEFAULTS = Object.freeze({
    datacatCat: 'animated', // animated | still | hidden — Datacat Browser's top-bar cat
    topbar: true,           // our own icon in the top bar (a still icon, never animated)
    tab: 'datacat',         // datacat | janitor — the tab Card Shelf opens on
    closeAfterImport: true, // close Card Shelf when Datacat opens the imported chat
    pages: DEFAULT_PAGES,   // JanitorAI tab buttons: home, ranking, trending
});

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    for (const [k, v] of Object.entries(DEFAULT_PAGES)) s.pages[k] = janitorUrl(s.pages[k], v);
    if (s.tab !== 'janitor') s.tab = 'datacat';
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();
const datacatReady = () => typeof window.datacatOpenBrowser === 'function';

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

// ---------------------------------------------------------------- the window

const ui = {
    root: null,
    open: false,
    tab: 'datacat',
    docked: false,
    resize: null,
};

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
            <div class="cs_jbar">
                <button data-page="ranking"><i class="fa-solid fa-trophy"></i><span>Ranking</span></button>
                <button data-page="trending"><i class="fa-solid fa-fire"></i><span>Trending</span></button>
                <button data-page="home"><i class="fa-solid fa-house"></i><span>หน้าแรก</span></button>
                <span class="cs_spacer"></span>
                <button class="cs_jreload" title="โหลดใหม่"><i class="fa-solid fa-rotate"></i></button>
                <button class="cs_jout" title="เปิด JanitorAI ในหน้าต่างใหม่"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </div>
            <div class="cs_jhint">กดค้าง (หรือคลิกขวา) ที่บอท → <b>คัดลอกลิงก์</b> แล้วไปแท็บ <b>Datacat</b> วางลิงก์ Datacat จะสร้างการ์ดและนำเข้าให้ · หน้าว่างหรือล็อกอินไม่ได้? กด <i class="fa-solid fa-arrow-up-right-from-square"></i> เปิดในหน้าต่างใหม่</div>
            <div class="cs_body">
                <div class="cs_dock"></div>
                <div class="cs_nodc" hidden>
                    <i class="fa-solid fa-cat"></i>
                    <b>ยังไม่ได้ติดตั้ง Datacat SillyTavern Browser</b>
                    <span>แท็บนี้ใช้หน้าต่างของ Datacat ในการสร้างการ์ดและนำเข้า ติดตั้งจาก Extensions → Install extension แล้ววาง</span>
                    <code>${DATACAT_REPO}</code>
                </div>
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
        const b = e.target.closest('button[data-page]');
        if (b) goJanitor(settings().pages[b.dataset.page]);
    });
    q('.cs_jreload').addEventListener('click', () => {
        const f = janitorFrame();
        f.src = f.src || settings().pages.ranking;
    });
    q('.cs_jout').addEventListener('click', () => window.open(janitorFrame(false)?.src || settings().pages.ranking, '_blank', 'noopener'));
    return root;
}

/** The JanitorAI iframe, made the first time the tab is shown and kept afterwards. */
function janitorFrame(create = true) {
    let f = ui.root?.querySelector('.cs_jframe');
    if (!f && create && ui.root) {
        f = document.createElement('iframe');
        f.className = 'cs_jframe';
        f.title = 'JanitorAI';
        f.referrerPolicy = 'no-referrer';
        f.setAttribute('allow', 'clipboard-write; clipboard-read');
        f.src = settings().pages.ranking;
        ui.root.querySelector('.cs_body').append(f);
    }
    return f;
}

function goJanitor(url) {
    const f = janitorFrame();
    if (f) f.src = janitorUrl(url, settings().pages.home);
}

function openShelf(tab) {
    if (!ui.root) ui.root = buildWindow();
    const s = settings();
    ui.root.hidden = false;
    ui.open = true;
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => ui.root?.classList.add('cs_in'));
    const page = { ranking: 'ranking', trending: 'trending', home: 'home' }[tab];
    if (page) {
        showTab('janitor');
        goJanitor(s.pages[page]);
    } else {
        showTab(tab === 'janitor' || tab === 'datacat' ? tab : s.tab);
    }
}

function closeShelf() {
    if (!ui.open) return;
    ui.open = false;
    undockDatacat();
    document.removeEventListener('keydown', onKey, true);
    ui.root.classList.remove('cs_in');
    ui.root.hidden = true; // kept, so JanitorAI stays where you left it
}

function onKey(e) {
    if (e.key !== 'Escape' || !ui.open) return;
    e.stopPropagation();
    closeShelf();
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
        janitorFrame();
    } else {
        dockDatacat();
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
                <small id="cs_set_nodc" class="cs_setnote cs_warn" hidden>ยังไม่พบ Datacat SillyTavern Browser — แท็บ Datacat ต้องใช้ส่วนขยายนี้: <code>${DATACAT_REPO}</code></small>

                <h4 class="cs_sethead">แมว Datacat บนแถบด้านบน</h4>
                <div class="cs_radios">
                    ${radio('animated', 'เต้นตามปกติ')}
                    ${radio('still', 'หยุดนิ่ง (เป็นรูปนิ่ง กดเปิดได้เหมือนเดิม)')}
                    ${radio('hidden', 'ซ่อน (เปิด Datacat จาก Card Shelf หรือเมนูไม้กายสิทธิ์ → Explore)')}
                </div>
                <small class="cs_setnote">ถ้าจอกระตุกตอนบอทตอบ ลอง “หยุดนิ่ง” หรือ “ซ่อน”</small>

                <details class="cs_adv">
                    <summary>ปุ่มในแท็บ JanitorAI</summary>
                    <label class="cs_field">Ranking<input type="text" class="text_pole" data-page="ranking"></label>
                    <label class="cs_field">Trending<input type="text" class="text_pole" data-page="trending"></label>
                    <label class="cs_field">หน้าแรก<input type="text" class="text_pole" data-page="home"></label>
                    <div class="cs_row"><div id="cs_set_reset" class="menu_button">ค่าเริ่มต้น</div></div>
                    <small class="cs_setnote">ใส่ได้เฉพาะลิงก์ janitorai.com · ถ้า JanitorAI ย้ายหน้า Ranking หรือ Trending ไปที่อื่น เปิดหน้านั้นในเบราว์เซอร์แล้วคัดลอกลิงก์มาวางตรงนี้</small>
                </details>
                <small class="cs_setnote">เปิดได้จากไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/shelf</code> (<code>/shelf janitor</code>, <code>/shelf ranking</code>, <code>/shelf trending</code>)</small>
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
    for (const r of document.querySelectorAll('input[name="cs_datacatCat"]')) {
        r.addEventListener('change', e => { if (e.target.checked) { s.datacatCat = e.target.value; saveSettings(); applyDatacatCat(); } });
    }
    const fillPages = () => { for (const inp of document.querySelectorAll('#cs_settings [data-page]')) inp.value = s.pages[inp.dataset.page]; };
    fillPages();
    for (const inp of document.querySelectorAll('#cs_settings [data-page]')) {
        inp.addEventListener('change', e => {
            s.pages[inp.dataset.page] = janitorUrl(e.target.value, DEFAULT_PAGES[inp.dataset.page]);
            e.target.value = s.pages[inp.dataset.page];
            saveSettings();
        });
    }
    $('cs_set_reset').addEventListener('click', () => { s.pages = { ...DEFAULT_PAGES }; saveSettings(); fillPages(); });
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
                helpString: 'เปิด Card Shelf — ใส่ต่อท้ายได้: datacat, janitor, ranking, trending',
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
