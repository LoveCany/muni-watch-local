import assert from "node:assert/strict";
import test from "node:test";
import { withOperationDeadline } from "../collector/operation-deadline.ts";

test("native RPC that ignores cancellation cannot leave the host capture waiting forever", { timeout: 1000 }, async () => {
  let blocked = false;
  await assert.rejects(withOperationDeadline(() => new Promise<never>(() => {}), () => { blocked = true; }, 10), /timed out/);
  assert.equal(blocked, true);
});

test("deadline preserves completed results and failures without cancelling later", async () => {
  let cancellations = 0;
  const cancel = () => { cancellations++; };
  assert.equal(await withOperationDeadline(async () => 42, cancel, 10), 42);
  const failure = new Error("Synthetic RPC failure");
  await assert.rejects(withOperationDeadline(async () => { throw failure; }, cancel, 10), error => error === failure);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cancellations, 0);
});
