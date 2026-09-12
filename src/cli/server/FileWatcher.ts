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

/**
 * How many symlink hops are followed from a watched path.
 *
 * Far below the kernel's own `ELOOP` limit (32–40) because a configuration
 * layout that needs more than a handful of indirections is not a layout this
 * feature is trying to serve, and every hop is a directory watch. This is what
 * actually bounds a cycle; the visited-hop check in the walk ends one sooner
 * but is not load-bearing on its own.
 */
export const MAX_CHAIN_HOPS = 8;

interface DirectoryEntry {
  watcher: fs.FSWatcher | null;
  /**
   * basename → the *registered* paths that want events for it.
   *
   * Usually one, and usually itself. It is a set because a directory carries
   * two different kinds of name: the registered files that live in it, and the
   * symlink *targets* of registered files that live elsewhere — and one target
   * can back several registrations (two charge points sharing one idTag file
   * through two links is the ordinary case).
   */
  readonly names: Map<string, Set<string>>;
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
 * Three implementation choices are load-bearing:
 *
 * - **It watches the containing directory, not the file.** `fs.watch` on a path
 *   resolves to an inode (inotify on Linux, kqueue on macOS). The moment an
 *   editor saves by writing a temp file and renaming it over the target, the
 *   watched inode is the *old*, now-unlinked file, and every subsequent edit is
 *   silently missed. Watching the directory and filtering by basename survives
 *   the rename, which is the common case this feature exists for.
 * - **It watches the resolved symlink target as well.** A directory watch sees
 *   events for the names *in that directory*. When the registered path is a
 *   symlink and its target is edited in place, the event fires in the
 *   **target's** directory and the link's own directory hears nothing at all —
 *   watcher open, no degradation reported, nothing ever delivered. Both watches
 *   are kept, because they cover disjoint cases: the parent-directory watch
 *   catches the link being *repointed* (the Kubernetes projected-volume
 *   rotation, where `..data` is swapped and the tracked basename never
 *   changes), and the target watch catches the target *changing under a link
 *   that stays put*. Neither mechanism sees the other's case.
 * - **Failure is not fatal.** `fs.watch` is unreliable on network mounts and on
 *   some container filesystems, where it either throws immediately or emits an
 *   `error` later. Either way the daemon logs once and carries on unwatched;
 *   refusing to start because a nicety is unavailable would be worse than the
 *   nicety being unavailable.
 *
 * The debounce is keyed by **registered path**, not by directory and basename,
 * and that is what makes two watches safe: an edit that fires in both
 * directories, or a rotation that fires twice in one, still collapses into a
 * single callback because both routes end at the same timer.
 */
export class FileWatcher {
  private readonly dirs = new Map<string, DirectoryEntry>();
  /** Registered absolute path → its subscribers. */
  private readonly subscribers = new Map<string, Set<() => void>>();
  /** Registered absolute path → its pending debounce. One per registration. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Registered absolute path → **every hop** of the symlink chain currently
   * being watched for it, in order, ending at the real file or at the first
   * hop that does not exist. Empty for a path that is not itself a symlink.
   */
  private readonly linkChains = new Map<string, readonly string[]>();
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
    let subscribers = this.subscribers.get(absolute);
    const first = subscribers === undefined;
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(absolute, subscribers);
    }
    subscribers.add(onChange);
    if (first) {
      this.addName(absolute, absolute);
      this.refreshLinkTarget(absolute);
    }
    return () => {
      const set = this.subscribers.get(absolute);
      if (!set) return;
      set.delete(onChange);
      if (set.size > 0) return;
      this.subscribers.delete(absolute);
      const timer = this.timers.get(absolute);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(absolute);
      }
      for (const hop of this.linkChains.get(absolute) ?? []) {
        this.removeName(hop, absolute);
      }
      this.linkChains.delete(absolute);
      this.removeName(absolute, absolute);
    };
  }

  /**
   * Every path currently watched, absolute — the paths callers *registered*,
   * not the directories or symlink targets opened to serve them. Test and log
   * surface, and an operator reading the boot summary wants the file they named.
   */
  watchedPaths(): string[] {
    return [...this.subscribers.keys()].sort();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.dirs.values()) entry.watcher?.close();
    this.dirs.clear();
    this.subscribers.clear();
    this.linkChains.clear();
  }

  /** Register interest in `watchedPath`'s basename on behalf of `owner`. */
  private addName(watchedPath: string, owner: string): void {
    const dir = path.dirname(watchedPath);
    const base = path.basename(watchedPath);
    let entry = this.dirs.get(dir);
    if (!entry) {
      entry = { watcher: null, names: new Map() };
      this.dirs.set(dir, entry);
      entry.watcher = this.openWatcher(dir, entry);
    }
    let owners = entry.names.get(base);
    if (!owners) {
      owners = new Set();
      entry.names.set(base, owners);
    }
    owners.add(owner);
  }

  private removeName(watchedPath: string, owner: string): void {
    const dir = path.dirname(watchedPath);
    const base = path.basename(watchedPath);
    const entry = this.dirs.get(dir);
    if (!entry) return;
    const owners = entry.names.get(base);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size > 0) return;
    entry.names.delete(base);
    if (entry.names.size > 0) return;
    entry.watcher?.close();
    this.dirs.delete(dir);
  }

  /**
   * Point the target watch at wherever `absolute` resolves to *now*.
   *
   * **When this runs is the whole question.** Resolving once, at registration,
   * would leave the target watch on the old file the moment the link is
   * repointed — and repointing is precisely what the projected-volume rotation
   * does. So it runs again on every event that reaches this registration: a
   * rename of the tracked name in its own directory, the catch-all rescan an
   * unnamed or untracked-rename event triggers, and an ordinary write (where
   * the answer is unchanged and this costs one `realpath` call). The parent
   * watch is what makes re-resolution possible, which is the other reason it is
   * kept rather than replaced.
   *
   * **A path that will not resolve is not a degraded filesystem.** A broken
   * link (`ENOENT`) and a cycle (`ELOOP`) both throw here, and both are things
   * an operator can create in one command; neither says anything about whether
   * `fs.watch` works. They are absorbed as "no target to watch" — the parent
   * directory watch is still live, so creating the missing target fires a
   * rename there, this runs again, and the target watch appears. Reporting them
   * through `reportDegraded` would be a false alarm *and* would consume the
   * once-per-process slot that a real watch failure needs.
   */
  private refreshLinkTarget(absolute: string): void {
    if (this.closed) return;
    const next = this.resolveChain(absolute);
    const current = this.linkChains.get(absolute) ?? [];
    if (
      current.length === next.length &&
      current.every((hop, i) => hop === next[i])
    ) {
      return;
    }
    // Diffed rather than torn down and rebuilt: a chain whose tail moved keeps
    // its unchanged head, so the directories it shares are never closed and
    // reopened — and closing one, however briefly, is a window in which the
    // event this exists to catch would be missed.
    const nextSet = new Set(next);
    for (const hop of current) {
      if (!nextSet.has(hop)) this.removeName(hop, absolute);
    }
    const currentSet = new Set(current);
    for (const hop of next) {
      if (!currentSet.has(hop)) this.addName(hop, absolute);
    }
    if (next.length === 0) this.linkChains.delete(absolute);
    else this.linkChains.set(absolute, next);
  }

  /**
   * Every hop of `absolute`'s symlink chain, in order, through to the real file
   * or the first hop that is not there.
   *
   * **Why every hop and not just the far end.** A directory watch sees the
   * names in *its own* directory, so each link in a chain needs the directory
   * it lives in to be watched or the thing that happens to it is invisible.
   * Two cases follow, and neither is exotic:
   *
   * - **A chain broken past the first missing hop.** `realpath` cannot resolve
   *   it at all, and watching only the first missing hop means creating the
   *   *final* file emits in a directory nothing has opened. Walking the chain
   *   watches each directory the recreation could land in.
   * - **An intermediate link repointed after the chain already resolved.**
   *   `/a → /b/link → /c/file`, and `/b/link` is swung at `/c2/file`. That is a
   *   rename in `/b`, which is neither the registered path's directory nor the
   *   final target's — so with only those two watched it is silent, and the
   *   daemon keeps reading the file it was pointed away from.
   *
   * Unlike the *ancestor* symlink case, which is documented as unsupported,
   * this needs no directory watch to be reopened: the directories along a chain
   * (`/b`, `/c`, `/c2`) are not themselves replaced — only the link inside one
   * of them changes — so the watches opened on them stay valid and see it. That
   * is the difference between the two, and it is why one is supported and the
   * other is not.
   *
   * **Bounded by {@link MAX_CHAIN_HOPS}**, far below the kernel's own `ELOOP`
   * limit of 32 to 40. The visited-hop check ends a cycle earlier than the cap
   * would, but it is defence in depth rather than the bound: with it removed a
   * cycle still terminates, and still opens no more directories, because the
   * cap stops the walk and repeated hops dedupe into the same watches. Stated
   * that way because it is what a mutation test showed. The registered path itself is not a hop — it is already watched as
   * the primary — and a path that is not a symlink yields no hops at all, which
   * is what keeps a symlinked *ancestor* from adding anything.
   */
  private resolveChain(absolute: string): string[] {
    const hops: string[] = [];
    const seen = new Set<string>([absolute]);
    let current = absolute;
    for (let depth = 0; depth < MAX_CHAIN_HOPS; depth += 1) {
      let isLink: boolean;
      try {
        isLink = fs.lstatSync(current).isSymbolicLink();
      } catch {
        // `current` does not exist. It is already the last hop pushed (or the
        // registered path, which needs nothing), and its directory is watched,
        // which is where its creation will fire.
        break;
      }
      if (!isLink) break;
      let declared: string;
      try {
        declared = fs.readlinkSync(current);
      } catch {
        break;
      }
      const next = path.resolve(path.dirname(current), declared);
      if (seen.has(next)) break;
      seen.add(next);
      hops.push(next);
      current = next;
    }
    return hops;
  }

  private openWatcher(dir: string, entry: DirectoryEntry): fs.FSWatcher | null {
    try {
      const watcher = this.watchFactory(dir, (eventType, filename) => {
        if (this.closed) return;
        const named = typeof filename === "string" && filename.length > 0;
        if (named) {
          const owners = entry.names.get(filename);
          if (owners) {
            // Copied before iterating: `touch` re-resolves, which can add or
            // remove names in this very map.
            for (const owner of [...owners]) this.touch(owner);
            return;
          }
          // A named event for something we do not track only tells us about our
          // own files when it is a *rename*. A `change` on a neighbour says
          // nothing about ours and is still ignored, so an unrelated write in a
          // shared directory costs nothing.
          if (eventType !== "rename") return;
        }
        // What is left re-checks every tracked name in this directory:
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
        // Re-checking is cheap and self-limiting: it is debounced per
        // registered path, and the reload path compares content and does
        // nothing when the bytes are unchanged. Correctness here is worth
        // reading a file that did not change (#314).
        for (const owners of [...entry.names.values()]) {
          for (const owner of [...owners]) this.touch(owner);
        }
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

  /** One event, for one registration: re-resolve, then debounce. */
  private touch(absolute: string): void {
    if (!this.subscribers.has(absolute)) return;
    this.refreshLinkTarget(absolute);
    this.schedule(absolute);
  }

  private schedule(absolute: string): void {
    const existing = this.timers.get(absolute);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(absolute);
      if (this.closed) return;
      for (const subscriber of [...(this.subscribers.get(absolute) ?? [])]) {
        try {
          subscriber();
        } catch (err) {
          this.log(
            `[watch] reload handler failed for ${path.basename(absolute)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }, this.debounceMs);
    // A pending debounce must never be the reason the daemon will not exit.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(absolute, timer);
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
