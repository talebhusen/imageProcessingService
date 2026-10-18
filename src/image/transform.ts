import sharp from "sharp";
import type { Config } from "../config.js";
import { ClientAbortedError, HttpError } from "../errors.js";
import type { ImageFormat, ProcessQuery } from "../schema/processQuery.js";

type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance["metadata"]>>;

const contentTypeFor: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type TransformedImage = {
  bytes: Buffer;
  width: number;
  height: number;
  format: ImageFormat;
  contentType: string;
};

export async function transformImage(
  input: Buffer,
  query: ProcessQuery,
  config: Config,
  signal?: AbortSignal,
): Promise<TransformedImage> {
  if (signal?.aborted) throw new ClientAbortedError();
  if (looksLikeSvg(input)) {
    throw new HttpError(415, "unsupported_media_type", "source is not a supported image");
  }

  const source = sharp(input, {
    failOn: "error",
    animated: false,
    limitInputPixels: config.maxInputPixels,
  });
  const onAbort = () => {
    source.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let metadata: SharpMetadata;
    try {
      metadata = await source.metadata();
    } catch (error) {
      if (signal?.aborted) throw new ClientAbortedError();
      if (isPixelLimitError(error)) throw pixelLimitError(config);
      throw new HttpError(415, "unsupported_media_type", "source is not a supported image");
    }

    if (!metadata.format || metadata.format === "svg" || !metadata.width || !metadata.height) {
      throw new HttpError(415, "unsupported_media_type", "source is not a supported image");
    }

    const sourceWidth = metadata.autoOrient?.width || metadata.width;
    const sourceHeight = metadata.autoOrient?.height || metadata.height;
    assertCropFits(query, sourceWidth, sourceHeight);

    let pipeline = source.autoOrient();
    if (query.width !== undefined || query.height !== undefined) {
      pipeline = resize(pipeline, query, sourceWidth, sourceHeight);
    }

    const format = outputFormat(metadata.format, query.format);
    pipeline = encode(pipeline, format, query.quality ?? config.defaultQuality);

    try {
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        bytes: data,
        width: info.width,
        height: info.height,
        format,
        contentType: contentTypeFor[format],
      };
    } catch (error) {
      if (signal?.aborted || error instanceof ClientAbortedError) throw new ClientAbortedError();
      if (error instanceof HttpError) throw error;
      if (isPixelLimitError(error)) throw pixelLimitError(config);
      if (isDecodeError(error)) {
        throw new HttpError(415, "unsupported_media_type", "source is not a supported image");
      }
      throw new HttpError(422, "image_processing_failed", "could not process the image");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function assertCropFits(query: ProcessQuery, sourceWidth: number, sourceHeight: number): void {
  if (query.crop !== "fill" && query.crop !== "crop") return;
  if (query.width === undefined || query.height === undefined) {
    throw new HttpError(400, "invalid_parameter", `${query.crop} requires both width and height`, {
      param: query.width === undefined ? "width" : "height",
    });
  }
  if (query.crop !== "crop") return;
  if (query.width > sourceWidth) {
    throw new HttpError(400, "invalid_parameter", "crop width is larger than the source image", {
      param: "width",
    });
  }
  if (query.height > sourceHeight) {
    throw new HttpError(400, "invalid_parameter", "crop height is larger than the source image", {
      param: "height",
    });
  }
}

function resize(
  pipeline: SharpInstance,
  query: ProcessQuery,
  sourceWidth: number,
  sourceHeight: number,
): SharpInstance {
  if (query.crop === "crop" && query.width !== undefined && query.height !== undefined) {
    return pipeline.extract({
      left: Math.floor((sourceWidth - query.width) / 2),
      top: Math.floor((sourceHeight - query.height) / 2),
      width: query.width,
      height: query.height,
    });
  }
  if (query.crop === "fill") {
    return pipeline.resize(query.width, query.height, { fit: "cover", position: "centre" });
  }
  return pipeline.resize(query.width, query.height, { fit: "inside" });
}

function outputFormat(sourceFormat: string, requested: ImageFormat | undefined): ImageFormat {
  if (requested) return requested;
  if (sourceFormat === "jpeg" || sourceFormat === "png" || sourceFormat === "webp") return sourceFormat;
  return "jpeg";
}

function encode(pipeline: SharpInstance, format: ImageFormat, quality: number): SharpInstance {
  if (format === "jpeg") return pipeline.jpeg({ quality });
  if (format === "png") return pipeline.png();
  return pipeline.webp({ quality });
}

function pixelLimitError(config: Config): HttpError {
  return new HttpError(413, "input_too_large", `source exceeds ${config.maxInputPixels} pixels`);
}

function isPixelLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("pixel limit");
}

function looksLikeSvg(input: Buffer): boolean {
  return input.subarray(0, 256).toString("utf8").toLowerCase().includes("<svg");
}

function isDecodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("unsupported") ||
    message.includes("corrupt") ||
    message.includes("premature") ||
    message.includes("truncated") ||
    message.includes("end of image")
  );
}
