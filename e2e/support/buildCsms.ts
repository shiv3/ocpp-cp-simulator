import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A cold install downloads gocpp and its dependencies first. */
const BUILD_TIMEOUT_MS = 300_000;
const CSMS_PACKAGE = "github.com/shiv3/gocpp/cmd/gocpp-csms";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
/** The one place the CSMS version is pinned (a gocpp tag or pseudo-version). */
const versionFile = join(repoRoot, "e2e", "gocpp-csms.version");
/** Repo-local GOBIN (gitignored), so the install never touches ~/go/bin. */
const binDir = join(repoRoot, "e2e", ".bin");
const binaryPath = join(binDir, "gocpp-csms");

function pinnedVersion(): string {
  const version = readFileSync(versionFile, "utf8").trim();
  if (!/^v\d+\.\d+\.\d+\S*$/.test(version)) {
    throw new Error(
      `${versionFile}: expected a gocpp module version such as v0.4.1 or a ` +
        `pseudo-version, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

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

/** The one place the install command is spelled. Kept as a function so the
 *  subprocess type is inferred from `Bun.spawn` rather than restated. */
function spawnGoInstall(version: string) {
  return Bun.spawn(["go", "install", `${CSMS_PACKAGE}@${version}`], {
    cwd: repoRoot,
    env: { ...process.env, GOBIN: binDir },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function buildCsms(): Promise<string> {
  // The CSMS is gocpp's cmd/gocpp-csms at the version pinned in
  // e2e/gocpp-csms.version: `go install pkg@version` fetches it from the
  // module proxy (checksummed by the sum database), so a clean machine needs
  // Go on PATH and network, and no sibling checkout. Bun.spawn throws ENOENT
  // when `go` is missing; say so plainly.
  const version = pinnedVersion();
  let proc: ReturnType<typeof spawnGoInstall>;
  try {
    proc = spawnGoInstall(version);
  } catch (error) {
    console.error(
      "e2e: could not start `go` — the e2e CSMS is installed with " +
        `\`go install ${CSMS_PACKAGE}@${version}\`. ` +
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
    console.error(`go install timed out after ${BUILD_TIMEOUT_MS}ms`);
    if (stderr.trim()) console.error(stderr);
    if (stdout.trim()) console.error(stdout);
    process.exit(1);
  }

  if (exitCode !== 0) {
    console.error(`e2e: go install ${CSMS_PACKAGE}@${version} failed`);
    if (stderr.trim()) console.error(stderr);
    process.exit(1);
  }

  return binaryPath;
}

if (import.meta.main) {
  console.log(await buildCsms());
}
