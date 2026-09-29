// The stored theme is applied by an inline script in <head> before first paint (see Base.astro).
// This file only wires up the toggle buttons.
const THEME_KEY = 'rn-green-theme'; // also read by the inline script in Base.astro

const root = document.documentElement;
// The header has one toggle for phones and one for larger screens; only one is shown at a time.
const toggles = document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]');

function syncLabel(): void {
  const light = root.dataset.theme === 'light';
  for (const toggle of toggles) {
    toggle.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  }
}

function switchTheme(): void {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage can be blocked (private mode, disabled site data). The theme still applies for this page.
  }
  syncLabel();
}

for (const toggle of toggles) toggle.addEventListener('click', switchTheme);
syncLabel();

// Keep this file a module so its top-level names stay private to it.
export {};
