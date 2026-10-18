import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { describe, it } from "node:test";
import { ClientAbortedError, HttpError } from "../src/errors.js";
import { prepareFetchUrl, safeFetch } from "../src/http/safeFetch.js";
import { close, listen, testConfig } from "./helpers.js";

describe("prepareFetchUrl", () => {
  const config = testConfig();

  it("rejects non-http schemes and credentials", () => {
    const ftp = expectError(() => prepareFetchUrl("ftp://example.com/a.jpg", config));
    assert.equal(ftp.status, 400);
    assert.equal(ftp.code, "invalid_url");
    const credentials = expectError(() => prepareFetchUrl("http://user:pass@example.com/a.jpg", config));
    assert.equal(credentials.code, "invalid_url");
    assert.match(credentials.message, /credentials/);
  });

  it("rejects blocked literals and the metadata hostname", () => {
    for (const raw of [
      "http://127.0.0.1/secret",
      "http://10.0.0.1/secret",
      "http://169.254.169.254/latest",
      "http://[::1]/secret",
      "http://localhost/secret",
      "http://metadata.google.internal/computeMetadata",
      "http://[64:ff9b::a9fe:a9fe]/latest",
      "http://[2002:7f00:1::]/secret",
      "http://[2001:0:0:0:0:0:80ff:fffe]/secret",
      "http://[::ffff:7f00:1]/secret",
    ]) {
      const error = expectError(() => prepareFetchUrl(raw, config));
      assert.equal(error.code, "blocked_url", raw);
    }
  });

  it("allows loopback only when the test switch is on", () => {
    const allowed = testConfig({ allowPrivateUrls: true });
    assert.equal(prepareFetchUrl("http://127.0.0.1/image.png", allowed).hostname, "127.0.0.1");
    const metadata = expectError(() => prepareFetchUrl("http://169.254.169.254/latest", allowed));
    assert.equal(metadata.code, "blocked_url");
  });
});

describe("safeFetch", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    const error = await expectRejects(
      safeFetch("http://example.com/a.png", testConfig(), async () => [{ address: "10.1.2.3", family: 4 }]),
    );
    assert.equal(error.code, "blocked_url");
  });

  it("returns the fixture bytes", async () => {
    const png = Buffer.from([1, 2, 3, 4]);
    const fixture = await startFixture((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const fetched = await safeFetch(`${fixture.url}/ok`, testConfig({ allowPrivateUrls: true }));
      assert.deepEqual(fetched.bytes, png);
      assert.equal(fetched.contentType, "image/png");
    } finally {
      await close(fixture.server);
    }
  });

  it("stops when content-length is already over the cap", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000", "Content-Type": "image/png" });
      res.end(Buffer.alloc(10));
    });
    try {
      const error = await expectRejects(
        safeFetch(`${fixture.url}/big`, testConfig({ allowPrivateUrls: true, maxSourceBytes: 100 })),
      );
      assert.equal(error.status, 413);
      assert.equal(error.code, "source_too_large");
    } finally {
      await close(fixture.server);
    }
  });

  it("stops a stream once the cap is crossed", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.alloc(250));
    });
    try {
      const error = await expectRejects(
        safeFetch(`${fixture.url}/stream`, testConfig({ allowPrivateUrls: true, maxSourceBytes: 100 })),
      );
      assert.equal(error.status, 413);
      assert.equal(error.code, "source_too_large");
    } finally {
      await close(fixture.server);
    }
  });

  it("times out when the upstream never responds", async () => {
    const fixture = await startFixture(() => {});
    try {
      const error = await expectRejects(
        safeFetch(`${fixture.url}/slow`, testConfig({ allowPrivateUrls: true, fetchTimeoutMs: 200 })),
      );
      assert.equal(error.status, 504);
      assert.equal(error.code, "upstream_timeout");
    } finally {
      await close(fixture.server);
    }
  });

  it("maps a non-2xx upstream status to 502", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(404);
      res.end("missing");
    });
    try {
      const error = await expectRejects(safeFetch(fixture.url, testConfig({ allowPrivateUrls: true })));
      assert.equal(error.status, 502);
      assert.equal(error.code, "upstream_fetch_failed");
      assert.match(error.message, /404/);
    } finally {
      await close(fixture.server);
    }
  });

  it("rejects a redirect to a blocked address", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    try {
      const error = await expectRejects(safeFetch(fixture.url, testConfig({ allowPrivateUrls: true })));
      assert.equal(error.status, 400);
      assert.equal(error.code, "blocked_url");
    } finally {
      await close(fixture.server);
    }
  });

  it("stops after the redirect cap", async () => {
    const fixture = await startFixture((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const hop = Number(url.searchParams.get("hop") ?? "0");
      url.searchParams.set("hop", String(hop + 1));
      res.writeHead(302, { Location: `${url.pathname}?${url.searchParams.toString()}` });
      res.end();
    });
    try {
      const error = await expectRejects(
        safeFetch(fixture.url, testConfig({ allowPrivateUrls: true, maxRedirects: 3 })),
      );
      assert.equal(error.status, 400);
      assert.equal(error.code, "too_many_redirects");
    } finally {
      await close(fixture.server);
    }
  });

  it("closes the upstream socket when a redirect body is left open", async () => {
    let closed = false;
    const fixture = await startFixture((req, res) => {
      req.once("close", () => {
        closed = true;
      });
      res.writeHead(302, { Location: "http://169.254.169.254/latest" });
      res.write(Buffer.alloc(64 * 1024));
    });
    try {
      const error = await expectRejects(safeFetch(fixture.url, testConfig({ allowPrivateUrls: true })));
      assert.equal(error.code, "blocked_url");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closed, true);
    } finally {
      await close(fixture.server);
    }
  });

  it("stops when the caller aborts", async () => {
    const fixture = await startFixture(() => {});
    const controller = new AbortController();
    try {
      const pending = safeFetch(
        fixture.url,
        testConfig({ allowPrivateUrls: true, fetchTimeoutMs: 2_000 }),
        undefined,
        controller.signal,
      );
      controller.abort();
      await assert.rejects(pending, ClientAbortedError);
    } finally {
      await close(fixture.server);
    }
  });
});

function expectError(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error;
  }
  assert.fail("expected HttpError");
}

async function expectRejects(work: Promise<unknown>): Promise<HttpError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error;
  }
  assert.fail("expected HttpError");
}

async function startFixture(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  const url = await listen(server);
  return { server, url };
}
