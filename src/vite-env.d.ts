/// <reference types="vite/client" />

/** App version injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;

/**
 * Short commit SHA injected at build time from $APP_COMMIT (see vite.config.ts).
 * Empty unless the build sets it — only the GitHub Pages deploy does.
 */
declare const __APP_COMMIT__: string;
