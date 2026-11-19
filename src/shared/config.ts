/** Environment shared by both Workers: the agent's Entra Agent ID configuration. */
import type { AssertionAlgorithm } from "./entra/certificate.ts";

/** A Worker secret is a string; a Secrets Store binding exposes get(). */
export type SecretValue = string | { get(): Promise<string> };

export async function resolveSecret(value: SecretValue | undefined): Promise<string> {
  if (!value) return "";
  return typeof value === "string" ? value : await value.get();
}

export interface AgentIdentityEnv {
  /** Directory (tenant) ID. */
  TENANT_ID: string;
  /** Application (client) ID of the agent identity blueprint. */
  BLUEPRINT_CLIENT_ID: string;
  /** Object ID (= client ID) of the agent identity created from the blueprint. */
  AGENT_IDENTITY_ID: string;
  /**
   * The blueprint certificate (PEM). A Worker secret (string) or a Secrets Store
   * binding (object with get()).
   */
  BLUEPRINT_CERT_PEM: SecretValue;
  /** The blueprint private key (PEM, unencrypted PKCS#8 or PKCS#1). Worker secret or Secrets Store binding. */
  BLUEPRINT_KEY_PEM: SecretValue;
  /** "PS256" (default, x5t#S256) or "RS256" (legacy, x5t). */
  ASSERTION_ALGORITHM?: string;
  /** "error" | "warning" (default) | "info" | "verbose". MSAL never logs PII here. */
  MSAL_LOG_LEVEL?: string;
  /** Override for sovereign clouds. Default https://login.microsoftonline.com */
  AUTHORITY_HOST?: string;
}

export interface AgentIdentityConfig {
  tenantId: string;
  blueprintClientId: string;
  agentIdentityId: string;
  assertionAlgorithm: AssertionAlgorithm;
  msalLogLevel: "error" | "warning" | "info" | "verbose";
  authorityHost: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readAgentIdentityConfig(env: AgentIdentityEnv): AgentIdentityConfig {
  const problems: string[] = [];
  for (const name of ["TENANT_ID", "BLUEPRINT_CLIENT_ID", "AGENT_IDENTITY_ID"] as const) {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    else if (!GUID.test(value)) problems.push(`${name} must be a GUID`);
  }
  for (const name of ["BLUEPRINT_CERT_PEM", "BLUEPRINT_KEY_PEM"] as const) {
    if (!env[name]) problems.push(`secret ${name} is not set`);
  }
  const algorithm = (env.ASSERTION_ALGORITHM || "PS256").toUpperCase();
  if (algorithm !== "PS256" && algorithm !== "RS256") problems.push("ASSERTION_ALGORITHM must be PS256 or RS256");
  const level = (env.MSAL_LOG_LEVEL || "warning").toLowerCase();
  if (!["error", "warning", "info", "verbose"].includes(level)) problems.push("MSAL_LOG_LEVEL must be error, warning, info or verbose");
  if (problems.length) throw new ConfigurationError(`Agent identity configuration: ${problems.join("; ")}`);
  return {
    tenantId: env.TENANT_ID.toLowerCase(),
    blueprintClientId: env.BLUEPRINT_CLIENT_ID.toLowerCase(),
    agentIdentityId: env.AGENT_IDENTITY_ID.toLowerCase(),
    assertionAlgorithm: algorithm as AssertionAlgorithm,
    msalLogLevel: level as AgentIdentityConfig["msalLogLevel"],
    authorityHost: (env.AUTHORITY_HOST || "https://login.microsoftonline.com").replace(/\/+$/, ""),
  };
}

/** Splits "a b,c" into ["a","b","c"]. */
export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
