import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { describe, it, before, after } from "node:test";
import { createApp, type ProcessLog } from "../src/server.js";
import { testConfig } from "./helpers.js";

describe("HTTP foundation", () => {
  let server: Server;
  let base: string;
  const events: ProcessLog[] = [];

  before(async () => {
    server = createApp(testConfig(), (event) => {
      events.push(event);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a tcp address");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.close();
    await once(server, "close");
  });

  it("returns health", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("returns 400 for a bad width", async () => {
    const response = await fetch(`${base}/process?url=https://example.com/a.jpg&width=nope`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_parameter",
        message: "width must be an integer from 1 to 2048",
        param: "width",
      },
    });
    const event = events.at(-1);
    assert.equal(event?.code, "invalid_parameter");
    assert.equal(event?.status, 400);
    assert.equal(event?.host, "example.com");
    assert.equal(JSON.stringify(event).includes("a.jpg"), false);
  });

  it("returns 404 for an unknown path", async () => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "not_found");
  });

  it("serves the ui and blocks a private url", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Image Processing API/);
    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), page.headers.get("content-type"));
    assert.equal(head.headers.get("content-length"), page.headers.get("content-length"));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const blocked = await fetch(`${base}/process?url=${encodeURIComponent("http://127.0.0.1/secret")}`);
    assert.equal(blocked.status, 400);
    const body = await blocked.json();
    assert.equal(body.error.code, "blocked_url");
    assert.match(body.error.message, /blocked address/);
  });
});
