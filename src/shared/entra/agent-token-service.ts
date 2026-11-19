/**
 * Microsoft Entra Agent ID token acquisition with MSAL Node, certificate edition.
 *
 * Two confidential clients, exactly as in the MSAL "FIC and FMI in agentic
 * scenarios" guide:
 *
 *   blueprint CCA  client_id = blueprint app ID, credential = certificate
 *                  Leg 1: client_credentials for api://AzureADTokenExchange/.default
 *                         with fmi_path = agent identity  ->  T1
 *   agent CCA      client_id = agent identity ID, credential = callback returning T1
 *                  Leg 2: app-only        client_credentials for the resource
 *                         OBO             jwt-bearer with the user's token (aud = blueprint)
 *                         agent user      client_credentials for T2, then user_fic
 *
 * The certificate assertion is produced by WebCrypto (see client-assertion.ts)
 * and handed to MSAL through `clientAssertion`. MSAL still owns the protocol,
 * the token cache and retries.
 */
import {
  AuthError,
  ConfidentialClientApplication,
  LogLevel,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from "@azure/msal-node";
import type { AgentIdentityConfig } from "../config.ts";
import type { BlueprintCertificate } from "./certificate.ts";
import { createClientAssertion } from "./client-assertion.ts";
import { FetchNetworkClient } from "./fetch-network-client.ts";

export const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";

export type TokenStage =
  | "leg1-blueprint-fmi"
  | "leg2-agent-app-only"
  | "leg2-agent-obo"
  | "leg2-agent-instance-token"
  | "leg3-agent-user";

/** A token request failed. Carries only non-secret details (AADSTS code, message, correlation id). */
export class TokenAcquisitionError extends Error {
  readonly stage: TokenStage;
  readonly errorCode?: string;
  readonly aadsts?: string;
  readonly correlationId?: string;
  constructor(stage: TokenStage, message: string, details: { errorCode?: string; aadsts?: string; correlationId?: string } = {}) {
    super(message);
    this.name = "TokenAcquisitionError";
    this.stage = stage;
    this.errorCode = details.errorCode;
    this.aadsts = details.aadsts;
    this.correlationId = details.correlationId;
  }
  toJSON() {
    return {
      stage: this.stage,
      errorCode: this.errorCode,
      aadsts: this.aadsts,
      correlationId: this.correlationId,
      message: this.message,
    };
  }
}

function wrapMsalError(stage: TokenStage, err: unknown): TokenAcquisitionError {
  if (err instanceof TokenAcquisitionError) return err;
  if (err instanceof AuthError) {
    const text = err.errorMessage || err.message;
    return new TokenAcquisitionError(stage, text.split("\n")[0].slice(0, 500), {
      errorCode: err.errorCode,
      aadsts: /AADSTS\d+/.exec(text)?.[0],
      correlationId: err.correlationId,
    });
  }
  return new TokenAcquisitionError(stage, err instanceof Error ? err.message : String(err));
}

const LOG_LEVELS: Record<AgentIdentityConfig["msalLogLevel"], LogLevel> = {
  error: LogLevel.Error,
  warning: LogLevel.Warning,
  info: LogLevel.Info,
  verbose: LogLevel.Verbose,
};

export interface AgentUserReference {
  /** UPN of the agent user, or */
  userPrincipalName?: string;
  /** its object ID. Exactly one is used (object ID wins). */
  objectId?: string;
}

export class AgentTokenService {
  readonly config: AgentIdentityConfig;
  readonly certificate: BlueprintCertificate;
  private readonly blueprintApp: ConfidentialClientApplication;
  private readonly agentApp: ConfidentialClientApplication;
  private agentUserAccount?: AccountInfo;

  constructor(config: AgentIdentityConfig, certificate: BlueprintCertificate) {
    this.config = config;
    this.certificate = certificate;
    const authority = `${config.authorityHost}/${config.tenantId}`;
    const system: Configuration["system"] = {
      networkClient: new FetchNetworkClient(),
      loggerOptions: {
        logLevel: LOG_LEVELS[config.msalLogLevel],
        piiLoggingEnabled: false,
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;
          if (level === LogLevel.Error) console.error(`[msal] ${message}`);
          else console.log(`[msal] ${message}`);
        },
      },
    };

    // Blueprint: the only client that holds a real credential (the certificate).
    this.blueprintApp = new ConfidentialClientApplication({
      auth: {
        clientId: config.blueprintClientId,
        authority,
        clientAssertion: async (assertionConfig) =>
          createClientAssertion(certificate, {
            clientId: config.blueprintClientId,
            tokenEndpoint: assertionConfig?.tokenEndpoint || `${authority}/oauth2/v2.0/token`,
            algorithm: config.assertionAlgorithm,
            sendX5c: true, // SN+I: required for the FMI request (Leg 1)
          }),
      },
      system,
    });

    // Agent identity: its "credential" is T1, minted on demand by the blueprint.
    this.agentApp = new ConfidentialClientApplication({
      auth: {
        clientId: config.agentIdentityId,
        authority,
        clientAssertion: async () => this.acquireFmiCredential(),
      },
      system,
    });
  }

  /**
   * Leg 1: the blueprint impersonates its agent identity via fmi_path.
   * MSAL caches T1 per fmi_path, so this rarely hits the network.
   */
  async acquireFmiCredential(): Promise<string> {
    try {
      const result = await this.blueprintApp.acquireTokenByClientCredential({
        scopes: [TOKEN_EXCHANGE_SCOPE],
        fmiPath: this.config.agentIdentityId,
      });
      if (!result?.accessToken) throw new Error("No token returned for the blueprint FMI request");
      return result.accessToken;
    } catch (err) {
      throw wrapMsalError("leg1-blueprint-fmi", err);
    }
  }

  /** Autonomous, app-only: token for the agent identity itself (idtyp=app). */
  async acquireAppToken(scopes: string[]): Promise<AuthenticationResult> {
    try {
      const result = await this.agentApp.acquireTokenByClientCredential({ scopes });
      if (!result) throw new Error("No token returned");
      return result;
    } catch (err) {
      throw wrapMsalError("leg2-agent-app-only", err);
    }
  }

  /**
   * Interactive: on-behalf-of the signed-in user. `userAssertion` is the user's
   * access token whose audience is the BLUEPRINT (otherwise Entra answers AADSTS50013).
   */
  async acquireTokenOnBehalfOf(userAssertion: string, scopes: string[]): Promise<AuthenticationResult> {
    try {
      const result = await this.agentApp.acquireTokenOnBehalfOf({ oboAssertion: userAssertion, scopes });
      if (!result) throw new Error("No token returned");
      return result;
    } catch (err) {
      throw wrapMsalError("leg2-agent-obo", err);
    }
  }

  /**
   * Autonomous with a user context of its own: the agent's agent user (user_fic).
   * Leg 2 gets the agent instance token T2, Leg 3 exchanges it for a delegated
   * token for the agent user. Later calls are served from MSAL's cache.
   */
  async acquireAgentUserToken(scopes: string[], user: AgentUserReference): Promise<AuthenticationResult> {
    if (this.agentUserAccount) {
      try {
        return await this.agentApp.acquireTokenSilent({ scopes, account: this.agentUserAccount });
      } catch {
        // cache miss or expired refresh: run the full exchange below
      }
    }
    let instanceToken: string;
    try {
      const t2 = await this.agentApp.acquireTokenByClientCredential({ scopes: [TOKEN_EXCHANGE_SCOPE] });
      if (!t2?.accessToken) throw new Error("No agent instance token returned");
      instanceToken = t2.accessToken;
    } catch (err) {
      throw wrapMsalError("leg2-agent-instance-token", err);
    }
    try {
      const result = await this.agentApp.acquireTokenByUserFederatedIdentityCredential({
        scopes,
        assertion: instanceToken,
        ...(user.objectId ? { userObjectId: user.objectId } : { username: user.userPrincipalName ?? "" }),
      });
      if (!result) throw new Error("No token returned");
      if (result.account) this.agentUserAccount = result.account;
      return result;
    } catch (err) {
      throw wrapMsalError("leg3-agent-user", err);
    }
  }
}
