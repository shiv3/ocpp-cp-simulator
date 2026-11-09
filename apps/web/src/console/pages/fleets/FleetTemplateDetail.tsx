import { useTranslation } from "react-i18next";
import React from "react";

import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/methods";
import LabelChips from "../../components/LabelChips";
import { memberTarget, templateCpCount } from "../../lib/fleetTemplates";

export interface FleetTemplateDetailProps {
  template: FleetTemplate;
}

/**
 * A fleet template read as a table: its groups, and per member line which
 * charge point(s) it makes, from which blueprint, with which scenario
 * template. The blueprint and scenario are shown by id only: the template
 * owns no definition of its own (#445).
 */
const FleetTemplateDetail: React.FC<FleetTemplateDetailProps> = ({
  template,
}) => {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("fleets.detail.aria", { name: template.name })}
      className="space-y-3 rounded-[10px] border border-cx-border bg-cx-card p-4"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">{template.name}</h2>
        <code className="font-mono text-[11px] text-cx-muted">
          {template.id}
        </code>
        <span className="text-[12px] text-cx-muted">
          {t("fleets.cpCount", { count: templateCpCount(template) })}
        </span>
        <LabelChips labels={template.labels} />
      </div>
      {template.description && (
        <p className="text-sm text-cx-fg2">{template.description}</p>
      )}
      {template.groups.map((group) => (
        <div key={group.name} data-group={group.name}>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold">{group.name}</h3>
            <LabelChips labels={group.labels} />
          </div>
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-cx-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">
                  {t("fleets.detail.col.target")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("fleets.detail.col.blueprint")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("fleets.detail.col.scenario")}
                </th>
                <th className="py-1 font-medium">
                  {t("fleets.detail.col.extras")}
                </th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((member, index) => {
                const extras = [
                  member.evSettings ? t("fleets.detail.evSettings") : null,
                  member.networkSimulation
                    ? t("fleets.detail.networkSimulation")
                    : null,
                  member.overrides ? t("fleets.detail.overrides") : null,
                ].filter((x): x is string => x !== null);
                return (
                  <tr
                    key={`${memberTarget(member)}-${index}`}
                    className="border-t border-cx-border"
                  >
                    <td className="py-1 pr-3 font-mono">
                      {memberTarget(member)}
                    </td>
                    <td className="py-1 pr-3 font-mono">
                      {member.blueprintId}
                    </td>
                    <td className="py-1 pr-3 font-mono">
                      {member.scenarioTemplateId ?? "—"}
                    </td>
                    <td className="py-1">
                      <span className="mr-2">{extras.join(", ")}</span>
                      <LabelChips labels={member.labels} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
};

export default FleetTemplateDetail;
