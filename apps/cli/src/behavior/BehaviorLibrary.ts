import { behaviorShapeProblem } from "@ocpp-cp-sim/core/cp/application/engine/behaviorFit";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { readBehaviorFile } from "./readBehaviorFile";

/** A `behaviors` entry that names no loaded behavior. */
export class UnknownBehaviorError extends Error {
  constructor(
    readonly unknown: readonly string[],
    readonly loaded: readonly string[],
  ) {
    super(
      `Unknown behavior id${unknown.length > 1 ? "s" : ""} ${unknown
        .map((id) => JSON.stringify(id))
        .join(", ")}; loaded behaviors: ${
        loaded.length > 0 ? loaded.join(", ") : "none"
      }`,
    );
    this.name = "UnknownBehaviorError";
  }
}

/** A selected behavior that a station cannot run (`requires`, `beforeSend` on SOAP). */
export class BehaviorNotLoadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BehaviorNotLoadableError";
  }
}

/** What applying a reloaded behavior to the charge points did. */
export interface ReplaceOutcome {
  /** Charge points that now run the new version. */
  readonly applied: number;
  /** Charge points that kept the old version, with the reason. */
  readonly failures: readonly string[];
}

export interface ReloadFileResult {
  readonly file: string;
  readonly ids: readonly string[];
  /** The file was read and is now the version in use (or already was). */
  readonly ok: boolean;
  /** The bundle is the one already loaded: nothing was replaced. */
  readonly unchanged: boolean;
  readonly error?: string;
  /** Charge points that run the new version. */
  readonly applied: number;
  /** Charge points that kept the old one, with the reason. */
  readonly failures: readonly string[];
}

interface Entry {
  behavior: Behavior;
  readonly file: string | null;
}

/**
 * The behaviors this process loaded (`--behavior`), by id. Code enters here
 * only from local files named on the command line; a charge point selects from
 * the library by id, as data. The library remembers the paths, so a reload
 * re-reads exactly those and nothing a caller supplies.
 */
export class BehaviorLibrary {
  private readonly entries = new Map<string, Entry>();
  private readonly files: string[] = [];
  private readonly fileIds = new Map<string, string[]>();
  private readonly hashes = new Map<string, string>();
  private readonly listeners = new Set<
    (behaviors: readonly Behavior[]) => ReplaceOutcome
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers: FSWatcher[] = [];

  /**
   * Whether the daemon's `behavior.reload` method may re-read the files. Set
   * from `--watch-behaviors` or `--allow-behavior-reload`; a library used by
   * tests and embedders allows it.
   */
  rpcReloadAllowed = true;

  /** How long a reloaded module's top level may take before the reload fails. */
  importTimeoutMs = 2_000;

  constructor(
    private readonly log: (message: string) => void = (message) =>
      process.stderr.write(`${message}\n`),
  ) {}

  /** A library of behaviors that did not come from files (tests, embedding). */
  static of(behaviors: readonly Behavior[]): BehaviorLibrary {
    const library = new BehaviorLibrary();
    for (const behavior of behaviors) library.add(behavior, null);
    return library;
  }

  /** Read every file, in order. Throws if one cannot be loaded or an id repeats. */
  static async fromFiles(
    files: readonly string[],
    log?: (message: string) => void,
  ): Promise<BehaviorLibrary> {
    const library = new BehaviorLibrary(log);
    for (const file of files) {
      const { behaviors, hash } = await readBehaviorFile(file);
      library.files.push(file);
      library.hashes.set(file, hash);
      library.fileIds.set(
        file,
        behaviors.map((b) => b.id),
      );
      for (const behavior of behaviors) library.add(behavior, file);
    }
    return library;
  }

  private add(behavior: Behavior, file: string | null): void {
    const problem = behaviorShapeProblem(behavior);
    if (problem) throw new Error(problem);
    if (this.entries.has(behavior.id)) {
      throw new Error(`Behavior id "${behavior.id}" is loaded twice`);
    }
    this.entries.set(behavior.id, { behavior, file });
  }

  get size(): number {
    return this.entries.size;
  }

  /** The loaded ids, in load order. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** True while `--watch-behaviors` is reloading on file changes. */
  get watching(): boolean {
    return this.watchers.length > 0;
  }

  /** The paths given at start, in order. */
  get paths(): readonly string[] {
    return this.files;
  }

  describe(): Array<{ id: string; file: string | null }> {
    return [...this.entries].map(([id, e]) => ({ id, file: e.file }));
  }

  /** Every loaded behavior, in load order. */
  all(): Behavior[] {
    return [...this.entries.values()].map((e) => e.behavior);
  }

  /**
   * The behaviors a charge point with `ids` runs: all of them when `ids` is
   * undefined (no selection), else the named ones in library order. Throws
   * {@link UnknownBehaviorError}, naming the loaded ids, for an id that is
   * not loaded.
   */
  select(ids: readonly string[] | undefined): Behavior[] {
    if (ids === undefined) return this.all();
    this.check(ids);
    const wanted = new Set(ids);
    return this.all().filter((b) => wanted.has(b.id));
  }

