import { z } from "zod";
import { HttpError } from "../errors.js";

const formats = ["jpeg", "png", "webp"] as const;
const crops = ["fit", "fill", "crop"] as const;

export type ImageFormat = (typeof formats)[number];
export type CropMode = (typeof crops)[number];

function integerInRange(name: string, min: number, max: number) {
  return z.string().transform((value, ctx) => {
    if (!/^\d+$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be an integer from ${min} to ${max}`,
      });
      return z.NEVER;
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be an integer from ${min} to ${max}`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

export function processQuerySchema(maxEdge: number) {
  return z
    .object({
      url: z
        .string({ required_error: "url is required" })
        .min(1, "url is required")
        .url("url must be a valid URL"),
      width: integerInRange("width", 1, maxEdge).optional(),
      height: integerInRange("height", 1, maxEdge).optional(),
      format: z
        .enum(formats, {
          errorMap: () => ({ message: "format must be jpeg, png, or webp" }),
        })
        .optional(),
      quality: integerInRange("quality", 1, 100).optional(),
      crop: z
        .enum(crops, {
          errorMap: () => ({ message: "crop must be fit, fill, or crop" }),
        })
        .optional(),
    })
    .superRefine((value, ctx) => {
      if (value.crop !== "fill" && value.crop !== "crop") return;
      if (value.width !== undefined && value.height !== undefined) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.width === undefined ? "width" : "height"],
        message: `${value.crop} requires both width and height`,
      });
    });
}

export type ProcessQuery = z.infer<ReturnType<typeof processQuerySchema>>;

const queryKeys = ["url", "width", "height", "format", "quality", "crop"] as const;

export function parseProcessQuery(searchParams: URLSearchParams, maxEdge: number): ProcessQuery {
  const raw: Record<string, string> = {};
  for (const key of queryKeys) {
    const value = searchParams.get(key);
    if (value !== null && value !== "") {
      raw[key] = key === "format" || key === "crop" ? value.toLowerCase() : value;
    }
  }

  const result = processQuerySchema(maxEdge).safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path[0];
    const param = typeof field === "string" ? field : undefined;
    throw new HttpError(400, "invalid_parameter", issue?.message ?? "invalid query", { param });
  }
  return result.data;
}
