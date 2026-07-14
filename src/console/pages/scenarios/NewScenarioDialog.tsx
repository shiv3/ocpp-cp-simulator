import React, { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

export interface NewScenarioTarget {
  cpId: string;
  connectorId: number | null;
  name?: string;
}

export interface NewScenarioDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  chargePoints: ChargePointSnapshot[];
  /** Shows a Name text field when true (the "+ New scenario" flow). Template
   *  and import flows already carry a name on the incoming scenario. */
  requireName?: boolean;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (target: NewScenarioTarget) => void;
}

/**
 * Shared "pick a target CP + connector (or charge-point scope)" dialog used
 * by all three scenario-creation flows on the library page: + New scenario,
 * Use template, and Import JSON. Native <select>s (not the Radix Select
 * primitive) — this only needs to work in jsdom dom tests without extra
 * pointer-capture/scrollIntoView polyfills.
 */
const NewScenarioDialog: React.FC<NewScenarioDialogProps> = ({
  isOpen,
  title,
  description,
  chargePoints,
  requireName = false,
  confirmLabel = "Create",
  onClose,
  onConfirm,
}) => {
  const [cpId, setCpId] = useState("");
  const [connectorValue, setConnectorValue] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setCpId(chargePoints[0]?.id ?? "");
    setConnectorValue("");
    setName("");
    // Only reset when the dialog transitions open; re-running on every
    // chargePoints re-fetch would clobber the operator's in-progress pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const selectedCp = chargePoints.find((cp) => cp.id === cpId);
  const connectors = selectedCp?.connectors ?? [];
  const canConfirm =
    cpId.length > 0 && (!requireName || name.trim().length > 0);

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({
      cpId,
      connectorId: connectorValue === "" ? null : Number(connectorValue),
      name: requireName ? name.trim() : undefined,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-3">
          {requireName && (
            <div className="space-y-1">
              <Label htmlFor="new-scenario-name">Name</Label>
              <Input
                id="new-scenario-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Scenario name"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="new-scenario-cp">Charge point</Label>
            <select
              id="new-scenario-cp"
              value={cpId}
              onChange={(e) => {
                setCpId(e.target.value);
                setConnectorValue("");
              }}
              className="w-full rounded-md border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="" disabled>
                Select a charge point
              </option>
              {chargePoints.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.id}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="new-scenario-connector">Target</Label>
            <select
              id="new-scenario-connector"
              value={connectorValue}
              onChange={(e) => setConnectorValue(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="">Charge point (all connectors)</option>
              {connectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  Connector {connector.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NewScenarioDialog;
