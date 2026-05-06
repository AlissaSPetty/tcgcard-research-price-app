export type Theme = "light" | "dark";

const STORAGE_KEY = "listing-admin-theme";

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(STORAGE_KEY);
  if (s === "dark" || s === "light") return s;
  return null;
}

export function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Run before React render to avoid theme flash. */
export function initThemeFromStorage(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = getStoredTheme();
  const theme =
    stored ??
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  return theme;
}
