// components/Navbar.tsx
import React from "react";
import { Link } from "react-router-dom";
import ThemeToggle from "./ThemeToggle.tsx";
import { useDataContext } from "../data/providers/DataProvider";

const Navbar: React.FC = () => {
  const { mode, serverUrl } = useDataContext();
  const isRemote = mode === "remote";
  const badgeLabel = isRemote
    ? `Remote · ${serverUrl.replace(/^https?:\/\//, "")}`
    : "Local";
  const badgeTitle = isRemote
    ? `Remote · ${serverUrl} — click to change`
    : "Local — click to change";

  return (
    <nav className="bg-blue-600 dark:bg-gray-800 text-white shadow-lg transition-colors">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <Link
              className="text-xl font-bold hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
              to="/"
            >
              OCPP ChargePoint Simulator
            </Link>
            <Link
              to="/settings"
              title={badgeTitle}
              className={`text-xs font-semibold px-2 py-0.5 rounded transition-colors ${
                isRemote
                  ? "bg-emerald-500/30 text-emerald-100 hover:bg-emerald-500/50"
                  : "bg-white/20 hover:bg-white/30"
              }`}
            >
              {badgeLabel}
            </Link>
          </div>
          <div className="flex items-center space-x-4">
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
