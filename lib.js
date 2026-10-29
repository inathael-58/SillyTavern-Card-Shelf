/*
 * Card Shelf — pure helpers (no DOM, no SillyTavern), so they can be tested in Node.
 */

export const JANITOR_SITE = 'https://janitorai.com';

// Buttons above the JanitorAI tab. Editable in the settings, in case JanitorAI moves them.
export const DEFAULT_PAGES = Object.freeze({
    home: 'https://janitorai.com/',
    ranking: 'https://janitorai.com/search?mode=all&sort=popular&page=1',
    trending: 'https://janitorai.com/search?mode=all&sort=trending&page=1',
});

/** True for janitorai.com and its subdomains, over https. */
export function isJanitorUrl(value) {
    try {
        const u = new URL(String(value ?? '').trim());
        return u.protocol === 'https:' && (u.hostname === 'janitorai.com' || u.hostname.endsWith('.janitorai.com'));
    } catch {
        return false;
    }
}

/** A JanitorAI address to show in the tab, or the fallback when the value isn't one. */
export function janitorUrl(value, fallback = DEFAULT_PAGES.home) {
    const s = String(value ?? '').trim();
    if (isJanitorUrl(s)) return new URL(s).href;
    // "janitorai.com/…" typed without https://
    if (/^(?:[\w-]+\.)*janitorai\.com(?:[/?#]|$)/i.test(s)) return janitorUrl(`https://${s}`, fallback);
    return fallback;
}

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
