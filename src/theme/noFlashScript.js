import { DARK_QUERY, STORAGE_KEY, THEME_COLORS } from './themeCore.js'

// Source of the tiny synchronous script injected in <head> by vite.config.js, BEFORE the stylesheet and before
// React. It reads the stored preference and prefers-color-scheme and sets data-theme on <html>, so the first
// paint is already in the right theme (no light flash before React mounts). It duplicates resolveTheme() on
// purpose - it cannot import modules - and noFlashScript.test.js runs it against resolveTheme() for every
// combination, so the two cannot drift apart.
export function buildNoFlashScript({ enabled }) {
  const cfg = JSON.stringify({ enabled: Boolean(enabled), key: STORAGE_KEY, query: DARK_QUERY, colors: THEME_COLORS })
  return `(function(){var c=${cfg},r=document.documentElement;try{var p=null;try{p=window.localStorage.getItem(c.key)}catch(e){}if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var d=c.enabled&&(p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia(c.query).matches));var t=d?"dark":"light";r.setAttribute("data-theme",t);r.setAttribute("data-theme-preference",p);r.style.colorScheme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",c.colors[t])}catch(e){r.setAttribute("data-theme","light")}})();`
}
