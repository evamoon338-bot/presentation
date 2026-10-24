import { parseDataUrl } from "./http.js";

// D1 rows are capped at ~2 MB and a row also carries text plus other
// columns, so inline media is limited well below that.
const MAX_MEDIA_BYTES = 600 * 1024;
const MAX_MEDIA_TEXT = 820 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const UNSUPPORTED_MEDIA_MESSAGE =
  "This deployment stores photos inline, so only JPEG, PNG, WebP, and GIF images up to 600 KB are supported.";

export const UNSUPPORTED_VIDEO_MESSAGE =
  "Video uploads are not available on this deployment. Please upload a photo instead.";

export function isVideoDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:video/");
}

/**
 * Validates an inline data URL and returns it unchanged, ready to be stored in
 * a TEXT column. Returns "" when the value is empty or not a data URL.
 */
export function storeDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return "";
  if (parsed.bytes.length > MAX_MEDIA_BYTES) {
    throw new Error(
      `Photos must be smaller than ${Math.round(MAX_MEDIA_BYTES / 1024)} KB on this deployment.`,
    );
  }
  const mime = parsed.mime.toLowerCase();
  if (!ALLOWED_MIME.has(mime)) throw new Error(UNSUPPORTED_MEDIA_MESSAGE);
  if (dataUrl.length > MAX_MEDIA_TEXT) throw new Error(UNSUPPORTED_MEDIA_MESSAGE);
  return dataUrl;
}

/** Inline media has no external objects to clean up. */
export async function deleteKey() {}

function isInlineDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}

function normalizeEntry(value) {
  if (!value) return "";
  if (isInlineDataUrl(value)) return value;
  // A bare key from an earlier R2 deployment can no longer be resolved.
  if (/^[a-z]+\/[a-f0-9]{32}\.[a-z0-9]+$/i.test(value)) return "";
  return value;
}

export function parseKeyList(value) {
  if (!value) return [];
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map(normalizeEntry).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }
  const single = normalizeEntry(value);
  return single ? [single] : [];
}

export function serializeKeyList(entries) {
  const list = (entries || []).filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return JSON.stringify(list);
}

/** Returns stored media (single value or JSON array) ready for the browser. */
export function exposeKeyList(value) {
  const entries = parseKeyList(value);
  if (entries.length === 0) return "";
  if (typeof value === "string" && value.startsWith("[")) {
    return JSON.stringify(entries);
  }
  return entries[0];
}