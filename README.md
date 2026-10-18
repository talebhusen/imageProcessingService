# Image processing service

A HTTP API that takes an image URL, resizes/crops it and re-encodes as JPEG, PNG or WebP. A single page in `public/` calls the same API.

## Run locally

```bash
npm install
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000). `npm run dev` runs the same server from TypeScript without a build step.

```bash
curl "http://localhost:3000/process?url=https://example.com/image.jpg&width=500&height=300" --output out.png
curl "http://localhost:3000/process?url=https://example.com/image.png&format=jpeg&quality=80" --output out.jpg
curl "http://localhost:3000/process?url=https://example.com/image.jpg&width=800&height=600&format=webp&crop=fill" --output out.webp
```

`GET /health` returns `{ "status": "ok" }`.

## Test

```bash
npm test
npm run typecheck
```

`npm test` runs the unit and HTTP tests using Node's test runner. The image tests use `test/fixtures/sample.png`. The fetch tests run a fixture server. They opt into loopback with `allowPrivateUrls` on the test config only. The default server denies private addresses.

## API

`GET /process`

| Query             | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `url`             | Required. `http` or `https` URL of the source image.                                                       |
| `width`, `height` | Optional integers from 1 to 2048.                                                                          |
| `format`          | `jpeg`, `png` or `webp`. Omit to keep source format if that is one of those three. Else re-encode as JPEG. |
| `quality`         | Integer from 1 to 100. Default 80. Used for JPEG and WebP.                                                 |
| `crop`            | `fit` (default), `fill` or `crop`.                                                                         |

`fit` maintains the aspect ratio and fits to the requested box. `fill` covers the box by cropping the content. `fill` and `crop` both require width and height. `crop` extracts a centered rectangle of the requested size. A crop larger than the source is a 400. Omitting `quality` is the same cache entry as `quality=80`. Omitting `crop` is the same cache entry as `crop=fit`.

`GET` and `HEAD` both run the pipeline. `HEAD` returns the same headers and no body. A later request with `If-None-Match` set to the `ETag` returns 304 and no body.

A successful response is the image bytes. Headers:

- `Content-Type`, `Content-Length`
- `ETag`, `Cache-Control`
- `X-Image-Width`, `X-Image-Height`, `X-Image-Format`
- `X-Cache`: `HIT` or `MISS`

Failures are JSON. `param` is present only when one field is at fault.

```json
{
  "error": {
    "code": "invalid_parameter",
    "message": "width must be an integer from 1 to 2048",
    "param": "width"
  }
}
```

| Status | Code                      | When                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------ |
| 400    | `invalid_parameter`       | A query field is missing or out of range.                                            |
| 400    | `invalid_url`             | The URL is not `http` or `https`, or contains credentials.                           |
| 400    | `blocked_url`             | Host is blocked, or a resolved address is private, loopback, link-local or metadata. |
| 400    | `too_many_redirects`      | More than 3 redirects.                                                               |
| 413    | `source_too_large`        | Source is over the byte cap. The download stops at the cap.                          |
| 413    | `input_too_large`         | The decoded image is over the pixel cap.                                             |
| 415    | `unsupported_media_type`  | Bytes are not a supported image. SVG is rejected.                                    |
| 422    | `image_processing_failed` | File decoded, then `sharp` failed while transforming it.                             |
| 429    | `rate_limited`            | Client is over the per-minute budget. `Retry-After` is set.                          |
| 429    | `overloaded`              | Too many images are already being processed. `Retry-After` is set.                   |
| 502    | `upstream_fetch_failed`   | Connection failed, or upstream status was not 2xx.                                   |
| 504    | `upstream_timeout`        | Upstream did not finish within the timeout.                                          |
| 404    | `not_found`               | Any other path.                                                                      |
| 500    | `internal_error`          | Unexpected error. Response message is fixed. Details remain in server log.           |

## Architecture

One Node process. `src/server.ts` is the only module that writes an HTTP response. The page is static files from `public/`.

```
GET /process
  -> rate limit (client IP)
  -> Zod query schema
  -> memory cache
  -> in-flight slot, shared by identical requests
  -> safe fetch
  -> sharp
  -> cache the success
  -> image bytes
```

The address check runs inside the DNS lookup Node uses to open the socket, including on each redirect. A name that looks public but then resolves to an internal address is refused before the connection. Redirects are followed one hop at a time, up to 3, and each hop goes through this check.

Every image is re-encoded. The service does not forward the upstream bytes, so a response cannot be HTML or SVG with upstream content-type.

`ALLOW_PRIVATE_URLS=true` allows loopback only: tests can use a fixture server. Link-local, private and metadata addresses are still blocked. Leave unset outside tests.

## Limits

Defaults in `src/config.ts` can be overridden with environment variables.

| Setting                 | Default    | Why                                                                                                                                                                |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FETCH_TIMEOUT_MS`      | 10s        | One budget for the whole fetch, including redirects and the body. A hung host does not keep the socket.                                                            |
| `MAX_SOURCE_BYTES`      | 10 MB      | Covers photos. Prevent a multi-gig download.                                                                                                                       |
| `MAX_EDGE_PX`           | 2048       | Largest width/height a caller can request.                                                                                                                         |
| `MAX_INPUT_PIXELS`      | 40,000,000 | Decode budget. Phone photos still work. Decompression bomb does not. This is different from output edge, because 12MP photo is a normal input for a 2048px output. |
| `MAX_REDIRECTS`         | 3          | Enough for a CDN. Prevent a redirect loop.                                                                                                                         |
| `RATE_LIMIT_PER_MINUTE` | 60         | Enough to use the page. 61st request in window is 429.                                                                                                             |
| `CACHE_MAX_ENTRIES`     | 100        | Bounds how many results are kept.                                                                                                                                  |
| `CACHE_MAX_BYTES`       | 64 MB      | Bounds the bytes those results hold. A result larger than the cap is not stored.                                                                                   |
| `CACHE_TTL_MS`          | 5 minutes  | Repeats edits to the same URL are cheap. Failures are not cached, so a blip does not stick.                                                                        |
| `INFLIGHT_LIMIT`        | 4          | How many fetches and decodes can run at once. The next one is 429.                                                                                                 |
| `TRUST_PROXY`           | false      | When `true`, the client key is the last `X-Forwarded-For` value, the hop a single proxy appends. When `false`, that header is ignored.                             |
| `PORT`                  | 3000       | Listen port.                                                                                                                                                       |

Rate limit applies to `GET` and `HEAD /process` only. Those are the routes that fetch and decode. Health and the static page do not consume that budget.

No CORS header. The page is served by this process and calls `/process` on the same origin. An open CORS policy would make this API a browser-side open proxy.

## Decisions

- **Node `http` and Zod.** Two routes. Zod parses the query. `http.createServer` owns the socket.
- **One process, static page.** HTML, CSS, and one script call `GET /process` the same way any other client does.
- **`sharp`.** Resize, crop, and JPEG, PNG, or WebP in this process.
- **`node:test`.** Ships with Node, so the suite has no runner config.
- **Block addresses at connect time.** The DNS lookup that opens the socket is the check, including after each redirect.
- **In-memory cache of successes.** The key is the normalized URL plus the transform fields.
- **Rate limit by socket address.** `TRUST_PROXY` uses the last `X-Forwarded-For` hop. `INFLIGHT_LIMIT` caps overlapping decodes, and identical misses share one fetch.

## Deployed

https://imageprocessingservice-ln7l.onrender.com/
