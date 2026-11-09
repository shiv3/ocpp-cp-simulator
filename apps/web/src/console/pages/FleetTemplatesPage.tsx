import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useState } from "react";
import { Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/methods";
import { useDataContext } from "../../data/providers/DataProvider";
import EmptyState from "../components/EmptyState";
import InlineConfirm from "../components/InlineConfirm";
import PageHeader from "../components/PageHeader";
import { NEW_TEMPLATE_JSON, templateCpCount } from "../lib/fleetTemplates";
import FleetCreateDialog from "./fleets/FleetCreateDialog";
import FleetTemplateDetail from "./fleets/FleetTemplateDetail";
import FleetTemplateEditorDialog from "./fleets/FleetTemplateEditorDialog";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Fleet templates (#445): list, view, save, delete, and create a fleet from a
 * template, over `fleet.template.*` and `fleet.create`. A template lives on the
 * daemon, so a console without one only says so.
 */
const FleetTemplatesPage: React.FC = () => {
  const { t } = useTranslation();
  const { mode, chargePointService: service } = useDataContext();
  const supported =
    mode === "remote" &&
    service.listFleetTemplates !== undefined &&
    service.createFleet !== undefined;

  const [templates, setTemplates] = useState<FleetTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewed, setViewed] = useState<FleetTemplate | null>(null);
  const [editor, setEditor] = useState<{
    mode: "new" | "edit";
    text: string;
  } | null>(null);
  const [creating, setCreating] = useState<FleetTemplate | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setTemplates(await service.listFleetTemplates!());
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [service]);

  useEffect(() => {
    if (supported) void reload();
  }, [supported, reload]);

  if (!supported) {
    return (
      <div className="p-6">
        <PageHeader title={t("fleets.title")} />
        <EmptyState
          icon={Layers}
          title={t("fleets.unsupported.title")}
          hint={t("fleets.unsupported.hint")}
        />
      </div>
    );
  }

  const view = async (id: string): Promise<void> => {
    if (viewed?.id === id) {
      setViewed(null);
      return;
    }
    try {
      setViewed(await service.getFleetTemplate!(id));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };

  const edit = async (id: string): Promise<void> => {
    try {
      const template = await service.getFleetTemplate!(id);
      setEditor({ mode: "edit", text: JSON.stringify(template, null, 2) });
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };

  const save = async (template: FleetTemplate): Promise<void> => {
    await service.saveFleetTemplate!(template);
    setEditor(null);
    await reload();
    // What is open is what was saved, not the copy read before.
    if (viewed?.id === template.id) setViewed(template);
  };

  const remove = async (id: string): Promise<void> => {
    setDeleting(null);
    try {
      await service.deleteFleetTemplate!(id);
      if (viewed?.id === id) setViewed(null);
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title={t("fleets.title")}
        count={templates ? templates.length : undefined}
        actions={
          <Button
            size="sm"
            onClick={() => setEditor({ mode: "new", text: NEW_TEMPLATE_JSON })}
          >
            {t("fleets.new")}
          </Button>
        }
      />
      <p className="mb-4 max-w-2xl text-sm text-cx-muted">
        {t("fleets.intro")}
      </p>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-sm"
        >
          {error}
        </div>
      )}
      {templates === null ? (
        error ? null : (
          <p className="text-sm text-cx-muted">{t("fleets.loading")}</p>
        )
      ) : templates.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={t("fleets.empty.title")}
          hint={t("fleets.empty.hint")}
        />
      ) : (
        <ul className="space-y-2">
          {templates.map((template) => (
            <li
              key={template.id}
              data-template={template.id}
              className="rounded-[10px] border border-cx-border bg-cx-card px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{template.name}</div>
                  <div className="font-mono text-[11px] text-cx-muted">
                    {template.id}
                    <span className="ml-2 font-sans">
                      {t("fleets.groupCount", {
                        count: template.groups.length,
                      })}
                      {" · "}
                      {t("fleets.cpCount", {
                        count: templateCpCount(template),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("fleets.action.viewAria", {
                      name: template.name,
                    })}
                    aria-expanded={viewed?.id === template.id}
                    onClick={() => void view(template.id)}
                  >
                    {viewed?.id === template.id
                      ? t("fleets.action.hide")
                      : t("fleets.action.view")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("fleets.action.editAria", {
                      name: template.name,
                    })}
                    onClick={() => void edit(template.id)}
                  >
                    {t("fleets.action.edit")}
                  </Button>
                  <Button
                    size="sm"
                    aria-label={t("fleets.action.createAria", {
                      name: template.name,
                    })}
                    onClick={() => setCreating(template)}
                  >
                    {t("fleets.action.create")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("fleets.action.deleteAria", {
                      name: template.name,
                    })}
                    onClick={() => setDeleting(template.id)}
                  >
                    {t("fleets.action.delete")}
                  </Button>
                </div>
              </div>
              {deleting === template.id && (
                <InlineConfirm
                  danger
                  className="mt-2"
                  message={t("fleets.delete.confirm", { name: template.name })}
                  confirmLabel={t("fleets.delete.yes")}
                  cancelLabel={t("fleets.delete.no")}
                  onConfirm={() => void remove(template.id)}
                  onCancel={() => setDeleting(null)}
                />
              )}
              {viewed?.id === template.id && (
                <div className="mt-3">
                  <FleetTemplateDetail template={viewed} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editor && (
        <FleetTemplateEditorDialog
          mode={editor.mode}
          initialText={editor.text}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
      {creating && (
        <FleetCreateDialog
          template={creating}
          onCreate={(params) => service.createFleet!(params)}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
};

export default FleetTemplatesPage;
