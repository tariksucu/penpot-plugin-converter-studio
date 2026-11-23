import type { Theme } from '../shared/messages';

/**
 * Penpot opens the panel with its theme in the address (`?theme=dark`; with a version 2
 * manifest Penpot moves the query into the hash: `#/?theme=dark`) and the plugin passes on each
 * change (`themechange`). The page follows it through `data-theme` on `<html>` (styles.css).
 */
export function themeFromLocation(location: { search: string; hash: string }): Theme {
  const fromHash = location.hash.includes('?')
    ? location.hash.slice(location.hash.indexOf('?'))
    : '';
  for (const query of [location.search, fromHash]) {
    const theme = new URLSearchParams(query).get('theme');
    if (theme === 'light' || theme === 'dark') return theme;
  }
  return 'dark';
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.theme = theme;
}
