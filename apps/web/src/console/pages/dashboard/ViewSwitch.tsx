import { useTranslation } from "react-i18next";
import React from "react";

import { type MessageKey } from "../../../i18n";
import SegmentedControl from "../../components/SegmentedControl";
import type { CpListView } from "./cpListFilters";

const VIEWS: Array<{ value: CpListView; labelKey: MessageKey }> = [
  { value: "hierarchy", labelKey: "dashboard.view.hierarchy" },
  { value: "cp", labelKey: "dashboard.view.cp" },
  { value: "connectors", labelKey: "dashboard.view.connectors" },
];

/** Segmented control that picks how the list is laid out. */
const ViewSwitch: React.FC<{
  view: CpListView;
  onChange: (view: CpListView) => void;
}> = ({ view, onChange }) => {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      label={t("dashboard.view.label")}
      options={VIEWS.map(({ value, labelKey }) => ({
        value,
        label: t(labelKey),
      }))}
      value={view}
      onChange={onChange}
    />
  );
};

export default ViewSwitch;