  check(ids: readonly string[]): void {
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) {
      throw new UnknownBehaviorError([...new Set(unknown)], this.ids());
    }
  }

  get(id: string): Behavior | undefined {
    return this.entries.get(id)?.behavior;
  }

  /**
   * Register a function that applies the reloaded behaviors of one file to the
   * charge points running them, all or none on each charge point. Returns the
   * unsubscribe function.
   */
  onReplace(
    listener: (behaviors: readonly Behavior[]) => ReplaceOutcome,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Re-read the files given at start. A file whose bundle did not change is
   * left alone. A file that fails to build or load, or whose set of ids
   * changed, keeps its old version and the error is logged and reported:
   * the reload of a file is all or nothing. Reloads run one at a time.
   */
  reload(): Promise<ReloadFileResult[]> {
    const run = this.queue.then(() => this.reloadNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reloadNow(): Promise<ReloadFileResult[]> {
    const results: ReloadFileResult[] = [];
    for (const file of this.files) {
      const oldIds = this.fileIds.get(file) ?? [];
      let contents;
      try {
        contents = await readBehaviorFile(file, {
          previousHash: this.hashes.get(file),
          timeoutMs: this.importTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(
          `[behavior] reload of ${file} failed, keeping the old version: ${message}`,
        );
        results.push({
          file,
          ids: oldIds,
          ok: false,
          unchanged: false,
          error: message,
          applied: 0,
          failures: [],
        });
        continue;
      }
      if (contents.unchanged) {
        results.push({
          file,
          ids: oldIds,
          ok: true,
          unchanged: true,
          applied: 0,
          failures: [],
        });
        continue;
      }
      const nextIds = contents.behaviors.map((b) => b.id);
      const duplicate = nextIds.find((id, i) => nextIds.indexOf(id) !== i);
      if (
        duplicate !== undefined ||
        nextIds.length !== oldIds.length ||
        nextIds.some((id) => !oldIds.includes(id))
      ) {
        const message =
          duplicate !== undefined
            ? `${file} declares the behavior id "${duplicate}" twice`
            : `the behavior ids of ${file} changed from [${oldIds.join(", ")}] to [${nextIds.join(", ")}]; restart to add or remove behaviors`;
        this.log(
          `[behavior] reload refused, keeping the old version: ${message}`,
        );
        results.push({
          file,
          ids: oldIds,
          ok: false,
          unchanged: false,
          error: message,
          applied: 0,
          failures: [],
        });
        continue;
      }
      let applied = 0;
      const failures: string[] = [];
      for (const listener of [...this.listeners]) {
        try {
          const outcome = listener(contents.behaviors);
          applied += outcome.applied;
          failures.push(...outcome.failures);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      // The file counts as the version in use only when no charge point kept
      // the old one: otherwise the next reload must try again, not call it
      // unchanged. A new charge point takes the new code as soon as one runs it.
      const refusedEverywhere = failures.length > 0 && applied === 0;
      if (!refusedEverywhere) {
        for (const behavior of contents.behaviors) {
          const entry = this.entries.get(behavior.id);
          if (entry) entry.behavior = behavior;
        }
      }
      if (failures.length === 0) this.hashes.set(file, contents.hash);
      for (const failure of failures) {
        this.log(`[behavior] ${failure}`);
      }
      this.log(
        `[behavior] reloaded ${file} (${nextIds.join(", ")}) on ${applied} charge point${applied === 1 ? "" : "s"}`,
      );
      results.push({
        file,
        ids: nextIds,
        ok: failures.length === 0,
        unchanged: false,
        applied,
        failures,
      });
    }
    return results;
  }

  /**
   * Reload when a file in the directory of a behavior file changes (its
   * imports are bundled in, so they count). Editors that save by renaming
   * are covered because the directory is watched, not the file. Returns a
   * function that stops watching.
   *
   * A reload waits for `debounceMs` of quiet, but never longer than
   * `maxWaitMs` after the first change, so a busy neighbor (a state database
   * in the same directory) cannot starve it. Database and log files are not
   * behavior inputs and are ignored; an unrelated write that gets through
   * costs a bundle and a hash comparison, not a run of the module.
   */
  watch(debounceMs = 150, maxWaitMs = 1_000): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstAt = 0;
    const fire = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      firstAt = 0;
      void this.reload().catch((error: unknown) =>
        this.log(
          `[behavior] reload failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    };
    const trigger = (): void => {
      const now = Date.now();
      if (firstAt === 0) firstAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        fire,
        Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now)),
      );
    };
    const dirs = new Set(this.files.map((f) => path.dirname(path.resolve(f))));
    for (const dir of dirs) {
      try {
        this.watchers.push(
          watch(dir, { recursive: true }, (_event, name) => {
            if (name && IGNORED_WATCH_NAME.test(String(name))) return;
            trigger();
          }),
        );
      } catch (error) {
        this.log(
          `[behavior] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return () => {
      if (timer) clearTimeout(timer);
      for (const w of this.watchers) w.close();
      this.watchers = [];
    };
  }
}

/** Paths whose changes never concern a behavior bundle. */
const IGNORED_WATCH_NAME =
  /node_modules|\.git[\\/]|\.(db|sqlite3?|log|jsonl)(-wal|-shm|-journal)?$|-(wal|shm|journal)$/;
