import { useDynamicT } from "./index";

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
  const dt = useDynamicT();
  return {
    name: (template) => dt(`templates.${template.id}.name`, template.name),
    description: (template) =>
      dt(`templates.${template.id}.description`, template.description),
  };
}
