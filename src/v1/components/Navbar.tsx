// components/Navbar.tsx
import React from "react";
import { Link } from "react-router-dom";

const Navbar: React.FC = () => {
  return (
    <nav className="bg-blue-600 text-white shadow-lg">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link className="text-xl font-bold" to="/v1">
            OCPP ChargePoint Simulator (v1)
          </Link>
          <ul className="flex space-x-4">
            <li>
              <Link className="hover:text-blue-200" to="/v1">
                ChargePoint
              </Link>
            </li>
            <li>
              <Link className="hover:text-blue-200" to="/v1/settings">
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
