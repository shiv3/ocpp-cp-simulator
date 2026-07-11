// components/Footer.tsx
import React from "react";

const REPO_URL = "https://github.com/shiv3/ocpp-cp-simulator";

// lucide-react dropped brand icons in v1, so the GitHub mark ships as a small
// local SVG instead of pulling in a separate brand-icon package.
const GithubMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.24 1.91 1.24 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
  </svg>
);

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
          <GithubMark className="h-3.5 w-3.5" />
          GitHub
        </a>
      </div>
    </footer>
  );
};

export default Footer;
