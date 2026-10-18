const form = document.querySelector("#form");
const requestUrl = document.querySelector("#request-url");
const curl = document.querySelector("#curl");
const copyButton = document.querySelector("#copy");
const status = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const submitButton = form.querySelector("button[type=submit]");
const quality = document.querySelector("#quality");
const qualityValue = document.querySelector("#quality-value");

const originalImage = document.querySelector("#original");
const processedImage = document.querySelector("#processed");
const saved = document.querySelector("#processed-saved");

quality.addEventListener("input", () => {
  qualityValue.textContent = `${quality.value}%`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = queryFromForm(new FormData(form));
  if (!params.get("url")) {
    showError("url is required");
    return;
  }

  const processedParams = new URLSearchParams(params);
  const originalParams = new URLSearchParams();
  originalParams.set("url", params.get("url"));

  const processedRequest = `${location.origin}/process?${processedParams.toString()}`;
  const originalRequest = `${location.origin}/process?${originalParams.toString()}`;
  showRequest(processedRequest);

  submitButton.disabled = true;
  status.className = "loading";
  status.hidden = false;
  status.textContent = "Processing…";
  errorBox.hidden = true;
  const started = performance.now();

  try {
    const [original, processed] = await Promise.all([loadImage(originalRequest), loadImage(processedRequest)]);
    if (!processed.ok || !original.ok) {
      showError((!processed.ok ? processed.message : original.message) || "request failed");
      return;
    }
    showImage(originalImage, "original", original);
    showImage(processedImage, "processed", processed);
    const savedPercent = savings(original.bytes, processed.bytes);
    if (savedPercent > 0) {
      saved.hidden = false;
      saved.textContent = `(Saved ${savedPercent}%)`;
    } else {
      saved.hidden = true;
      saved.textContent = "";
    }
    const elapsed = Math.round(performance.now() - started);
    const cacheNote = processed.cache === "HIT" ? " Served from cache." : "";
    status.className = "done";
    status.textContent = `Done in ${elapsed} ms.${cacheNote}`;
  } catch (error) {
    showError(error instanceof Error ? error.message : "request failed");
  } finally {
    submitButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  const copied = await writeClipboard(curl.textContent ?? "");
  copyButton.textContent = copied ? "Copied" : "Copy failed";
  setTimeout(() => {
    copyButton.textContent = "Copy cURL";
  }, 1500);
});

function queryFromForm(data) {
  const params = new URLSearchParams();
  for (const [key, value] of data) {
    if (typeof value === "string" && value.trim() !== "") params.set(key, value.trim());
  }
  return params;
}

function showRequest(url) {
  const path = `${new URL(url).pathname}?${new URL(url).searchParams.toString()}`;
  requestUrl.textContent = `GET ${path}`;
  curl.textContent = `curl ${JSON.stringify(url)} --output processed`;
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
  status.hidden = true;
  clearImage(originalImage, "original");
  clearImage(processedImage, "processed");
  saved.hidden = true;
}

async function loadImage(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body.error?.message) message = body.error.message;
    } catch {
    }
    return { ok: false, message };
  }
  const blob = await response.blob();
  return {
    ok: true,
    blob,
    bytes: Number(response.headers.get("Content-Length")),
    cache: response.headers.get("X-Cache"),
    width: response.headers.get("X-Image-Width") ?? "?",
    height: response.headers.get("X-Image-Height") ?? "?",
    format: response.headers.get("X-Image-Format") ?? "unknown",
  };
}

function showImage(image, prefix, result) {
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  const objectUrl = URL.createObjectURL(result.blob);
  image.dataset.objectUrl = objectUrl;
  image.src = objectUrl;
  image.alt = prefix === "original" ? "Original image" : "Processed image";
  image.hidden = false;
  document.querySelector(`#${prefix}-dims`).textContent = `${result.width} × ${result.height} px`;
  document.querySelector(`#${prefix}-format`).textContent = formatName(result.format);
  document.querySelector(`#${prefix}-size`).textContent = formatBytes(result.bytes);
}

function clearImage(image, prefix) {
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  image.removeAttribute("src");
  image.hidden = true;
  document.querySelector(`#${prefix}-dims`).textContent = "—";
  document.querySelector(`#${prefix}-format`).textContent = "—";
  document.querySelector(`#${prefix}-size`).textContent = "—";
}

function formatName(format) {
  if (format === "jpeg") return "JPEG";
  if (format === "png") return "PNG";
  if (format === "webp") return "WebP";
  return format;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function savings(originalBytes, processedBytes) {
  if (!Number.isFinite(originalBytes) || !Number.isFinite(processedBytes) || originalBytes <= 0) return 0;
  if (processedBytes >= originalBytes) return 0;
  return Math.round((1 - processedBytes / originalBytes) * 100);
}

async function writeClipboard(value) {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  if (copied) return true;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
