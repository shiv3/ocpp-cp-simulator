// Installed in the image as /app/src/cli/main.ts (#346).
//
// Until #590 the image ran the CLI from source, and open-ocpp-tck starts it as
// `docker run -i --entrypoint bun <image> src/cli/main.ts --json …`. The image
// now carries only the bundle, dist-cli/main.js, so this file keeps that
// command line working: it runs the bundle with the same arguments, stdio and
// exit code. (Importing the bundle would not do: its entry point only runs
// when it is the main module.) New callers should not rely on this path; the
// supported way is `docker run -i <image> --json …`, see
// docs/entities/docker-image.md.
const bundle = new URL("../../dist-cli/main.js", import.meta.url).pathname;

const child = Bun.spawn([process.execPath, bundle, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

process.exit(await child.exited);
