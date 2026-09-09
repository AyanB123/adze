import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../parse.mjs";

test("parses valid durations", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2000);
});

test("returns null for unparseable input", () => {
  assert.equal(parseDuration("garbage"), null);
  assert.equal(parseDuration(""), null);
});
