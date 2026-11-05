import type React from "react";

export type NodeFormData = Record<string, unknown>;

export interface NodeFormComponentProps<
  TFormData extends NodeFormData = NodeFormData,
> {
  value: TFormData;
  onChange: (value: TFormData) => void;
  onOpenMeterCurve?: () => void;
}

export type NodeFormComponent<TFormData extends NodeFormData = NodeFormData> =
  React.ComponentType<NodeFormComponentProps<TFormData>>;
