import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolArguments, CliArgumentError, parseArgPairs } from "../scripts/lib/cli-args.mjs";

test("--arg key=value pairs become string arguments", () => {
  assert.deepEqual(parseArgPairs(["message=hello world", "filter=a=b", "empty="]), { message: "hello world", filter: "a=b", empty: "" });
  assert.deepEqual(parseArgPairs([]), {});
  assert.throws(() => parseArgPairs(["message"]), CliArgumentError);
  assert.throws(() => parseArgPairs(["=value"]), /key=value/);
});

test("--args JSON and --arg pairs are merged; --arg wins", () => {
  assert.deepEqual(buildToolArguments('{"message":"from json","count":2}', ["message=from arg"]), { message: "from arg", count: 2 });
  assert.deepEqual(buildToolArguments(undefined, ["message=hi"]), { message: "hi" });
  assert.deepEqual(buildToolArguments(undefined, []), {});
});

test("invalid --args explains the PowerShell-friendly alternative", () => {
  // What PowerShell 5.1 hands to npm.cmd for --args '{"message":"hi"}': the inner quotes are gone.
  assert.throws(() => buildToolArguments("{message:hi}"), /In PowerShell use --arg message=hello instead/);
  assert.throws(() => buildToolArguments("[1,2]"), /must be a JSON object/);
});
