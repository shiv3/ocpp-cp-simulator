// components/Footer.tsx
import React from "react";
import AppBuildInfo from "./AppBuildInfo";
import { useServerInfo } from "../data/hooks/useServerInfo";

/**
 * Discreet footer pinned to the bottom of the app shell. Self-hosted /
 * web-console users rarely land on the GitHub page, so this gives the
 * project a cheap, always-visible discovery link (issue #93).
 */
const Footer: React.FC = () => {
  const serverInfo = useServerInfo();
  return (
    <footer className="mt-auto border-t border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/60 px-4 py-2">
      <AppBuildInfo
        className="justify-center"
        daemonVersion={serverInfo?.version}
      />
    </footer>
  );
};

export default Footer;
