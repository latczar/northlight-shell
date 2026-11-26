/*
 The theme. 'system' is the default and needs no script: globals.css applies the dark values under prefers-color-scheme.
 Light or Dark, pinned in the account menu (ThemeSwitch), lives in an `northlight_theme` cookie for a year; the inline script in
 the layout's <head> turns it into data-theme on <html> before the first paint, so nothing flashes and the server never
 reads it. Browser code only, apart from themeScript, which the layout renders.
*/

export type ThemePref = "system" | "light" | "dark";

/** The phone's browser bar per theme: the top bar's charcoal (globals.css --color-bar). */
export const BAR = { light: "#16191d", dark: "#111417" } as const;

export const themeScript =
  "try{var m=document.cookie.match(/(?:^|; )northlight_theme=(light|dark)(?:;|$)/);if(m)document.documentElement.setAttribute('data-theme',m[1])}catch(e){}";

export function readThemePref(): ThemePref {
  const m = document.cookie.match(/(?:^|; )northlight_theme=(system|light|dark)(?:;|$)/);
  return (m?.[1] as ThemePref | undefined) ?? "system";
}

const listeners = new Set<() => void>();

/** For useSyncExternalStore: the menu's switch re-reads the cookie whenever the choice changes. */
export function subscribeThemePref(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A theme change is one instant flip: transitions would fade some controls while the rest snapped. */
function flipInstantly() {
  const root = document.documentElement;
  root.setAttribute("data-theme-switching", "");
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute("data-theme-switching")));
}

/** Saves the choice for a year and applies it at once. */
export function setThemePref(pref: ThemePref) {
  document.cookie = `northlight_theme=${pref}; Max-Age=31536000; Path=/; SameSite=Lax`;
  const root = document.documentElement;
  flipInstantly();
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    meta.content = BAR[pref === "system" ? (meta.media.includes("dark") ? "dark" : "light") : pref];
  });
  listeners.forEach(listener => listener());
}
