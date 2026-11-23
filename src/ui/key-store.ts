/**
 * The user's Converter Studio API key, kept in the panel's own browser storage.
 *
 * The panel is a page of converter.studio inside an iframe in Penpot, so `localStorage` here is
 * converter.studio's, not Penpot's: Penpot's page, its other plugins and other sites cannot read
 * it. Browsers also partition storage in frames by the top-level site (Chrome, Edge, Firefox,
 * Safari), so the key saved while working on penpot.app stays with penpot.app: a self-hosted
 * Penpot asks for it once more, and a page that frames the panel elsewhere sees no key. It is
 * sent only to the Converter Studio API, and "Disconnect" deletes it. It is not a Penpot
 * credential: the plugin asks Penpot for no account access (no `user:read`), and does not use
 * Penpot's `allow:localstorage`, which would keep the key in Penpot's own storage.
 *
 * Anyone with access to this browser profile can read it in the developer tools, like any saved
 * key. A key can be deleted on the account page (converter.studio/account#api-keys) at any time.
 */

const STORAGE_KEY = 'converter-studio.penpot.api-key';
const KEY_PATTERN = /^cvs_live_[A-Za-z0-9]{32}$/;

export interface KeyStore {
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

/** A key as the account page shows it (`cvs_live_` and 32 letters and digits). */
export function isApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Browser storage that may be missing or refuse (private windows, blocked site data, a browser
 * that blocks storage in frames): the key then lives only as long as the panel stays open.
 */
export function keyStore(storage: Storage | null): KeyStore {
  let memory: string | null = null;
  return {
    get() {
      try {
        const value = storage?.getItem(STORAGE_KEY) ?? null;
        return value && isApiKey(value) ? value : memory;
      } catch {
        return memory;
      }
    },
    set(key) {
      memory = key;
      try {
        storage?.setItem(STORAGE_KEY, key);
      } catch {
        // Kept in memory only.
      }
    },
    clear() {
      memory = null;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // Nothing stored.
      }
    },
  };
}
