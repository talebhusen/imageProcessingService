import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("rejects a limit that is not a decimal integer", () => {
    const previous = process.env.MAX_EDGE_PX;
    process.env.MAX_EDGE_PX = "1e3";
    try {
      assert.throws(() => loadConfig(), /MAX_EDGE_PX/);
    } finally {
      restore("MAX_EDGE_PX", previous);
    }
  });

  it("rejects a limit above its cap", () => {
    const previous = process.env.INFLIGHT_LIMIT;
    process.env.INFLIGHT_LIMIT = "33";
    try {
      assert.throws(() => loadConfig(), /INFLIGHT_LIMIT/);
    } finally {
      restore("INFLIGHT_LIMIT", previous);
    }
  });
});

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
