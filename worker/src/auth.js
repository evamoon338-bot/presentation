const PBKDF2_ITERATIONS = 100000;
const SESSION_LIFETIME_DAYS = 7;

const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function createPasswordCredentials(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return { salt: toBase64(salt), hash: toBase64(hash) };
}

export async function verifyPassword(password, saltText, hashText) {
  let salt;
  let expected;
  try {
    salt = fromBase64(saltText);
    expected = fromBase64(hashText);
  } catch {
    return false;
  }
  const actual = await derive(password, salt);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) {
    difference |= actual[i] ^ expected[i];
  }
  return difference === 0;
}

export async function sha256Base64(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return toBase64(digest);
}

export function createSessionToken() {
  const bytes = randomBytes(32);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];
  return parts.join("; ");
}

export async function createSession(env, userId) {
  const token = createSessionToken();
  const tokenHash = await sha256Base64(token);
  const expires = new Date(Date.now() + SESSION_LIFETIME_DAYS * 86400000).toISOString();
  // A fresh login replaces any older session for this user so a stale token
  // cannot be kept alive (session fixation). Only this user's rows are pruned.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId),
    env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)"
    ).bind(tokenHash, userId, expires)
  ]);
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  const tokenHash = await sha256Base64(token);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
}

export async function getCurrentUser(env, request, cookieName) {
  const cookies = parseCookies(request);
  const token = cookies[cookieName];
  if (!token) return null;
  const tokenHash = await sha256Base64(token);
  const row = await env.DB.prepare(
    "SELECT u.id,u.email,u.display_name,u.profile_photo,u.about_me,u.audience,u.email_notifications,u.product_updates,u.show_email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1"
  ).bind(tokenHash).first();
  return row || null;
}

export const SESSION_COOKIE_DEFAULT = "circle_session";
export const SESSION_MAX_AGE = SESSION_LIFETIME_DAYS * 86400;
