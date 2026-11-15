import * as fs from "fs";
import * as path from "path";

import type { CPRegistry } from "../CPRegistry";
import type { FileReloadEvent, FileReloadTarget } from "../FileReloadManager";
import { parseIdTagsFile } from "../idTagFile";
import { readTextOrEmpty } from "./shared";

/** What the idTag reload paths need from the manager that owns the state. */
export interface IdTagReloadHost {
  readonly registry: CPRegistry;
  /** See `FileReloadManager.idTagText`. */
  readonly idTagText: Map<string, string>;
  /** See `FileReloadManager.reconciledCps`. */
  readonly reconciledCps: Set<string>;
  isClosed(): boolean;
  log(message: string): void;
  emit(event: FileReloadEvent): void;
  rejectAll(
    cpIds: readonly string[],
    target: FileReloadTarget,
    filePath: string,
    err: unknown,
  ): void;
}

export class IdTagReload {
  constructor(private readonly host: IdTagReloadHost) {}

  /** Every live charge point whose `idTagPool.file` is this path. */
  private affectedByIdTagFile(absolutePath: string): string[] {
    return this.host.registry.list().filter((cpId) => {
      const file = this.host.registry.get(cpId)?.getInit().idTagFile;
      return file !== undefined && path.resolve(file) === absolutePath;
    });
  }

