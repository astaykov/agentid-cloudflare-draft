/** Echo MCP server Worker, dependency-free edition. See server.ts. */
import { handleEchoRequest, type EchoEnv } from "./server.ts";

export default {
  async fetch(request: Request, env: EchoEnv): Promise<Response> {
    try {
      return await handleEchoRequest(request, env);
    } catch (err) {
      console.error("echo-mcp-lite error", err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
} satisfies ExportedHandler<EchoEnv>;
