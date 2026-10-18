import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientAbortedError, HttpError } from "../src/errors.js";
import { WorkGate } from "../src/limit/workGate.js";

describe("WorkGate", () => {
  it("runs one task for two callers and rejects a different key when the slot is taken", async () => {
    const gate = new WorkGate(1);
    let calls = 0;
    let release: (value: string) => void = () => {};
    const first = gate.run("same", new AbortController().signal, () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const joined = gate.run("same", new AbortController().signal, async () => {
      calls += 1;
      return "other";
    });
    const busy = gate.run("different", new AbortController().signal, async () => "no");
    await assert.rejects(busy, (error: unknown) => error instanceof HttpError && error.code === "overloaded");
    release("ok");
    const [leader, follower] = await Promise.all([first, joined]);
    assert.equal(calls, 1);
    assert.equal(leader.shared, false);
    assert.equal(follower.shared, true);
    assert.equal(leader.value, "ok");
    assert.equal(follower.value, "ok");
  });

  it("cancels the task when its only caller aborts", async () => {
    const gate = new WorkGate(1);
    const controller = new AbortController();
    let sawAbort = false;
    const pending = gate.run("key", controller.signal, (signal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new ClientAbortedError());
        });
      });
    });
    controller.abort();
    await assert.rejects(pending, ClientAbortedError);
    assert.equal(sawAbort, true);
    const next = await gate.run("key", new AbortController().signal, async () => "free");
    assert.equal(next.value, "free");
  });
});