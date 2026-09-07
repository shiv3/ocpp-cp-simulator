import type * as fs from "fs";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "bun:test";

import { FileWatcher, type WatchFactory } from "../FileWatcher";

/**
 * A stand-in for `fs.watch`.
 *
 * The real thing is not usable as a unit-test input: its events are
 * asynchronous, coalesced differently on every platform, and on a host that has
 * exhausted its kqueue descriptors they never arrive — a suite built on it
 * reports on the machine, not on this class. The behaviours that actually
 * matter here are which path is watched, how events are filtered and debounced,
 * and what happens when opening fails; all four are exercised below.
 */
class FakeFs {
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  private readonly listeners = new Map<
    string,
    (eventType: string, filename: string | null) => void
  >();
  private readonly errorHandlers = new Map<string, (err: Error) => void>();

  constructor(private readonly failWith?: Error) {}

  readonly factory: WatchFactory = (directory, listener) => {
    if (this.failWith) throw this.failWith;
    this.opened.push(directory);
    this.listeners.set(directory, listener);
    const handle = {
      on: (event: string, handler: (err: Error) => void) => {
        if (event === "error") this.errorHandlers.set(directory, handler);
        return handle;
      },
      close: () => {
        this.closed.push(directory);
        this.listeners.delete(directory);
      },
    };
    return handle as unknown as fs.FSWatcher;
  };

  emit(directory: string, eventType: string, filename: string | null): void {
    this.listeners.get(directory)?.(eventType, filename);
  }

  emitError(directory: string, err: Error): void {
    this.errorHandlers.get(directory)?.(err);
  }

  get watching(): boolean {
    return this.listeners.size > 0;
  }
}

const watchers: FileWatcher[] = [];

afterEach(() => {
  while (watchers.length > 0) watchers.pop()?.close();
});

function makeWatcher(
  options: ConstructorParameters<typeof FileWatcher>[0],
): FileWatcher {
  const watcher = new FileWatcher(options);
  watchers.push(watcher);
  return watcher;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DIR = path.resolve("/watched");
const FILE = path.join(DIR, "tags.json");

describe("FileWatcher (#314)", () => {
  it("watches the containing directory, not the file itself", () => {
    // `fs.watch` on a path binds to an inode, and an editor that saves by
    // writing a temp file and renaming it over the target leaves that watch on
    // the old, unlinked inode — every edit after the first is silently missed.
    // Watching the directory and filtering by basename survives the rename.
    const fake = new FakeFs();
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {});
    expect(fake.opened).toEqual([DIR]);
    expect(watcher.watchedPaths()).toEqual([FILE]);
  });

  it("keeps firing across repeated atomic renames", async () => {
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      calls += 1;
    });

    fake.emit(DIR, "rename", "tags.json");
    await sleep(40);
    fake.emit(DIR, "rename", "tags.json");
    await sleep(40);
    expect(calls).toBe(2);
  });

  it("collapses a burst of events into one callback", async () => {
    // An editor's save is a burst — temp file, rename, mtime touch. Undebounced
    // that is two or three callbacks, and a read taken between them can see a
    // truncated intermediate file.
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 60, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      calls += 1;
    });

    fake.emit(DIR, "change", "tags.json");
    fake.emit(DIR, "rename", "tags.json");
    fake.emit(DIR, "change", "tags.json");
    expect(calls).toBe(0);

    await sleep(150);
    expect(calls).toBe(1);
  });

  it("ignores a neighbouring file in the same directory", async () => {
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      calls += 1;
    });

    fake.emit(DIR, "change", "something-else.json");
    await sleep(40);
    expect(calls).toBe(0);
  });

  it("falls back to re-checking every tracked file when the platform reports no filename", async () => {
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      calls += 1;
    });

    fake.emit(DIR, "change", null);
    await sleep(40);
    expect(calls).toBe(1);
  });

  it("delivers one change to every subscriber of that path", async () => {
    // Two charge points sharing one idTag file is the ordinary case; one
    // underlying watcher must serve both.
    const fake = new FakeFs();
    let first = 0;
    let second = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      first += 1;
    });
    watcher.watch(FILE, () => {
      second += 1;
    });
    expect(fake.opened).toEqual([DIR]);

    fake.emit(DIR, "change", "tags.json");
    await sleep(40);
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("logs once and carries on when the filesystem cannot watch", () => {
    // Network mounts and some container filesystems make `fs.watch` throw.
    // Refusing to start would turn an optional convenience into a hard
    // dependency; one line and no watches is the contract.
    const fake = new FakeFs(new Error("EMFILE: too many open files, watch"));
    const lines: string[] = [];
    const watcher = makeWatcher({
      debounceMs: 5,
      watchFactory: fake.factory,
      log: (m) => lines.push(m),
    });

    expect(() => watcher.watch(FILE, () => {})).not.toThrow();
    expect(() =>
      watcher.watch(path.join("/other", "scenario.json"), () => {}),
    ).not.toThrow();

    expect(watcher.degraded).toBe(true);
    // Once per process, not once per file: N identical lines is only noise.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("file watching is unavailable");
  });

  it("survives an error raised after the watch was opened", () => {
    // Node re-throws an unhandled FSWatcher 'error' as a process-level
    // exception, so this handler is the difference between a degraded daemon
    // and a dead one.
    const fake = new FakeFs();
    const lines: string[] = [];
    const watcher = makeWatcher({
      debounceMs: 5,
      watchFactory: fake.factory,
      log: (m) => lines.push(m),
    });
    watcher.watch(FILE, () => {});

    expect(() =>
      fake.emitError(DIR, new Error("EMFILE: too many open files, watch")),
    ).not.toThrow();
    expect(watcher.degraded).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("re-checks tracked files when a name it does not track is renamed", async () => {
    // Kubernetes projected volumes (ConfigMap, Secret) mount the tracked JSON
    // files as stable symlinks and rotate the directory's `..data` symlink on
    // update, so the event names `..data` and never the basename registered
    // here. Dropping it meant reloads silently stopped for the most common way
    // this feature is deployed — watcher open, no degradation reported, nothing
    // delivered. The same branch covers an editor that writes a temp file and
    // renames it into place, where the event can name the temp file instead.
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(FILE, () => {
      calls += 1;
    });

    fake.emit(DIR, "rename", "..data");
    await sleep(40);
    expect(calls).toBe(1);

    fake.emit(DIR, "rename", ".tags.json.swp");
    await sleep(40);
    expect(calls).toBe(2);
  });

  it("closes the underlying watcher once the last subscriber unsubscribes", async () => {
    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    const unwatch = watcher.watch(FILE, () => {
      calls += 1;
    });
    unwatch();

    expect(watcher.watchedPaths()).toEqual([]);
    expect(fake.closed).toEqual([DIR]);
    expect(fake.watching).toBe(false);
    fake.emit(DIR, "change", "tags.json");
    await sleep(40);
    expect(calls).toBe(0);
  });
});

