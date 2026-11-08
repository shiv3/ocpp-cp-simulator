import type { Transaction } from "./Transaction";

/**
 * A {@link Transaction} as the charger engine keeps it
 * (docs/concepts/charger-engine.md, "Charger engine"): plain JSON. The two
 * instants are ISO strings, and a field that is not set is absent (never
 * `undefined`). `Connector.transaction` is a live view over it that hands
 * code the `Transaction` shape, with `Date`s, it always had.
 */
export type TransactionRecord = Omit<Transaction, "startTime" | "stopTime"> & {
  startTime: string;
  stopTime: string | null;
};

/** A field change of a transaction; an `undefined` value deletes the field. */
export type TransactionPatch = {
  [K in keyof TransactionRecord]?: TransactionRecord[K] | undefined;
};

const DATE_FIELDS: ReadonlySet<string> = new Set(["startTime", "stopTime"]);

function encodeField(key: string, value: unknown): unknown {
  if (DATE_FIELDS.has(key) && value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return value;
}

function decodeField(key: string, value: unknown): unknown {
  if (DATE_FIELDS.has(key) && typeof value === "string") {
    return new Date(value);
  }
  return value;
}

/** The JSON record of `transaction` (a copy; unset fields are left out). */
export function recordOfTransaction(
  transaction: Transaction,
): TransactionRecord {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transaction)) {
    if (value === undefined) continue;
    out[key] = encodeField(key, value);
  }
  return out as unknown as TransactionRecord;
}

/** The `Transaction` a record describes (a fresh object). */
export function transactionOfRecord(record: TransactionRecord): Transaction {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = decodeField(key, value);
  }
  return out as unknown as Transaction;
}

/** A patch that carries the given `Transaction` fields (Dates encoded). */
export function patchOfFields(
  fields: Partial<Record<keyof Transaction, unknown>>,
): TransactionPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = encodeField(key, value);
  }
  return out as TransactionPatch;
}

export function reduceTransactionPatch(
  record: TransactionRecord,
  patch: TransactionPatch,
): TransactionRecord {
  const next: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as TransactionRecord;
}

/** Bring a live `Transaction` object up to date with a patch, in place. */
export function applyPatchToTransaction(
  target: Transaction,
  patch: TransactionPatch,
): void {
  const object = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete object[key];
    else object[key] = decodeField(key, value);
  }
}
