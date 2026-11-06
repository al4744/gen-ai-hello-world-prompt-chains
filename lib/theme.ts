export type ThemePreference = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "caption-arena-prompt-chains-theme";
const THEME_CHANGE_EVENT = "caption-arena-theme-change";

export function parseTheme(value: string | null): ThemePreference {
  return value === "light" || value === "system" ? value : "dark";
}

// Runs in <head> before content paints. Only a validated appearance value is
// read; this script never reads session cookies or renders protected content.
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.setAttribute("data-theme",t==="light"||t==="system"?t:"dark")}catch(e){}})()`;

export function getTheme(): ThemePreference {
  return parseTheme(document.documentElement.getAttribute("data-theme"));
}

export function getServerTheme(): ThemePreference {
  return "dark";
}

export function setTheme(theme: ThemePreference): boolean {
  document.documentElement.setAttribute("data-theme", theme);
  let persisted = true;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Appearance still works in this tab if the browser blocks storage.
    persisted = false;
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  return persisted;
}

export function subscribeTheme(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    document.documentElement.setAttribute("data-theme", parseTheme(event.newValue));
    onChange();
  }

  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
