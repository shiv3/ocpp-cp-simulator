import React from "react";

import SegmentedControl from "../../components/SegmentedControl";
import type { CpListView } from "./cpListFilters";

const VIEWS: Array<{ value: CpListView; label: string }> = [
  { value: "hierarchy", label: "Hierarchy" },
  { value: "cp", label: "Charge points" },
  { value: "connectors", label: "Connectors" },
];

/** Segmented control that picks how the list is laid out. */
const ViewSwitch: React.FC<{
  view: CpListView;
  onChange: (view: CpListView) => void;
}> = ({ view, onChange }) => (
  <SegmentedControl
    label="View"
    options={VIEWS}
    value={view}
    onChange={onChange}
  />
);

export default ViewSwitch;
