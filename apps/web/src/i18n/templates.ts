import { useTranslation } from "react-i18next";

/**
 * Display helpers for built-in scenario templates. Only template pickers use
 * these: user-created scenarios are never translated, and the template's
 * stored `id` / `name` (used when a scenario is created from it) is unchanged.
 * An id without a translation falls back to the original text.
 */
export function useTemplateText(): {
  name: (template: { id: string; name: string }) => string;
  description: (template: { id: string; description: string }) => string;
} {
  const { t } = useTranslation();
  // The key is only known at runtime, so it cannot be a typed key.
  const lookup = t as (
    key: string,
    options: { defaultValue: string },
  ) => string;
  return {
    name: (template) =>
      lookup(`templates.${template.id}.name`, { defaultValue: template.name }),
    description: (template) =>
      lookup(`templates.${template.id}.description`, {
        defaultValue: template.description,
      }),
  };
}
