import React from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TAB_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "transactions", label: "Transactions" },
  { value: "logs", label: "Message Log" },
  { value: "config", label: "Configuration" },
  { value: "diagnostics", label: "Diagnostics" },
];

export interface CpTabsProps {
  value: string;
  onValueChange: (value: string) => void;
  /** `<TabsContent value="...">` elements, one per `TAB_ITEMS` entry. */
  children: React.ReactNode;
}

/**
 * Tab shell for the CP detail page (Transactions / Message Log /
 * Configuration / Diagnostics). Thin wrapper around the shared Radix
 * `Tabs` primitive — content panels are supplied by the caller as children
 * so this file stays free of any page-specific logic.
 */
const CpTabs: React.FC<CpTabsProps> = ({ value, onValueChange, children }) => (
  <Tabs value={value} onValueChange={onValueChange}>
    <TabsList>
      {TAB_ITEMS.map((tab) => (
        <TabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
    {children}
  </Tabs>
);

export default CpTabs;
