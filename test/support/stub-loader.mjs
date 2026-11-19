const STUBS = {
  "@cloudflare/workers-oauth-provider": new URL("./stubs/workers-oauth-provider.mjs", import.meta.url).href,
  "agents/mcp/server": new URL("./stubs/agents-mcp-server.mjs", import.meta.url).href,
  "@modelcontextprotocol/server": new URL("./stubs/mcp-server.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: STUBS[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}
