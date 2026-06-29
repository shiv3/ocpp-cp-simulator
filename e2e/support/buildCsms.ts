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
  const proc = Bun.spawn(
    ["go", "-C", "e2e/csms", "build", "-o", "e2e-csms", "."],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );

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
