/**
 * `spawn()` on Node (#916), shaped like `Bun.spawn` with stdin ignored and
 * stdout / stderr piped. Like `Bun.spawn`, a missing executable throws an
 * `ENOENT` error synchronously (Node's `child_process.spawn` would report it
 * later through an `error` event), so callers keep one error path.
 */
import { spawn as spawnChild } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "../types";

export function spawnNode(options: SpawnOptions): SpawnedProcess {
  const [command, ...args] = options.cmd;
  if (!command) throw new Error("spawn: empty command");
  const env = definedEnv(options.env);
  const executable = resolveExecutable(command, env);
  if (!executable) {
    const error = new Error(
      `Executable not found in $PATH: "${command}"`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    error.path = command;
    throw error;
  }
  const child = spawnChild(executable, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(child.exitCode));
  });
  return {
    stdout: Readable.toWeb(
      child.stdout,
    ) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(
      child.stderr,
    ) as unknown as ReadableStream<Uint8Array>,
    exited,
    kill: () => {
      child.kill();
    },
  };
}

function definedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `command` as a path to an executable file, looked up on PATH like a shell. */
export function resolveExecutable(
  command: string,
  env: Record<string, string>,
): string | null {
  if (command.includes("/") || command.includes(path.sep)) {
    return isExecutable(command) ? command : null;
  }
  const pathVar = env.PATH ?? env.Path ?? process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
      : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
