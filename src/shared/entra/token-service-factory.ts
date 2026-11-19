/**
 * One AgentTokenService per isolate. MSAL's in-memory cache (T1, app tokens,
 * OBO tokens keyed by the user assertion) then lives as long as the isolate.
 * Configuration and secrets cannot change inside an isolate: a new deployment
 * or `wrangler secret put` starts new isolates.
 */
import { readAgentIdentityConfig, resolveSecret, type AgentIdentityEnv } from "../config.ts";
import { AgentTokenService } from "./agent-token-service.ts";
import { loadBlueprintCertificate } from "./certificate.ts";

let cached: { key: string; service: Promise<AgentTokenService> } | undefined;

export function getAgentTokenService(env: AgentIdentityEnv): Promise<AgentTokenService> {
  const config = readAgentIdentityConfig(env);
  const key = `${config.tenantId}|${config.blueprintClientId}|${config.agentIdentityId}|${config.assertionAlgorithm}`;
  if (!cached || cached.key !== key) {
    const service = Promise.all([resolveSecret(env.BLUEPRINT_CERT_PEM), resolveSecret(env.BLUEPRINT_KEY_PEM)])
      .then(([certPem, keyPem]) => loadBlueprintCertificate(certPem, keyPem))
      .then((certificate) => new AgentTokenService(config, certificate));
    // Do not cache failures (e.g. a bad secret): the next request retries.
    service.catch(() => {
      if (cached?.service === service) cached = undefined;
    });
    cached = { key, service };
  }
  return cached.service;
}
