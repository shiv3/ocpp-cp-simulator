import React from "react";

export interface PageHeaderProps {
  title: React.ReactNode;
  /** Heading level of the title; a panel inside a page uses 2. */
  titleAs?: "h1" | "h2";
  count?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  titleAs: Title = "h1",
  count,
  actions,
  children,
}) => (
  <div className="mb-4 flex flex-wrap items-center gap-3">
    <div className="flex items-baseline gap-3">
      <Title className="text-lg font-semibold">{title}</Title>
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
