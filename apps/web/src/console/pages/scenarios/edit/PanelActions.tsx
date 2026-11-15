import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Maximize2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The side panel's header buttons: Cancel, expand to the page, close. */
export const PanelActions: React.FC<{
  onCancel?: () => void;
  expand?: { to: string; label: string };
  onClose?: () => void;
  handleCancel: () => void;
  handleClose: () => void;
}> = ({ onCancel, expand, onClose, handleCancel, handleClose }) => {
  const { t } = useTranslation();
  return (
    <>
      {onCancel && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCancel}
        >
          {t("scenarios.common.cancel")}
        </Button>
      )}
      {expand && (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="px-2"
          title={expand.label}
        >
          <Link to={expand.to} aria-label={expand.label}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
      {onClose && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-2"
          aria-label={t("scenarios.panel.closeAria")}
          title={t("scenarios.panel.closeTitle")}
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </>
  );
};
