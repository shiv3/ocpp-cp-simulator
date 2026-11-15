import * as fs from "fs";

import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import { tlsKeyPermissionWarning } from "../../tlsKeyPermissions";
import type { ChargePointRow } from "./rowMapping";

export function restoreTlsFromPaths(
  options: { readonly allowInsecureTlsKeyPerms?: boolean },
  row: ChargePointRow,
  securityProfile: OcppSecurityProfile | undefined,
): OcppTlsOptions | undefined {
  if (
    (securityProfile === 1 || securityProfile === 2) &&
    !row.authorization_key
  ) {
    throw new Error(
      `Refusing to restore CP "${row.cp_id}" with securityProfile ` +
        `${securityProfile}: authorizationKey is required.`,
    );
  }
  if (securityProfile === 3 && (!row.tls_cert_path || !row.tls_key_path)) {
    throw new Error(
      `Refusing to restore CP "${row.cp_id}" with securityProfile 3: ` +
        "tlsCertPath and tlsKeyPath are required for mTLS.",
    );
  }

  return readTlsFromPaths(options, {
    cpId: row.cp_id,
    tlsCaPath: row.tls_ca_path,
    tlsCertPath: row.tls_cert_path,
    tlsKeyPath: row.tls_key_path,
  });
}

export function readTlsFromPaths(
  options: { readonly allowInsecureTlsKeyPerms?: boolean },
  paths: {
    readonly cpId: string;
    readonly tlsCaPath: string | null;
    readonly tlsCertPath: string | null;
    readonly tlsKeyPath: string | null;
  },
): OcppTlsOptions | undefined {
  const tls: {
    ca?: string;
    cert?: string;
    key?: string;
  } = {};
  if (paths.tlsCaPath) {
    tls.ca = readRestoredPem(paths.cpId, "--tls-ca", paths.tlsCaPath);
  }
  if (paths.tlsCertPath) {
    tls.cert = readRestoredPem(paths.cpId, "--tls-cert", paths.tlsCertPath);
  }
  if (paths.tlsKeyPath) {
    const warning = tlsKeyPermissionWarning(paths.tlsKeyPath);
    if (warning && !options.allowInsecureTlsKeyPerms) {
      throw new Error(
        `Refusing to restore CP "${paths.cpId}": ${warning}. ` +
          "Restart the daemon with --insecure-tls-key-perms to override.",
      );
    }
    if (warning) {
      process.stderr.write(
        `[CPRegistry] Warning: ${warning}; proceeding because ` +
          "--insecure-tls-key-perms was passed.\n",
      );
    }
    tls.key = readRestoredPem(paths.cpId, "--tls-key", paths.tlsKeyPath);
  }
  return Object.keys(tls).length > 0 ? tls : undefined;
}

function readRestoredPem(cpId: string, flag: string, filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Refusing to restore CP "${cpId}": failed to read ${flag} file ` +
        `'${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
