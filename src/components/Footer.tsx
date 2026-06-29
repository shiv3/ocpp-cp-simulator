// components/Footer.tsx
import React from "react";
import { Github } from "lucide-react";

const REPO_URL = "https://github.com/shiv3/ocpp-cp-simulator";

/**
 * Discreet footer pinned to the bottom of the app shell. Self-hosted /
 * web-console users rarely land on the GitHub page, so this gives the
 * project a cheap, always-visible discovery link (issue #93).
 *
 * The version is injected at build time (`__APP_VERSION__`, see vite.config).
 * It's hidden for the unstamped dev default ("0.0.0") so we never show a
 * meaningless "v0.0.0".
 */
const Footer: React.FC = () => {
  const version =
    typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ !== "0.0.0"
      ? `v${__APP_VERSION__}`
      : null;

  return (
    <footer className="mt-auto border-t border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/60 px-4 py-2">
      <div className="flex items-center justify-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium">ocpp-cp-simulator</span>
        {version ? <span>{version}</span> : null}
        <span aria-hidden="true">·</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
        >
          <Github className="h-3.5 w-3.5" />
          GitHub
        </a>
      </div>
    </footer>
  );
};

export default Footer;
