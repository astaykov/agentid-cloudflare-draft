/**
 * Lets the Node tests load the Cloudflare-native echo MCP server without the
 * Workers runtime: three packages are swapped for small stand-ins that follow
 * their documented contracts (see ./stubs). Everything else resolves normally.
 * Used only by `npm test`; Wrangler bundles the real packages.
 */
import { register } from "node:module";

register("./stub-loader.mjs", import.meta.url);
