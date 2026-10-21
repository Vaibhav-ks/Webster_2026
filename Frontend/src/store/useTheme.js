// Light / dark theme, remembered per browser. The initial value is applied by an
// inline script in index.html before React loads, so there's no flash.

import { create } from 'zustand';

const KEY = 'scarlet-theme';

function initialTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(theme) {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  root.dataset.theme = theme;
  window.setTimeout(() => root.classList.remove('theme-transition'), 400);
}

export const useTheme = create((set, get) => ({
  theme: initialTheme(),
  toggle: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage blocked */
    }
    set({ theme });
  },
}));

document.documentElement.dataset.theme = useTheme.getState().theme;