/** The key of an action's request schema in `schemas.v16` / `v201` / `v21`:
 *  camelCase plus the version, e.g. ("BootNotification", "V16") ->
 *  "bootNotificationRequestV16". */
export function requestSchemaKey(
  action: string,
  version: "V16" | "V201" | "V21",
): string {
  return `${action.charAt(0).toLowerCase()}${action.slice(1)}Request${version}`;
}
