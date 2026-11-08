import * as fs from "node:fs";
import * as path from "node:path";
import { format } from "node:util";

/**
 * Daemon log level and file output (#621).
 *
 * Everything the simulator logs reaches the console through `console.debug`,
 * `console.info`, `console.warn` and `console.error` (the core `Logger` maps
 * its four levels onto them). {@link installLogSink} wraps those four so the
 * daemon can drop lines below `--log-level` and copy the rest into a rotated
 * file. Nothing is wrapped when neither is asked for, so stdout and stderr are
 * byte-for-byte what they were — the open-ocpp-tck contract depends on the
 * `[WebSocket] Sent:` / `Received:` lines.
 *
 * The level filters the console and the file. The `logs` table of `--state-db`
 * and the in-memory buffer behind `logs.get` keep every entry: they are the
 * record a post-mortem reads, not an output the operator turns down.
 */

export type ConsoleLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly ConsoleLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];

export function parseLogLevel(value: string | undefined): ConsoleLevel | null {
  const level = (value ?? "").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(level)
    ? (level as ConsoleLevel)
    : null;
}

/** `10m`, `512k`, `2g` or plain bytes; null when malformed or zero. */
export function parseSize(value: string | undefined): number | null {
  const match = /^(\d+)\s*([kmg]?)b?$/i.exec((value ?? "").trim());
  if (!match) return null;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2].toLowerCase() as "" | "k" | "m" | "g"
  ];
  const bytes = Number(match[1]) * unit;
  return bytes > 0 ? bytes : null;
}

export interface RotatingFileOptions {
  readonly file: string;
  /** Rotate when the file would grow past this many bytes. */
  readonly maxBytes?: number;
  /** Rotate when the local date changes. */
  readonly daily?: boolean;
  /** Rotated files to keep (`file.1` … `file.N`). Default 5. */
  readonly keep?: number;
  readonly now?: () => Date;
}

/**
 * Append-only log file with size and/or daily rotation. Rotation renames
 * `file` to `file.1`, shifting `file.1` to `file.2` and so on, and deletes the
 * one past `keep`. A write that fails is reported once on stderr and later
 * lines are dropped from the file; the daemon must not die for a full disk.
 */
export class RotatingFile {
  private fd: number;
  private size: number;
  private day: string;
  private failed = false;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(private readonly options: RotatingFileOptions) {
    this.keep = Math.max(0, options.keep ?? 5);
    this.now = options.now ?? (() => new Date());
    fs.mkdirSync(path.dirname(path.resolve(options.file)), { recursive: true });
    this.fd = fs.openSync(options.file, "a");
    this.size = fs.fstatSync(this.fd).size;
    // A file left by an earlier run counts as the day it was last written.
    this.day = localDay(
      this.size > 0 ? fs.fstatSync(this.fd).mtime : this.now(),
    );
  }

  write(line: string): void {
    if (this.failed) return;
    try {
      const data = line.endsWith("\n") ? line : `${line}\n`;
      const bytes = Buffer.byteLength(data);
      const today = localDay(this.now());
      const tooBig =
        this.options.maxBytes !== undefined &&
        this.size > 0 &&
        this.size + bytes > this.options.maxBytes;
      const newDay = this.options.daily === true && today !== this.day;
      if (tooBig || newDay) this.rotate();
      this.day = today;
      fs.writeSync(this.fd, data);
      this.size += bytes;
    } catch (err) {
      this.failed = true;
      process.stderr.write(
        `[server] log file ${this.options.file} is no longer written: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  private rotate(): void {
    fs.closeSync(this.fd);
    const file = this.options.file;
    if (this.keep === 0) {
      fs.rmSync(file, { force: true });
    } else {
      fs.rmSync(`${file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) {
          fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
      }
      fs.renameSync(file, `${file}.1`);
    }
    this.fd = fs.openSync(file, "a");
    this.size = 0;
  }
}

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface LogSinkOptions {
  readonly level?: ConsoleLevel;
  readonly file?: RotatingFileOptions;
}

/** True when {@link installLogSink} would change anything. */
export function isLogSinkRequested(options: LogSinkOptions): boolean {
  return options.level !== undefined || options.file !== undefined;
}

/**
 * Wrap the four console methods of `target`. Returns a function that removes
 * the wrapper and closes the file. A no-op when nothing was requested.
 */
export function installLogSink(
  options: LogSinkOptions,
  target: Pick<Console, ConsoleLevel> = console,
): () => void {
  if (!isLogSinkRequested(options)) return () => {};
  const threshold = LOG_LEVELS.indexOf(options.level ?? "debug");
  const file = options.file ? new RotatingFile(options.file) : null;
  const originals = {} as Record<ConsoleLevel, (...args: unknown[]) => void>;
  LOG_LEVELS.forEach((level, rank) => {
    const original = target[level].bind(target) as (...args: unknown[]) => void;
    originals[level] = target[level] as (...args: unknown[]) => void;
    target[level] = (...args: unknown[]): void => {
      if (rank < threshold) return;
      original(...args);
      file?.write(format(...args));
    };
  });
  return () => {
    for (const level of LOG_LEVELS) target[level] = originals[level];
    file?.close();
  };
}
