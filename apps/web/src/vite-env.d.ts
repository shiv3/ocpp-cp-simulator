/// <reference types="vite/client" />

/** App version injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;

/**
 * Commit SHA injected at build time from $APP_COMMIT (see vite.config.ts).
 * Empty unless the build sets it — the GitHub Pages deploy and the Docker
 * image built with `--build-arg APP_COMMIT` do.
 */
declare const __APP_COMMIT__: string;
