import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { HttpError } from "./errors.js";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

export async function serveStatic(res: ServerResponse, pathname: string, method = "GET"): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const contentType = contentTypes[extname(requested)];
  if (!contentType) {
    throw new HttpError(404, "not_found", "not found");
  }

  const filePath = resolve(publicRoot, `.${requested}`);
  if (!filePath.startsWith(publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep)) {
    throw new HttpError(404, "not_found", "not found");
  }

  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new HttpError(404, "not_found", "not found");
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(info.size),
    "Cache-Control": "no-cache",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(await readFile(filePath));
}
