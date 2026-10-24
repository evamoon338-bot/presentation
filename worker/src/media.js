import { parseDataUrl } from "./http.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba"
};
const ALLOWED_MIME = new Set(Object.keys(EXTENSIONS));

export const UNSUPPORTED_VIDEO_MESSAGE =
  "Video uploads are not available on this deployment. Please upload a photo instead.";

export function isVideoDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:video/");
}

function randomKey() {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Stores a data URL in R2 and returns the object key.
 * Returns null when the value is empty or not a data URL.
 */
export async function storeDataUrl(env, dataUrl, prefix) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  if (parsed.bytes.length > MAX_MEDIA_BYTES) {
    throw new Error("Media uploads must be smaller than 20 MB each.");
  }
  const mime = parsed.mime.toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error("Unsupported media type. Use JPEG, PNG, WebP, GIF, MP3, M4A, WAV, OGG, or WebM.");
  }
  const extension = EXTENSIONS[mime];
  const key = `${prefix}/${randomKey()}.${extension}`;
  await env.MEDIA.put(key, parsed.bytes, {
    httpMetadata: { contentType: mime }
  });
  return key;
}

export async function deleteKey(env, key) {
  if (!key) return;
  try {
    await env.MEDIA.delete(key);
  } catch {
    // Deleting a missing key is not an error worth surfacing.
  }
}

export async function serveKey(env, key) {
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  const storedType = (object.httpMetadata?.contentType || "").toLowerCase();
  headers.set(
    "Content-Type",
    ALLOWED_MIME.has(storedType) ? storedType : "application/octet-stream"
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

function keyToUrl(key) {
  return key ? `/media/${key}` : "";
}

export function parseKeyList(value) {
  if (!value) return [];
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item) : [];
    } catch {
      return [];
    }
  }
  return [value];
}

export function serializeKeyList(keys) {
  if (!keys || keys.length === 0) return "";
  if (keys.length === 1) return keys[0];
  return JSON.stringify(keys);
}

/**
 * Converts stored media (single key or JSON array) into URLs the browser can load.
 */
export function exposeKeyList(value) {
  const keys = parseKeyList(value);
  if (keys.length === 0) return "";
  const urls = keys.map(keyToUrl);
  if (typeof value === "string" && value.startsWith("[")) {
    return JSON.stringify(urls);
  }
  return urls[0];
}

export { keyToUrl };
