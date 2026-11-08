import type { McpServer } from "mcp-lite";
import { schemaNotice, schemaSources } from "@ocpp-cp-sim/ocpp/schemaSources";

/**
 * #613: the OCA JSON Schemas of every OCPP message as MCP resources, so an
 * agent can read the schema of a message before it builds a `send_ocpp_call`
 * payload.
 *
 * The content is the text of the vendored file, byte for byte: the OCA schemas
 * are CC BY-ND 4.0 and may be redistributed only unmodified, so nothing is
 * parsed and re-serialized on the way (`schemaSources` is generated from the
 * files by `scripts/generate-ocpp.ts`). The URI is built from the file name.
 * Every read also returns the vendored NOTICE as a second content item, and
 * every resource's description carries the license link, so the attribution
 * and the license travel with the schema.
 */

export const OCPP_SCHEMA_VERSIONS = ["v16", "v201", "v21"] as const;
export type OcppSchemaVersion = (typeof OCPP_SCHEMA_VERSIONS)[number];

const VERSION_LABEL: Record<OcppSchemaVersion, string> = {
  v16: "OCPP 1.6",
  v201: "OCPP 2.0.1",
  v21: "OCPP 2.1",
};

export const OCPP_SCHEMA_NOTICE_URI = "ocpp-schema://NOTICE";

/** Verbatim text of `packages/ocpp/vendor/ocpp-schemas/NOTICE` (generated). */
export const OCPP_SCHEMA_NOTICE = schemaNotice;

/** The license of the OCA schemas, which CC BY-ND 4.0 §3(a)(1)(A)(iii) asks us to link. */
export const OCPP_SCHEMA_LICENSE_URL =
  "https://creativecommons.org/licenses/by-nd/4.0/";

/** One line of attribution, repeated in every resource description. */
const ATTRIBUTION = `© Open Charge Alliance, CC BY-ND 4.0 (${OCPP_SCHEMA_LICENSE_URL}), unmodified`;

export interface OcppSchemaEntry {
  version: OcppSchemaVersion;
  /** OCPP action name, e.g. `BootNotification`. */
  action: string;
  direction: "request" | "response";
  uri: string;
  /** The vendored file's text, unmodified. */
  text: string;
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
    for (const source of schemaSources[version]) {
      entries.push({
        version,
        action: source.action,
        direction: source.direction,
        uri: schemaUri(version, source.action, source.direction),
        text: source.text,
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
      description: `Attribution and license of the OCPP JSON Schemas served as resources: ${ATTRIBUTION}.`,
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
        description: `JSON Schema, ${ATTRIBUTION}. Notice: ${OCPP_SCHEMA_NOTICE_URI}`,
        mimeType: "application/schema+json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            type: "text",
            text: entry.text,
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
