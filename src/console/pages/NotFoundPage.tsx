import React from "react";
import { Link, useLocation } from "react-router-dom";
import PageHeader from "../components/PageHeader";

/** Any path the console does not route (and no legacy redirect claimed). */
const NotFoundPage: React.FC = () => {
  const { pathname } = useLocation();
  return (
    <div className="p-6">
      <Link
        to="/"
        className="mb-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to charge points
      </Link>
      <PageHeader title="Page not found" />
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Nothing lives at <span className="font-mono">{pathname}</span>.
      </p>
    </div>
  );
};

export default NotFoundPage;
