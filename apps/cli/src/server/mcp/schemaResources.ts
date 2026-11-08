import type { McpServer } from "mcp-lite";
import { schemas } from "@ocpp-cp-sim/ocpp/schemas";

/**
 * #613: the OCA JSON Schemas of every OCPP message as MCP resources, so an
 * agent can read the schema of a message before it builds a `send_ocpp_call`
 * payload.
 *
 * The content is the vendored schema object serialized with the vendored
 * files' own 4-space indent: no key is added, removed or rewritten. Every
 * read also returns the vendored NOTICE (attribution, CC BY-ND 4.0 for the
 * 2.1 schemas) as a second content item, so the license travels with the
 * schema.
 */

export const OCPP_SCHEMA_VERSIONS = ["v16", "v201", "v21"] as const;
export type OcppSchemaVersion = (typeof OCPP_SCHEMA_VERSIONS)[number];

const VERSION_LABEL: Record<OcppSchemaVersion, string> = {
  v16: "OCPP 1.6",
  v201: "OCPP 2.0.1",
  v21: "OCPP 2.1",
};

export const OCPP_SCHEMA_NOTICE_URI = "ocpp-schema://NOTICE";

/** Verbatim text of `packages/ocpp/vendor/ocpp-schemas/NOTICE`. */
export const OCPP_SCHEMA_NOTICE = [
  "OCPP JSON Schemas — Attribution",
  "================================",
  "These JSON Schema files are the official Open Charge Alliance (OCA) OCPP message",
  "schemas, vendored VERBATIM (unmodified) from the public repository:",
  "  https://github.com/mobilityhouse/ocpp  @ commit d6b003d9f3ab411994f67d428ea51a82991f49e0",
  "under ocpp/{v16,v201,v21}/schemas/.",
  "",
  "OCPP and its schemas are (c) Open Charge Alliance. The OCPP 2.1 schemas are licensed",
  "Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0). The files",
  "here are redistributed unmodified, with attribution; they are NOT modified (no patches/",
  "overrides applied). Generated TypeScript types/validators derived from them live under",
  "src/ocpp/ and are this project's own work.",
  "",
].join("\n");

export interface OcppSchemaEntry {
  version: OcppSchemaVersion;
  /** OCPP action name, e.g. `BootNotification`. */
  action: string;
  direction: "request" | "response";
  uri: string;
  schema: object;
}

export function schemaUri(
  version: string,
  action: string,
  direction: "request" | "response",
): string {
  return `ocpp-schema://${version}/${action}/${direction}`;
}

/** Every vendored schema, ordered by version, then action, then direction. */
export function listOcppSchemas(): OcppSchemaEntry[] {
  const entries: OcppSchemaEntry[] = [];
  for (const version of OCPP_SCHEMA_VERSIONS) {
    for (const [key, schema] of Object.entries(schemas[version])) {
      // Generated keys are "<action>Request<V>" / "<action>Response<V>", with
      // the action camel-cased (so "AFRRSignal" is "afrrSignal"). Recover the
      // exact casing from the schema's own `$id` or `title` when it carries
      // the same name, else capitalize the first letter.
      const m = /^(.+?)(Request|Response)V\d+$/.exec(key);
      if (!m) continue;
      const direction = m[2] === "Request" ? "request" : "response";
      const fallback = m[1][0].toUpperCase() + m[1].slice(1);
      const named = schema as { $id?: unknown; title?: unknown };
      const candidates = [
        typeof named.$id === "string" ? named.$id.split(":").pop() : undefined,
        typeof named.title === "string" ? named.title : undefined,
      ];
      const action =
        candidates
          .map((c) => c?.replace(/(Request|Response)$/, ""))
          .find((c) => c && c.toLowerCase() === fallback.toLowerCase()) ??
        fallback;
      entries.push({
        version,
        action,
        direction,
        uri: schemaUri(version, action, direction),
        schema,
      });
    }
  }
  return entries.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

export function registerSchemaResources(mcp: McpServer): void {
  mcp.resource(
    OCPP_SCHEMA_NOTICE_URI,
    {
      name: "OCPP JSON Schemas: license notice",
      description:
        "Attribution and license (OCA; CC BY-ND 4.0 for the 2.1 schemas) of the OCPP JSON Schemas served as resources.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          type: "text",
          text: OCPP_SCHEMA_NOTICE,
          mimeType: "text/plain",
        },
      ],
    }),
  );

  for (const entry of listOcppSchemas()) {
    mcp.resource(
      entry.uri,
      {
        name: `${VERSION_LABEL[entry.version]} ${entry.action} ${entry.direction}`,
        description:
          `JSON Schema of the ${entry.action} ${entry.direction} (${VERSION_LABEL[entry.version]}), ` +
          "as published by the Open Charge Alliance, unmodified. " +
          `License notice: ${OCPP_SCHEMA_NOTICE_URI}`,
        mimeType: "application/schema+json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            type: "text",
            text: JSON.stringify(entry.schema, null, 4),
            mimeType: "application/schema+json",
          },
          {
            uri: OCPP_SCHEMA_NOTICE_URI,
            type: "text",
            text: OCPP_SCHEMA_NOTICE,
            mimeType: "text/plain",
          },
        ],
      }),
    );
  }
}
