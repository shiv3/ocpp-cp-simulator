// components/Navbar.tsx
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Server } from "lucide-react";
import ThemeToggle from "./ThemeToggle.tsx";
import { useDataContext } from "../data/providers/DataProvider";

const Navbar: React.FC = () => {
  const { mode, serverUrl, setMode, setServerUrl } = useDataContext();
  const [open, setOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState(serverUrl);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraftUrl(serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const applyUrl = () => {
    if (draftUrl.trim()) {
      setServerUrl(draftUrl.trim());
    }
  };

  return (
    <nav className="bg-blue-600 dark:bg-gray-800 text-white shadow-lg transition-colors">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link
            className="text-xl font-bold hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
            to="/"
          >
            OCPP ChargePoint Simulator
          </Link>
          <div className="flex items-center space-x-4">
            <div className="flex items-center gap-1 bg-white/10 rounded-md p-0.5">
              <button
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  mode === "local"
                    ? "bg-white text-blue-700"
                    : "text-white/80 hover:text-white"
                }`}
                onClick={() => setMode("local")}
              >
                Local
              </button>
              <button
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  mode === "remote"
                    ? "bg-white text-blue-700"
                    : "text-white/80 hover:text-white"
                }`}
                onClick={() => setMode("remote")}
              >
                Remote
              </button>
            </div>

            <div className="relative" ref={popoverRef}>
              <button
                onClick={() => setOpen((p) => !p)}
                className="flex items-center gap-1 text-sm px-2 py-1 rounded hover:bg-white/10"
                title="Server URL"
              >
                <Server className="h-4 w-4" />
                <span className="hidden md:inline max-w-[16ch] truncate">
                  {serverUrl.replace(/^https?:\/\//, "")}
                </span>
              </button>
              {open && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg p-3 z-50">
                  <label className="block text-xs font-semibold mb-1">
                    Remote server URL
                  </label>
                  <input
                    type="text"
                    value={draftUrl}
                    onChange={(e) => setDraftUrl(e.target.value)}
                    placeholder="http://127.0.0.1:9700"
                    className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-sm"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      onClick={() => setOpen(false)}
                      className="text-sm px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        applyUrl();
                        setOpen(false);
                      }}
                      className="text-sm px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Apply
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    The URL is used when mode is set to Remote. It is stored in
                    localStorage so it persists across reloads.
                  </p>
                </div>
              )}
            </div>

            <ul className="flex space-x-4">
              <li>
                <Link
                  className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
                  to="/"
                >
                  ChargePoint
                </Link>
              </li>
              <li>
                <Link
                  className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
                  to="/settings"
                >
                  Settings
                </Link>
              </li>
            </ul>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
