// components/Navbar.tsx
import React from "react";
import { Link } from "react-router-dom";
import ThemeToggle from "./ThemeToggle.tsx";

const Navbar: React.FC = () => {
  return (
    <nav className="bg-blue-600 dark:bg-gray-800 text-white shadow-lg transition-colors">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link className="text-xl font-bold hover:text-blue-200 dark:hover:text-blue-400 transition-colors" to="/">
            OCPP ChargePoint Simulator
          </Link>
          <div className="flex items-center space-x-4">
            <ul className="flex space-x-4">
              <li>
                <Link className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors" to="/">
                  ChargePoint
                </Link>
              </li>
              <li>
                <Link className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors" to="/settings">
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
