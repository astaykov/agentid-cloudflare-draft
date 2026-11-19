/**
 * MSAL network module backed by the Workers `fetch` API.
 *
 * MSAL Node lets you replace its HTTP layer (`system.networkClient`). Supplying
 * one built on `fetch` keeps every Entra call on the runtime's native HTTP
 * stack, with an explicit timeout, and nothing Node-specific in the path.
 * MSAL inspects status codes and error bodies itself, so 4xx/5xx are returned,
 * not thrown.
 */
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";

export class FetchNetworkClient implements INetworkModule {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 15_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    return this.send<T>("GET", url, options, timeout);
  }

  sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
    return this.send<T>("POST", url, options);
  }

  private async send<T>(method: "GET" | "POST", url: string, options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    const response = await fetch(url, {
      method,
      headers: options?.headers,
      body: method === "POST" ? options?.body : undefined,
      signal: AbortSignal.timeout(timeout && timeout > 0 ? timeout : this.defaultTimeoutMs),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: "invalid_response", error_description: `Non-JSON response (HTTP ${response.status})` };
      }
    }
    return { headers, body: body as T, status: response.status };
  }
}
