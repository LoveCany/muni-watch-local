import assert from "node:assert/strict";
import test from "node:test";
import { ensureRuntimeHelper } from "../collector/runtime-helper.ts";

const digest = "a".repeat(64);
const remote = `/data/local/tmp/muni-unity-invoke-${digest}.so`;

test("reconnecting never overwrites an already deployed content-addressed helper", async () => {
  const calls: string[][] = [];
  await ensureRuntimeHelper(async (...args) => { calls.push(args); return `${digest}  ${remote}`; }, "synthetic.so", remote, digest);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "shell");
});

test("missing helper is deployed and verified; corrupt existing helper is never replaced", async () => {
  const calls: string[][] = [];
  const replies = ["MISSING", "", "", `${digest}  ${remote}`];
  await ensureRuntimeHelper(async (...args) => { calls.push(args); return replies.shift()!; }, "synthetic.so", remote, digest);
  assert.deepEqual(calls[1], ["push", "synthetic.so", remote]);
  assert.equal(calls.length, 4);
  let attempted = 0;
  await assert.rejects(ensureRuntimeHelper(async () => { attempted++; return "b".repeat(64); }, "synthetic.so", remote, digest), /not replaced/);
  assert.equal(attempted, 1);
  await assert.rejects(ensureRuntimeHelper(async () => { throw new Error("transport failed"); }, "synthetic.so", remote, digest), /transport failed/);
});
