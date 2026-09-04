import type * as fs from "fs";
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
