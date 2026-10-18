import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/errors.js";
import { parseProcessQuery } from "../src/schema/processQuery.js";

const maxEdge = 2048;

describe("parseProcessQuery", () => {
  it("accepts the resize example", () => {
    const params = new URLSearchParams("url=https://example.com/image.jpg&width=500&height=300");
    assert.deepEqual(parseProcessQuery(params, maxEdge), {
      url: "https://example.com/image.jpg",
      width: 500,
      height: 300,
    });
  });

  it("accepts the format example", () => {
    const params = new URLSearchParams("url=https://example.com/image.png&format=jpeg&quality=80");
    assert.deepEqual(parseProcessQuery(params, maxEdge), {
      url: "https://example.com/image.png",
      format: "jpeg",
      quality: 80,
    });
  });

  it("accepts the combined example", () => {
    const params = new URLSearchParams(
      "url=https://example.com/image.jpg&width=800&height=600&format=webp&crop=fill",
    );
    assert.deepEqual(parseProcessQuery(params, maxEdge), {
      url: "https://example.com/image.jpg",
      width: 800,
      height: 600,
      format: "webp",
      crop: "fill",
    });
  });

  it("lowercases format and crop", () => {
    const params = new URLSearchParams("url=https://example.com/image.jpg&format=JPEG&crop=FIT");
    const parsed = parseProcessQuery(params, maxEdge);
    assert.equal(parsed.format, "jpeg");
    assert.equal(parsed.crop, "fit");
  });

  it("rejects a missing url", () => {
    const error = assertHttpError(() => parseProcessQuery(new URLSearchParams("width=10"), maxEdge));
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_parameter");
    assert.equal(error.param, "url");
    assert.equal(error.message, "url is required");
  });

  it("rejects a url that is not a url", () => {
    const error = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=not-a-url"), maxEdge),
    );
    assert.equal(error.param, "url");
    assert.equal(error.message, "url must be a valid URL");
  });

  it("rejects width that is not an integer in range", () => {
    for (const width of ["0", "2049", "abc", "-1", "1.5"]) {
      const error = assertHttpError(() =>
        parseProcessQuery(new URLSearchParams(`url=https://example.com/a.jpg&width=${width}`), maxEdge),
      );
      assert.equal(error.param, "width");
      assert.match(error.message, /width must be an integer from 1 to 2048/);
    }
  });

  it("rejects height and quality outside their ranges", () => {
    const height = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&height=0"), maxEdge),
    );
    assert.equal(height.param, "height");
    const quality = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&quality=101"), maxEdge),
    );
    assert.equal(quality.param, "quality");
    assert.match(quality.message, /quality must be an integer from 1 to 100/);
  });

  it("rejects fill and crop when a dimension is missing", () => {
    const fill = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&width=10&crop=fill"), maxEdge),
    );
    assert.equal(fill.status, 400);
    assert.equal(fill.param, "height");
    assert.equal(fill.message, "fill requires both width and height");
    const crop = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&height=10&crop=crop"), maxEdge),
    );
    assert.equal(crop.param, "width");
  });

  it("rejects unknown format and crop", () => {
    const format = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&format=gif"), maxEdge),
    );
    assert.equal(format.param, "format");
    assert.equal(format.message, "format must be jpeg, png, or webp");
    const crop = assertHttpError(() =>
      parseProcessQuery(new URLSearchParams("url=https://example.com/a.jpg&crop=pad"), maxEdge),
    );
    assert.equal(crop.param, "crop");
    assert.equal(crop.message, "crop must be fit, fill, or crop");
  });
});

function assertHttpError(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error;
  }
  assert.fail("expected HttpError");
}
