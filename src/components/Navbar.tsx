// components/Navbar.tsx
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { profilesStateAtom, setActiveProfileIdAtom } from "../store/store.ts";

const Navbar: React.FC = () => {
  const profilesState = useAtomValue(profilesStateAtom);
  const setActiveProfileId = useSetAtom(setActiveProfileIdAtom);
  const location = useLocation();

  const navLinkClass = (path: string) =>
    [
      "rounded-md px-3 py-2 text-sm font-medium transition-colors",
      location.pathname === path
        ? "bg-white/15 text-white shadow-sm"
        : "text-blue-50 hover:bg-white/10 hover:text-white",
    ].join(" ");

  return (
    <nav className="border-b border-blue-500/30 bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-md">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center justify-between gap-3">
          <Link
            className="truncate text-lg font-bold tracking-tight text-white sm:text-xl"
            to="/"
          >
            OCPP ChargePoint Simulator
          </Link>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-4">
            <ul className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <li>
                <Link className={navLinkClass("/")} to="/">
                  <span className="hidden sm:inline">ChargePoint</span>
                  <span className="sm:hidden">CP</span>
                </Link>
              </li>
              <li>
                <Link className={navLinkClass("/settings")} to="/settings">
                  <span className="hidden sm:inline">Settings</span>
                  <span className="sm:hidden">Set</span>
                </Link>
              </li>
            </ul>

            <div
              className="hidden h-7 w-px shrink-0 bg-white/25 sm:block"
              aria-hidden
            />

            <div className="flex min-w-0 max-w-[min(100%,14rem)] items-center gap-2 rounded-lg bg-blue-900/25 px-2 py-1.5 ring-1 ring-white/15 sm:max-w-[16rem] sm:px-3">
              <span className="hidden text-[11px] font-semibold uppercase tracking-wide text-blue-100/95 md:inline">
                Profile
              </span>
              <select
                className="w-full min-w-0 cursor-pointer truncate rounded-md border-0 bg-white py-2 pl-2.5 pr-8 text-sm font-medium text-slate-800 shadow-sm ring-1 ring-slate-900/10 focus:outline-none focus:ring-2 focus:ring-blue-200"
                value={profilesState.activeProfileId}
                title="Active settings profile (clears URL hash when changed)"
                aria-label="Active settings profile"
                onChange={(e) => setActiveProfileId(e.target.value)}
              >
                {profilesState.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
