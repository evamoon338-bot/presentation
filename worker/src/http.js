let corsOrigin = "";

/** Sets the origin echoed back in CORS headers for the current request. */
export function setCorsOrigin(origin) {
  corsOrigin = origin || "";
}

export function corsHeaders() {
  if (!corsOrigin) return {};
  return {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...headers
    }
  });
}

export function jsonWithCookie(body, status, cookie) {
  const headers = {};
  if (cookie) headers["Set-Cookie"] = cookie;
  return json(body, status, headers);
}

export async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) return {};
  const text = await request.text();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest("Request body must be valid JSON.");
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequest";
  }
}

export function parseId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export function isEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Splits a data URL into its mime type and raw bytes. */
export function parseDataUrl(value) {
  const match = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value || "");
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1], bytes };
  } catch {
    return null;
  }
}
