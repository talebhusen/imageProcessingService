import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import sharp from "sharp";
import { HttpError } from "../src/errors.js";
import { transformImage } from "../src/image/transform.js";
import type { ProcessQuery } from "../src/schema/processQuery.js";
import { testConfig } from "./helpers.js";

const fixturePath = new URL("./fixtures/sample.png", import.meta.url);
const config = testConfig();

describe("transformImage", () => {
  it("fits inside the requested box and preserves aspect ratio", async () => {
    const image = await transform(await sample(), { width: 50, height: 50, crop: "fit" });
    assert.equal(image.width, 50);
    assert.equal(image.height, 25);
    assert.equal(image.format, "png");
  });

  it("fills the box by covering and cropping", async () => {
    const image = await transform(await sample(), { width: 50, height: 50, crop: "fill" });
    assert.equal(image.width, 50);
    assert.equal(image.height, 50);
  });

  it("extracts a centered crop", async () => {
    const image = await transform(await sample(), { width: 40, height: 40, crop: "crop" });
    assert.equal(image.width, 40);
    assert.equal(image.height, 40);
    assert.equal(image.format, "png");
  });

  it("skips resize when dimensions are omitted and keeps a png", async () => {
    const image = await transform(await sample(), {});
    assert.equal(image.width, 200);
    assert.equal(image.height, 100);
    assert.equal(image.contentType, "image/png");
  });

  it("encodes jpeg and webp when asked", async () => {
    const jpeg = await transform(await sample(), { format: "jpeg", quality: 80 });
    assert.equal(jpeg.contentType, "image/jpeg");
    const webp = await transform(await sample(), { format: "webp" });
    assert.equal(webp.contentType, "image/webp");
  });

  it("uses quality for jpeg output", async () => {
    const low = await transform(await sample(), { format: "jpeg", quality: 20 });
    const high = await transform(await sample(), { format: "jpeg", quality: 90 });
    assert.ok(high.bytes.length > low.bytes.length);
  });

  it("rejects text, svg, and a truncated file", async () => {
    const text = await expectRejects(transform(Buffer.from("hello"), {}));
    assert.equal(text.status, 415);
    const svg = await expectRejects(
      transform(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'), {}),
    );
    assert.equal(svg.status, 415);
    const truncated = await expectRejects(transform((await sample()).subarray(0, 16), {}));
    assert.equal(truncated.status, 415);
  });

  it("rejects an image over the pixel cap", async () => {
    const big = await sharp({
      create: { width: 80, height: 80, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const error = await expectRejects(
      transformImage(big, { url: "https://example.com/a.png" }, testConfig({ maxInputPixels: 100 })),
    );
    assert.equal(error.status, 413);
    assert.equal(error.code, "input_too_large");
    assert.match(error.message, /100 pixels/);
  });

  it("orients the pixels before measuring, fitting, and cropping", async () => {
    const sideways = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const oriented = await transform(sideways, { format: "jpeg" });
    assert.equal(oriented.width, 40);
    assert.equal(oriented.height, 80);

    const fitted = await transform(sideways, { width: 20, height: 20, crop: "fit", format: "jpeg" });
    assert.equal(fitted.width, 10);
    assert.equal(fitted.height, 20);

    const error = await expectRejects(
      transform(sideways, { width: 50, height: 20, crop: "crop", format: "jpeg" }),
    );
    assert.equal(error.status, 400);
    assert.equal(error.param, "width");
  });

  it("rejects a crop larger than the source", async () => {
    const error = await expectRejects(transform(await sample(), { width: 500, height: 40, crop: "crop" }));
    assert.equal(error.status, 400);
    assert.equal(error.param, "width");
  });
});

async function sample(): Promise<Buffer> {
  return readFile(fixturePath);
}

function transform(input: Buffer, query: Partial<ProcessQuery>) {
  return transformImage(input, { url: "https://example.com/sample.png", ...query }, config);
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
