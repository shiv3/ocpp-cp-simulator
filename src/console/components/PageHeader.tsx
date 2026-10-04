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
      <Title
        className={
          Title === "h1"
            ? "text-xl font-semibold tracking-[-0.015em]"
            : "text-[17px] font-semibold tracking-[-0.015em]"
        }
      >
        {title}
      </Title>
      {count != null && (
        <span className="text-[13px] font-normal text-cx-muted">{count}</span>
      )}
    </div>
    {children}
    {actions != null && (
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    )}
  </div>
);

export default PageHeader;
