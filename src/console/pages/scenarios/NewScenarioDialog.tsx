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

export interface NewScenarioDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

/**
 * The name prompt of **+ New scenario**. A new scenario goes into the Library,
 * which has no target: each connector picks its scenario on the charge point
 * page, so there is no charge point or connector to choose here.
 */
const NewScenarioDialog: React.FC<NewScenarioDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  const [name, setName] = useState("");

  useEffect(() => {
    if (isOpen) setName("");
  }, [isOpen]);

  const canConfirm = name.trim().length > 0;
  const handleConfirm = () => {
    if (canConfirm) onConfirm(name.trim());
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New scenario</DialogTitle>
          <DialogDescription>
            It goes into the Library; connectors pick it on the charge point
            page.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <Label htmlFor="new-scenario-name">Name</Label>
          <Input
            id="new-scenario-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Scenario name"
            autoFocus
          />
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!canConfirm}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NewScenarioDialog;
