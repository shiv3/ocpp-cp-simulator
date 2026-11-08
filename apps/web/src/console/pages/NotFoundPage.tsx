import React from "react";
import { Link, useLocation } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useT } from "../../i18n";

/** Any path the console does not route (and no legacy redirect claimed). */
const NotFoundPage: React.FC = () => {
  const { pathname } = useLocation();
  const t = useT();
  const [before, after = ""] = t("common.notFound.nothingAt", {
    path: "\u0001",
  }).split("\u0001");
  return (
    <div className="p-6">
      <Link
        to="/"
        className="mb-2 inline-block text-sm text-cx-accent hover:underline"
      >
        {t("common.notFound.back")}
      </Link>
      <PageHeader title={t("common.notFound.title")} />
      <p className="text-sm text-cx-fg2">
        {before}
        <span className="font-mono">{pathname}</span>
        {after}
      </p>
    </div>
  );
};

export default NotFoundPage;
