/**
 * Tool arguments for scripts/client/agent-cli.mjs.
 *
 *   --args '<json>'        a JSON object (numbers, booleans, nested values)
 *   --arg key=value        a string value; repeat for more. No JSON quoting, so it works the
 *                          same in bash, cmd and PowerShell (where npm.cmd strips inner quotes)
 *
 * Both can be combined; --arg wins for the same key.
 */

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliArgumentError";
  }
}

/** ["message=hello world", "a=b=c"] -> { message: "hello world", a: "b=c" } */
export function parseArgPairs(pairs = []) {
  const result = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    const key = index > 0 ? pair.slice(0, index).trim() : "";
    if (!key) throw new CliArgumentError(`--arg must look like key=value, got '${pair}'`);
    result[key] = pair.slice(index + 1);
  }
  return result;
}

/** Merges --args (JSON object) and --arg pairs into the tool's arguments. */
export function buildToolArguments(argsJson, pairs = []) {
  let base = {};
  if (argsJson) {
    try {
      base = JSON.parse(argsJson);
    } catch {
      throw new CliArgumentError(
        "--args must be JSON, for example --args '{\"message\":\"hello\"}'. In PowerShell use --arg message=hello instead.",
      );
    }
    if (!base || typeof base !== "object" || Array.isArray(base)) throw new CliArgumentError("--args must be a JSON object");
  }
  return { ...base, ...parseArgPairs(pairs) };
}