/**
 * Symlinks, both halves (#314).
 *
 * The family has two cases and neither mechanism sees the other's:
 *
 * - **The link moves.** A Kubernetes projected volume swaps the directory's
 *   `..data` symlink; the tracked basename never changes, and the event names
 *   something untracked. Covered by the parent-directory watch's rename
 *   rescan, tested above.
 * - **The target changes under a link that stays put.** An ordinary symlink
 *   into a shared config directory, edited in place. The event fires in the
 *   *target's* directory, which nothing watched — so the watcher opened, no
 *   degradation was reported, and nothing ever fired. That is the third time
 *   this branch has produced that exact symptom, and it is why the target is
 *   watched too.
 *
 * Real symlinks and a real `realpathSync`, with only the `fs.watch` events
 * faked: resolution is the thing under test, so faking it would test nothing.
 * The temp dir is resolved up front because on macOS `/var` is itself a link.
 */
describe("FileWatcher symlink targets (#314)", () => {
  const made: string[] = [];

  function tempRoot(): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ocpp-symlink-")));
    made.push(dir);
    return dir;
  }

  afterEach(() => {
    while (made.length > 0) {
      rmSync(made.pop() as string, { recursive: true, force: true });
    }
  });

  it("watches the target's directory as well as the link's", () => {
    const root = tempRoot();
    const linkDir = path.join(root, "conf");
    const targetDir = path.join(root, "shared");
    mkdirSync(linkDir);
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "tags.json"), "[]");
    const link = path.join(linkDir, "tags.json");
    symlinkSync(path.join(targetDir, "tags.json"), link);

    const fake = new FakeFs();
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(link, () => {});

    // Both, and "as well" is the point: dropping the link's own directory
    // would reintroduce the rotation case.
    expect(fake.opened.sort()).toEqual([linkDir, targetDir].sort());
    // …while the path the caller registered is still the one reported.
    expect(watcher.watchedPaths()).toEqual([link]);
  });

  it("fires when the target is edited in place", async () => {
    const root = tempRoot();
    const linkDir = path.join(root, "conf");
    const targetDir = path.join(root, "shared");
    mkdirSync(linkDir);
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "tags.json"), "[]");
    const link = path.join(linkDir, "tags.json");
    symlinkSync(path.join(targetDir, "tags.json"), link);

    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(link, () => {
      calls += 1;
    });

    // The event the kernel actually emits for an in-place edit: a change to
    // the target's own name, in the target's own directory. Nothing at all
    // arrives in the link's directory, which is why this was silent.
    fake.emit(targetDir, "change", "tags.json");
    await sleep(20);
    expect(calls).toBe(1);
  });

  it("collapses an edit seen by both watches into one callback", async () => {
    const root = tempRoot();
    const targetDir = path.join(root, "shared");
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "tags.json"), "[]");
    const link = path.join(root, "tags.json");
    symlinkSync(path.join(targetDir, "tags.json"), link);

    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 10, watchFactory: fake.factory });
    watcher.watch(link, () => {
      calls += 1;
    });

    // One save, seen twice. The debounce is keyed by *registered path*, so
    // both routes land on the same timer — a per-directory key would deliver
    // two reloads for one edit.
    fake.emit(targetDir, "change", "tags.json");
    fake.emit(root, "change", "tags.json");
    await sleep(30);
    expect(calls).toBe(1);
  });

  it("still delivers exactly one reload for a rotation", async () => {
    const root = tempRoot();
    const targetDir = path.join(root, "..data-1");
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "tags.json"), "[]");
    const link = path.join(root, "tags.json");
    symlinkSync(path.join(targetDir, "tags.json"), link);

    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 10, watchFactory: fake.factory });
    watcher.watch(link, () => {
      calls += 1;
    });

    // The projected-volume shape: a rename of a name nothing tracks, in the
    // link's directory. One reload, not one per watch.
    fake.emit(root, "rename", "..data");
    await sleep(30);
    expect(calls).toBe(1);
  });

  it("re-resolves when the link is repointed", async () => {
    const root = tempRoot();
    const oldDir = path.join(root, "v1");
    const newDir = path.join(root, "v2");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(path.join(oldDir, "tags.json"), "[]");
    writeFileSync(path.join(newDir, "tags.json"), "[]");
    const link = path.join(root, "tags.json");
    symlinkSync(path.join(oldDir, "tags.json"), link);

    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(link, () => {
      calls += 1;
    });
    expect(fake.opened).toContain(oldDir);

    // The operator repoints the link. The rename of the tracked name in the
    // link's own directory is what tells us to resolve again — resolving only
    // at registration would leave the target watch on the old file forever,
    // which is exactly the rotation case in a different costume.
    rmSync(link);
    symlinkSync(path.join(newDir, "tags.json"), link);
    fake.emit(root, "rename", "tags.json");
    await sleep(20);
    expect(calls).toBe(1);
    expect(fake.opened).toContain(newDir);
    // The old target's directory is no longer watched…
    expect(fake.closed).toContain(oldDir);

    // …so an edit there is no longer ours, while one at the new target is.
    fake.emit(oldDir, "change", "tags.json");
    await sleep(20);
    expect(calls).toBe(1);
    fake.emit(newDir, "change", "tags.json");
    await sleep(20);
    expect(calls).toBe(2);
  });

  it("treats a broken link as nothing to watch, not a degraded filesystem", async () => {
    const root = tempRoot();
    const targetDir = path.join(root, "shared");
    mkdirSync(targetDir);
    const link = path.join(root, "tags.json");
    symlinkSync(path.join(targetDir, "tags.json"), link);

    const fake = new FakeFs();
    let calls = 0;
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    expect(() => watcher.watch(link, () => (calls += 1))).not.toThrow();
    // `realpathSync` threw ENOENT. That says nothing about whether `fs.watch`
    // works, so it must not consume the once-per-process degradation line a
    // real watch failure needs.
    expect(watcher.degraded).toBe(false);
    expect(fake.opened).toEqual([root]);

    // And the parent watch is what lets it recover: creating the target fires
    // a rename in the link's directory, the resolution runs again, and the
    // target's directory joins the watch.
    writeFileSync(path.join(targetDir, "tags.json"), "[]");
    fake.emit(root, "rename", "tags.json");
    await sleep(20);
    expect(calls).toBe(1);
    expect(fake.opened).toContain(targetDir);
  });

  it("does not open a second watch for a symlinked ancestor", () => {
    // The gate is on the path's *own* last component being a link, not on
    // `realpath` differing — and the difference is not academic: on macOS
    // `/var` and `/tmp` are links, and container bind mounts do the same to
    // arbitrary ancestors, so "resolved differs" is true of ordinary files all
    // over the filesystem. Watching their targets would double the descriptor
    // count for nothing, because `fs.watch` resolves the directory it is given
    // and both watches would land on the same one.
    const root = tempRoot();
    const realDir = path.join(root, "real");
    mkdirSync(realDir);
    writeFileSync(path.join(realDir, "tags.json"), "[]");
    const aliasDir = path.join(root, "alias");
    symlinkSync(realDir, aliasDir);

    const fake = new FakeFs();
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    watcher.watch(path.join(aliasDir, "tags.json"), () => {});

    expect(fake.opened).toEqual([aliasDir]);
  });

  it("survives a symlink cycle", () => {
    const root = tempRoot();
    const a = path.join(root, "a.json");
    const b = path.join(root, "b.json");
    symlinkSync(b, a);
    symlinkSync(a, b);

    const fake = new FakeFs();
    const watcher = makeWatcher({ debounceMs: 5, watchFactory: fake.factory });
    // `realpathSync` throws ELOOP. An operator can create this in two
    // commands, so it must be absorbed like any other unresolvable path.
    expect(() => watcher.watch(a, () => {})).not.toThrow();
    expect(watcher.degraded).toBe(false);
    expect(watcher.watchedPaths()).toEqual([a]);
  });
});
