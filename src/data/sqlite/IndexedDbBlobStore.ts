import { get, set, createStore, type UseStore } from "idb-keyval";

/**
 * Tiny wrapper around `idb-keyval` for storing the sql.js database dump as
 * a single `Uint8Array` blob under a fixed key. We isolate this in a
 * dedicated module so SqlJsDatabase doesn't import idb-keyval directly —
 * makes it easy to swap the persistence backing (or stub it out for
 * tests / Tauri-on-rust) without touching the SQL layer.
 *
 * DB name + store name are constants on purpose: there's exactly one
 * simulator state DB per browser profile, so versioning happens inside the
 * SQLite schema rather than via multiple IDB stores.
 */
const IDB_DB_NAME = "ocpp-cp-simulator";
const IDB_STORE_NAME = "sqlite-blob";
const BLOB_KEY = "main";

let store: UseStore | null = null;

function getStore(): UseStore {
  if (!store) store = createStore(IDB_DB_NAME, IDB_STORE_NAME);
  return store;
}

export async function loadBlob(): Promise<Uint8Array | null> {
  try {
    const value = await get<Uint8Array | undefined>(BLOB_KEY, getStore());
    return value ?? null;
  } catch {
    return null;
  }
}

export async function saveBlob(payload: Uint8Array): Promise<void> {
  await set(BLOB_KEY, payload, getStore());
}
