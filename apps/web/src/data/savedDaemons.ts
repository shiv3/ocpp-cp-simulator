/**
 * Saved daemon addresses (#619). The web console served by a daemon can talk
 * to another one: the user saves its address once and switches between them.
 * Only Remote mode uses this; Local mode never reads or writes it.
 *
 * The list lives in localStorage. Addresses with embedded credentials are
 * rejected so a password never lands in browser storage.
 */
export interface SavedDaemon {
  /** The normalized base URL (`http(s)://host[:port]`, no trailing slash). */
  url: string;
  /** Optional display name; the URL is shown when empty. */
  name: string;
}

export const SAVED_DAEMONS_KEY = "ocpp-cp.saved-daemons";
export const ACTIVE_DAEMON_KEY = "ocpp-cp.active-daemon";
export const MAX_SAVED_DAEMONS = 20;

/** `http(s)://host[:port]` without path, query, fragment or credentials, or
 *  `null` when the text is not such an address. */
export function normalizeDaemonUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseSavedDaemons(raw: string | null): SavedDaemon[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: SavedDaemon[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { url, name } = item as { url?: unknown; name?: unknown };
      if (typeof url !== "string") continue;
      const normalized = normalizeDaemonUrl(url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({
        url: normalized,
        name: typeof name === "string" ? name.trim().slice(0, 60) : "",
      });
      if (out.length >= MAX_SAVED_DAEMONS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function loadSavedDaemons(): SavedDaemon[] {
  return parseSavedDaemons(storage()?.getItem(SAVED_DAEMONS_KEY) ?? null);
}

export function storeSavedDaemons(list: SavedDaemon[]): void {
  try {
    storage()?.setItem(SAVED_DAEMONS_KEY, JSON.stringify(list));
  } catch {
    // best effort: the list just isn't kept
  }
}

/** The daemon chosen last, or `null` (use the page origin). */
export function loadActiveDaemon(): string | null {
  const raw = storage()?.getItem(ACTIVE_DAEMON_KEY) ?? null;
  return raw ? normalizeDaemonUrl(raw) : null;
}

export function storeActiveDaemon(url: string | null): void {
  try {
    if (url) storage()?.setItem(ACTIVE_DAEMON_KEY, url);
    else storage()?.removeItem(ACTIVE_DAEMON_KEY);
  } catch {
    // best effort
  }
}

export type AddDaemonResult =
  | { ok: true; list: SavedDaemon[] }
  | { ok: false; reason: "invalid" | "duplicate" | "full" };

/** Pure: the list with `url` added, or why it cannot be. */
export function addSavedDaemon(
  list: SavedDaemon[],
  rawUrl: string,
  name: string,
): AddDaemonResult {
  const url = normalizeDaemonUrl(rawUrl);
  if (!url) return { ok: false, reason: "invalid" };
  if (list.some((d) => d.url === url))
    return { ok: false, reason: "duplicate" };
  if (list.length >= MAX_SAVED_DAEMONS) return { ok: false, reason: "full" };
  return { ok: true, list: [...list, { url, name: name.trim().slice(0, 60) }] };
}

export function removeSavedDaemon(
  list: SavedDaemon[],
  url: string,
): SavedDaemon[] {
  return list.filter((d) => d.url !== url);
}
