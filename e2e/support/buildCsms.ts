import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_TIMEOUT_MS = 120_000;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const binaryPath = join(repoRoot, "e2e", "csms", "e2e-csms");

async function streamToText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  try {
    let isDone = false;
    while (!isDone) {
      const result = await reader.read();
      if (result.done) {
        isDone = true;
      } else {
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}

export async function buildCsms(): Promise<string> {
  // The gocpp revision the fixture builds against is pinned in
  // e2e/csms/go.mod + go.sum (#322): `go build` fetches it from the module
  // proxy, so a clean machine needs Go on PATH and network — no sibling
  // checkout. Bun.spawn throws ENOENT when `go` is missing; say so plainly.
  let proc: ReturnType<typeof Bun.spawn<{ stdout: "pipe"; stderr: "pipe" }>>;
  try {
    proc = Bun.spawn(["go", "-C", "e2e/csms", "build", "-o", "e2e-csms", "."], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    console.error(
      "e2e: could not start `go` — the CSMS fixture is a Go program. " +
        "Install Go 1.26+ (https://go.dev/dl/) and make sure `go` is on PATH; " +
        "see e2e/README.md. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    process.exit(1);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, BUILD_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
    proc.exited.finally(() => clearTimeout(timer)),
  ]);

  if (timedOut) {
    console.error(`go build timed out after ${BUILD_TIMEOUT_MS}ms`);
    if (stderr.trim()) console.error(stderr);
    if (stdout.trim()) console.error(stdout);
    process.exit(1);
  }

  if (exitCode !== 0) {
    if (stderr.trim()) console.error(stderr);
    process.exit(1);
  }

  return binaryPath;
}

if (import.meta.main) {
  console.log(await buildCsms());
}
