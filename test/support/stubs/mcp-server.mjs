/**
 * Test stand-in for McpServer from @modelcontextprotocol/server (SDK v2):
 * registerTool(name, { title, description, inputSchema, annotations }, handler)
 * with handler(args, context), Zod (Standard Schema) input validation, and just
 * enough JSON-RPC for initialize / tools/list / tools/call.
 */
import { z } from "zod";

export class McpServer {
  constructor(info, options = {}) {
    this.info = info;
    this.options = options;
    this.tools = new Map();
  }

  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
  }

  async handleForTests(message, context) {
    const reply = (result) => Response.json({ jsonrpc: "2.0", id: message.id, result });
    if (message.id === undefined) return new Response(null, { status: 202 });
    switch (message.method) {
      case "initialize":
        return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: this.info, instructions: this.options.instructions });
      case "tools/list":
        return reply({
          tools: [...this.tools].map(([name, { config }]) => ({
            name,
            title: config.title,
            description: config.description,
            inputSchema: config.inputSchema ? z.toJSONSchema(config.inputSchema) : { type: "object" },
          })),
        });
      case "tools/call": {
        const tool = this.tools.get(message.params?.name);
        if (!tool) return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } });
        const parsed = tool.config.inputSchema.safeParse(message.params?.arguments ?? {});
        if (!parsed.success) return reply({ content: [{ type: "text", text: parsed.error.message }], isError: true });
        return reply(await tool.handler(parsed.data, context));
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }
}
