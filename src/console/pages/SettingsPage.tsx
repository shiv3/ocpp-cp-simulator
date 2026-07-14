import React from "react";
import { Link } from "react-router-dom";
import Settings from "../../components/Settings";

const SettingsPage: React.FC = () => (
  <div className="p-6 space-y-4">
    <div className="flex justify-end">
      <Link
        to="/"
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        Open classic UI
      </Link>
    </div>
    <Settings />
  </div>
);

export default SettingsPage;
