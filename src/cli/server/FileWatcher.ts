import * as fs from "fs";
import * as path from "path";

/**
 * How long to wait after the last filesystem event before calling back.
 *
 * Editors do not save a file once. They write a temporary file, rename it over
 * the target, and often touch the mtime afterwards, so a single ⌘S produces two
 * or three events — and a read taken between them can see a truncated file. A
 * trailing debounce collapses the burst and guarantees the read happens after
 * the writer is done.
 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 200;

interface DirectoryEntry {
  watcher: fs.FSWatcher | null;
  /** basename → subscribers. */
  readonly files: Map<string, Set<() => void>>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * How a directory watch is opened. Injectable so a test can drive the reload
 * paths deterministically: real `fs.watch` events are asynchronous, coalesced
 * differently per platform, and on a machine that has exhausted its kqueue
 * descriptors they never arrive at all — which would make the suite report on
 * the host rather than on this code.
 */
export type WatchFactory = (
  directory: string,
  listener: (eventType: string, filename: string | null) => void,
) => fs.FSWatcher;

export interface FileWatcherOptions {
  readonly debounceMs?: number;
  /** Where the one-time "watching unavailable" line goes. */
  readonly log?: (message: string) => void;
  readonly watchFactory?: WatchFactory;
}

/**
 * Debounced `fs.watch` over a set of individual files (#314).
 *
 * Two implementation choices are load-bearing:
 *
 * - **It watches the containing directory, not the file.** `fs.watch` on a path
 *   resolves to an inode (inotify on Linux, kqueue on macOS). The moment an
 *   editor saves by writing a temp file and renaming it over the target, the
 *   watched inode is the *old*, now-unlinked file, and every subsequent edit is
 *   silently missed. Watching the directory and filtering by basename survives
 *   the rename, which is the common case this feature exists for.
 * - **Failure is not fatal.** `fs.watch` is unreliable on network mounts and on
 *   some container filesystems, where it either throws immediately or emits an
 *   `error` later. Either way the daemon logs once and carries on unwatched;
 *   refusing to start because a nicety is unavailable would be worse than the
 *   nicety being unavailable.
 */
export class FileWatcher {
  private readonly dirs = new Map<string, DirectoryEntry>();
  private readonly debounceMs: number;
  private readonly log: (message: string) => void;
  private readonly watchFactory: WatchFactory;
  /** Once per process, not once per file: a filesystem that cannot watch one
   *  file cannot watch any of them, and N identical lines is just noise. */
  private degradedLogged = false;
  private closed = false;

  constructor(options: FileWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.log =
      options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.watchFactory =
      options.watchFactory ??
      ((directory, listener) =>
        fs.watch(directory, (eventType, filename) =>
          listener(eventType, typeof filename === "string" ? filename : null),
        ));
  }

  /** Whether at least one watch could not be established. */
  get degraded(): boolean {
    return this.degradedLogged;
  }

  /**
   * Call `onChange` (debounced) whenever `filePath` is written.
   *
   * Returns an unsubscribe function. Several subscribers may watch the same
   * path — two charge points sharing one idTag file is the ordinary case — and
   * they share a single underlying watcher.
   */
  watch(filePath: string, onChange: () => void): () => void {
    const absolute = path.resolve(filePath);
    const dir = path.dirname(absolute);
    const base = path.basename(absolute);
    let entry = this.dirs.get(dir);
    if (!entry) {
      entry = { watcher: null, files: new Map(), timers: new Map() };
      this.dirs.set(dir, entry);
      entry.watcher = this.openWatcher(dir, entry);
    }
    let subscribers = entry.files.get(base);
    if (!subscribers) {
      subscribers = new Set();
      entry.files.set(base, subscribers);
    }
    subscribers.add(onChange);
    return () => {
      const current = this.dirs.get(dir);
      if (!current) return;
      const set = current.files.get(base);
      if (!set) return;
      set.delete(onChange);
      if (set.size > 0) return;
      current.files.delete(base);
      const timer = current.timers.get(base);
      if (timer) {
        clearTimeout(timer);
        current.timers.delete(base);
      }
      if (current.files.size === 0) {
        current.watcher?.close();
        this.dirs.delete(dir);
      }
    };
  }

  /** Every path currently watched, absolute. Test and log surface. */
  watchedPaths(): string[] {
    const out: string[] = [];
    for (const [dir, entry] of this.dirs) {
      for (const base of entry.files.keys()) out.push(path.join(dir, base));
    }
    return out.sort();
  }

  close(): void {
    this.closed = true;
    for (const entry of this.dirs.values()) {
      for (const timer of entry.timers.values()) clearTimeout(timer);
      entry.timers.clear();
      entry.watcher?.close();
    }
    this.dirs.clear();
  }

  private openWatcher(dir: string, entry: DirectoryEntry): fs.FSWatcher | null {
    try {
      const watcher = this.watchFactory(dir, (eventType, filename) => {
        if (this.closed) return;
        const named = typeof filename === "string" && filename.length > 0;
        if (named && entry.files.has(filename)) {
          this.schedule(entry, filename);
          return;
        }
        // A named event for something we do not track only tells us about our
        // own files when it is a *rename*. A `change` on a neighbour says
        // nothing about ours and is still ignored, so an unrelated write in a
        // shared directory costs nothing.
        if (named && eventType !== "rename") return;
        // What is left re-checks every tracked file in this directory:
        //
        // - **A rename naming something we do not track.** On a Kubernetes
        //   projected volume (ConfigMap, Secret) the tracked JSON files are
        //   stable symlinks and an update swaps the directory's `..data`
        //   symlink, so the event names `..data` and never the basename
        //   registered here. Dropping it meant reloads silently stopped for the
        //   single most common way this feature gets deployed — watcher open,
        //   no degradation reported, nothing delivered. The same branch covers
        //   an editor that writes a temp file and renames it into place, where
        //   the event can name the temp file rather than the target.
        // - **No name at all.** Some platforms report none.
        //
        // Re-checking is cheap and self-limiting: it is debounced per file, and
        // the reload path compares content and does nothing when the bytes are
        // unchanged. Correctness here is worth reading a file that did not
        // change (#314).
        for (const base of entry.files.keys()) this.schedule(entry, base);
      });
      // An `error` after a successful open (a mount going away, an inotify
      // limit) is not an exception anywhere it can be caught, so it has to be
      // handled here or it takes the process down as an unhandled 'error'.
      watcher.on("error", (err) => {
        this.reportDegraded(dir, err);
        watcher.close();
        const current = this.dirs.get(dir);
        if (current === entry) entry.watcher = null;
      });
      return watcher;
    } catch (err) {
      this.reportDegraded(dir, err);
      return null;
    }
  }

  private schedule(entry: DirectoryEntry, base: string): void {
    const existing = entry.timers.get(base);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      entry.timers.delete(base);
      if (this.closed) return;
      for (const subscriber of [...(entry.files.get(base) ?? [])]) {
        try {
          subscriber();
        } catch (err) {
          this.log(
            `[watch] reload handler failed for ${base}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }, this.debounceMs);
    // A pending debounce must never be the reason the daemon will not exit.
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.timers.set(base, timer);
  }

  private reportDegraded(dir: string, err: unknown): void {
    if (this.degradedLogged) return;
    this.degradedLogged = true;
    this.log(
      `[watch] file watching is unavailable on this filesystem (${dir}: ${
        err instanceof Error ? err.message : String(err)
      }); --watch will not reload files. Continuing without it.`,
    );
  }
}
