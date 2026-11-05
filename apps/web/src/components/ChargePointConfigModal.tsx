import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ChargePointConfigForm from "./ChargePointConfigForm";
import {
  defaultChargePointConfig,
  type ChargePointConfig,
  type SoapPublicBase,
} from "./chargePointConfig";

// The shape and the pure helpers moved to `chargePointConfig.ts` so the form
// and this wrapper both stay component-only files; callers keep importing
// them from here.
export {
  defaultChargePointConfig,
  describeSoapPublicBase,
  previewDerivedSoapCallbackUrl,
  sanitizeChargePointConfigForSave,
} from "./chargePointConfig";
export type { ChargePointConfig, SoapPublicBase } from "./chargePointConfig";

interface ChargePointConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: ChargePointConfig) => void;
  initialConfig?: ChargePointConfig;
  isNewChargePoint?: boolean;
  /**
   * Active runtime mode. Currently used only to label and disable a few
   * fields that don't have a remote equivalent yet (e.g. the local tag list).
   */
  mode?: "local" | "remote";
  /**
   * `server.info`'s `soap` block: the public base the daemon derives a
   * missing callback URL from (`--soap-public-base-url` / `--soap-tunnel`).
   * With one, the callback URL becomes optional here and the derived value
   * is previewed. null when unknown (local mode, older daemon).
   */
  soapPublicBase?: SoapPublicBase | null;
}

/**
 * The Add / Configure dialog: a `Dialog` around `ChargePointConfigForm`.
 * Save hands the config to `onSave` and closes at once, as before the form
 * was extracted for the charge point page's inline Config card.
 */
const ChargePointConfigModal: React.FC<ChargePointConfigModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialConfig,
  isNewChargePoint = false,
  mode = "local",
  soapPublicBase = null,
}) => (
  <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
    <DialogContent
      className="sm:max-w-5xl max-h-[90vh] overflow-y-auto"
      // The Charge Point ID is no longer the first field (Model specification
      // comes first), so a new charge point opens with the id focused, where
      // the first Tab used to land.
      onOpenAutoFocus={(event) => {
        const cpId = isNewChargePoint ? document.getElementById("cpId") : null;
        if (!(cpId instanceof HTMLInputElement)) return;
        event.preventDefault();
        cpId.focus();
        cpId.select();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {isNewChargePoint
            ? "Add New Charge Point"
            : `Configure ${(initialConfig ?? defaultChargePointConfig).cpId}`}
        </DialogTitle>
      </DialogHeader>
      <ChargePointConfigForm
        initialConfig={initialConfig}
        isNewChargePoint={isNewChargePoint}
        mode={mode}
        soapPublicBase={soapPublicBase}
        onSave={(config) => {
          onSave(config);
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogContent>
  </Dialog>
);

export default ChargePointConfigModal;
