import React from "react";

export interface PageHeaderProps {
  title: React.ReactNode;
  count?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  count,
  actions,
  children,
}) => (
  <div className="mb-4 flex flex-wrap items-center gap-3">
    <div className="flex items-baseline gap-3">
      <h1 className="text-lg font-semibold">{title}</h1>
      {count != null && (
        <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
          {count}
        </span>
      )}
    </div>
    {children}
    {actions != null && (
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    )}
  </div>
);

export default PageHeader;