  reloadIdTags(absolutePath: string): void {
    if (this.host.isClosed()) return;
    const affected = this.affectedByIdTagFile(absolutePath);
    if (affected.length === 0) return;

    let text: string;
    try {
      text = fs.readFileSync(absolutePath, "utf-8");
    } catch (err) {
      this.host.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    // The directory watch fires for neighbours and for the editor's own extra
    // touches; identical bytes are not a reload and must not produce an event.
    if (this.host.idTagText.get(absolutePath) === text) return;

    let tags: string[];
    try {
      tags = parseIdTagsFile(absolutePath, text);
    } catch (err) {
      // Note: `lastText` is deliberately NOT updated. A file saved broken and
      // then saved again identically-broken should complain twice, and the next
      // good save must still be seen as a change.
      this.host.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    // Recorded only once the pool has actually been installed everywhere it
    // had to be. `applyIdTagReload` persists as well as mutates, so a transient
    // SQLITE_BUSY or a full disk throws *after* the live pool changed: caching
    // the text first left persisted state stale, emitted no outcome at all
    // (the throw reached the watcher's generic handler), and suppressed a retry
    // of the very same bytes. The baseline is a record of what landed.
    this.recordIdTagOutcome(
      absolutePath,
      text,
      this.applyIdTags(affected, absolutePath, tags),
    );
  }

  /**
   * Bring a newly watched file and the charge points behind it into agreement
   * (#314).
   *
   * A `--state-db` restore brings back the tags as they were when the daemon
   * last saw the file. Edit that file while the daemon is stopped and the
   * charge point comes back **stale** — and recording the file's current bytes
   * as the duplicate-suppression baseline would then suppress the operator's
   * next save of that same content as "not a change", leaving the pool stale
   * until the file happened to change again. So the comparison here is against
   * the tags the charge point actually holds, not against the bytes.
   *
   * Runs once per watch, from the branch that establishes it, so an unrelated
   * `cp.create` cannot re-report a file that has been broken on disk all along.
   */
  reconcileIdTags(absolutePath: string): void {
    if (this.host.isClosed()) return;
    const affected = this.affectedByIdTagFile(absolutePath).filter(
      (cpId) => !this.host.reconciledCps.has(reconcileKey(cpId, absolutePath)),
    );
    if (affected.length === 0) return;
    // Marked before anything can fail: a file that has been broken on disk all
    // along is reported once, not once per registry sync for the rest of the
    // daemon's life.
    for (const cpId of affected) {
      this.host.reconciledCps.add(reconcileKey(cpId, absolutePath));
    }
    // Read from disk, never from the cache. The cache holds the bytes of the
    // last reload that landed, and a charge point being reconciled here is one
    // that has *just* been created — `cp.create` read the file itself moments
    // ago. When the two disagree the file is newer, not older: `fs.watch` may
    // be degraded on this filesystem, or its debounce may simply not have run
    // yet. Preferring the cache meant this reconciliation overwrote the correct
    // tags the create had just read, persisted the stale list over them, and
    // then never looked again — leaving degraded mode strictly worse than no
    // watcher at all, which is the opposite of what this feature promises
    // (#314).
    const text = readTextOrEmpty(absolutePath);

    let tags: string[];
    try {
      tags = parseIdTagsFile(absolutePath, text);
    } catch (err) {
      // Same rule as the watch path: the baseline is dropped rather than left
      // pointing at bytes that never parsed, so the next save — good or bad —
      // is judged fresh instead of being written off as a duplicate. (The watch
      // path reaches the same place by a different route: there the unparsed
      // bytes are not the cached ones, so the previous good baseline is
      // correctly left standing and a re-save of the broken file complains
      // again.)
      this.recordIdTagOutcome(absolutePath, text, false);
      this.host.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    // Every charge point drawing from this path, not just the ones this call is
    // reconciling. The baseline is path-wide, so it may only move when *all* of
    // them hold these bytes — see `rememberIfEveryoneHolds`.
    const backedByPath = this.affectedByIdTagFile(absolutePath);
    const rememberIfEveryoneHolds = (): void => {
      const everyoneHolds = backedByPath.every((cpId) =>
        sameTags(this.host.registry.get(cpId)?.getInit().idTags, tags),
      );
      if (everyoneHolds) this.recordIdTagOutcome(absolutePath, text, true);
    };
    const stale = affected.filter(
      (cpId) => !sameTags(this.host.registry.get(cpId)?.getInit().idTags, tags),
    );
    if (stale.length === 0) {
      // Nothing for *this* call to apply. Whether the baseline may move is a
      // different question, and one this branch used to answer wrongly.
      rememberIfEveryoneHolds();
      return;
    }
    this.host.log(
      `[watch] ${absolutePath} no longer matches ${stale.length} charge point(s) it was loaded into; reconciling`,
    );
    if (!this.applyIdTags(stale, absolutePath, tags)) {
      // Two caches here, and they follow opposite rules on purpose. The
      // `reconciledCps` marker above is set *before* the attempt: it exists so
      // a file that has been broken on disk all along is reported once rather
      // than at every registry sync. `idTagText` says every charge point on the
      // path holds these bytes, so a failed apply must not leave them cached — the
      // operator's next save of that same content would be discarded as
      // unchanged and the database could never catch up. Do not "make these
      // consistent": they answer different questions.
      this.recordIdTagOutcome(absolutePath, text, false);
      return;
    }
    // Applied to everyone this call was reconciling — which still says nothing
    // about the charge points it was not.
    rememberIfEveryoneHolds();
  }

  /**
   * Move or drop the path's baseline, according to whether these bytes are now
   * held by every charge point behind it.
   *
   * One function because the rule had two implementations and therefore two
   * behaviours: the reconciliation path dropped the baseline when an apply
   * failed, and the watch path left the previous bytes cached. With several
   * charge points on one file, an apply that changed some of them and threw on
   * a later one returned `false` while the *old* text stayed cached — so an
   * operator restoring the file to those old bytes hit the unchanged early-out
   * and the charge points that had already moved were never rolled back. A
   * forward edit would have been re-read anyway; the revert is the sequence
   * that stayed broken, which is why it is the one the test drives.
   *
   * **What this does and does not do.** Dropping the baseline restores the
   * *ability* to repair — the next event for this file is no longer suppressed
   * and re-applies to everyone — but it repairs nothing by itself. If no
   * further event arrives, the split persists: `reconcileIdTags` will not
   * revisit a charge point it has already marked, so nothing on a quiet daemon
   * re-syncs them. The two things that do are an operator touching the file
   * again, and a restart, where the reconcile markers start empty and every
   * charge point is compared against the file afresh. Stated as a limitation
   * rather than claimed as a fix (#314).
   */
  private recordIdTagOutcome(
    absolutePath: string,
    text: string,
    landedEverywhere: boolean,
  ): void {
    if (landedEverywhere) this.host.idTagText.set(absolutePath, text);
    else this.host.idTagText.delete(absolutePath);
  }

  /** Whether every charge point took the new pool without throwing. A charge
   *  point that simply has no pool to replace is reported and counts as
   *  settled; a persistence failure does not. Note the aggregate: `false` means
   *  *somewhere between none and all of them changed*, never "nothing did". */
  private applyIdTags(
    cpIds: readonly string[],
    absolutePath: string,
    tags: readonly string[],
  ): boolean {
    let allSettled = true;
    for (const cpId of cpIds) {
      let applied: boolean;
      try {
        applied = this.host.registry.applyIdTagReload(cpId, tags);
      } catch (err) {
        // Persisting is part of applying: a pool that is live but not written
        // back comes apart at the next restart, so this is reported like any
        // other rejection rather than swallowed as a handler crash.
        allSettled = false;
        this.host.rejectAll([cpId], "id-tags", absolutePath, err);
        continue;
      }
      this.host.emit({
        target: "id-tags",
        path: absolutePath,
        cpId,
        connectorId: null,
        scenarioId: null,
        outcome: applied ? "applied" : "rejected",
        error: applied
          ? null
          : "charge point has no idTag pool to replace; recreate it with idTagPool set",
      });
      if (applied) {
        this.host.log(
          `[watch] ${cpId}: idTag pool reloaded from ${absolutePath} (${tags.length} tags)`,
        );
      }
    }
    return allSettled;
  }
}

/** `cpId` + absolute path. NUL cannot appear in either, so the split is exact. */
export function reconcileKey(cpId: string, absolutePath: string): string {
  return `${cpId}\u0000${absolutePath}`;
}

export function splitReconcileKey(key: string): [string, string] {
  const at = key.indexOf("\u0000");
  return [key.slice(0, at), key.slice(at + 1)];
}

/** Order-sensitive: an idTag pool's order is its draw order under
 *  `round-robin`, so a reordered file is a real change. */
function sameTags(
  current: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  if (current === undefined || current.length !== next.length) return false;
  return current.every((tag, i) => tag === next[i]);
}
