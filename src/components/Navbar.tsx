// components/Navbar.tsx
import React from "react";
import { Link } from "react-router-dom";

const Navbar: React.FC = () => {
  return (
    <nav className="bg-blue-600 text-white shadow-lg">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link className="text-xl font-bold" to="/">
            OCPP ChargePoint Simulator
          </Link>
          <ul className="flex space-x-4">
            <li>
              <Link className="hover:text-blue-200" to="/">
                ChargePoint
              </Link>
            </li>
            <li>
              <Link className="hover:text-blue-200" to="/settings">
                Settings
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
