import { ConverterApi } from './api';
import { createBridge } from './bridge';
import { keyStore } from './key-store';
import { startPanel } from './panel';
import { applyTheme, themeFromLocation } from './theme';

/**
 * The panel's entry point (ui.js, loaded by index.html in the iframe Penpot opens).
 * `__API_BASE__` is set by the build: https://converter.studio/api in the bundle for
 * converter.studio (build.mjs).
 */
declare const __API_BASE__: string;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const root = document.documentElement;
applyTheme(root, themeFromLocation(window.location));
const app = document.getElementById('app');
if (app) {
  void startPanel(app, {
    bridge: createBridge(window),
    keys: keyStore(storage()),
    api: (key) => new ConverterApi(__API_BASE__, key),
    root,
  });
}
