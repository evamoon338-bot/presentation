import { first, run } from "../db.js";
import { createSession, sessionCookie, SESSION_MAX_AGE } from "../auth.js";
import { PUBLIC_USER_COLUMNS } from "./auth-routes.js";

const STATE_COOKIE = "circle_oauth_state";
const STATE_TTL_SECONDS = 600;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const SCOPE = "openid email profile";

function base64UrlEncode(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function redirectUri(request) {
  return new URL("/api/auth/google/callback", request.url).toString();
}

/** Redirects back to the app with a machine-readable error code. */
function appRedirect(env, code, extra = {}) {
  const origin = env.APP_ORIGIN || new URL("https://circle-app-9nh.pages.dev").origin;
  const url = new URL(origin);
  url.searchParams.set("authError", code);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url.toString(), 302);
}

function stateCookie(value, maxAge) {
  return [
    `${STATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/auth/google",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ].join("; ");
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return part.slice(index + 1).trim();
      }
    }
  }
  return "";
}

/** GET /api/auth/google — starts the OAuth dance. */
export function googleStart(env, request) {
  if (!env.GOOGLE_CLIENT_ID) {
    return appRedirect(env, "google_unavailable");
  }
  const state = randomState();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": stateCookie(state, STATE_TTL_SECONDS),
      "Cache-Control": "no-store"
    }
  });
}

async function exchangeCode(env, request, code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(request)
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!response.ok) return null;
  return response.json();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function decodeSegment(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

/**
 * Verifies a Google ID token: signature against Google's published keys,
 * plus issuer, audience and expiry. Returns the payload or null.
 */
async function verifyIdToken(idToken, clientId) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;

  const certs = await fetchJson(GOOGLE_CERTS_URL);
  const jwk = (certs.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signature = Uint8Array.from(
    atob(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[2].replace(/-/g, "+").replace(/_/g, "/").length % 4)) % 4)),
    (c) => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;

  const issuers = new Set(["accounts.google.com", "https://accounts.google.com"]);
  if (!issuers.has(payload.iss)) return null;
  if (payload.aud !== clientId) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (!payload.sub) return null;
  return payload;
}

/** GET /api/auth/google/callback — completes the sign-in. */
export async function googleCallback(env, request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return appRedirect(env, "google_cancelled");

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const expectedState = readCookie(request, STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return appRedirect(env, "google_state_mismatch");
  }

  const tokens = await exchangeCode(env, request, code);
  if (!tokens || !tokens.id_token) return appRedirect(env, "google_failed");

  const profile = await verifyIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
  if (!profile || !profile.email || profile.email_verified !== true) {
    return appRedirect(env, "google_failed");
  }

  const email = String(profile.email).trim().toLowerCase();
  const googleSub = String(profile.sub);

  const linked = await first(
    env,
    "SELECT id FROM users WHERE google_sub=? LIMIT 1",
    googleSub
  );
  let userId = linked?.id || 0;

  if (!userId) {
    const existing = await first(
      env,
      "SELECT id,google_sub,password_hash FROM users WHERE email=? LIMIT 1",
      email
    );
    if (existing) {
      // Chosen policy: never silently link. Password accounts must sign in
      // with their password, and a different Google identity cannot claim them.
      if (existing.password_hash) return appRedirect(env, "use_password");
      if (existing.google_sub) return appRedirect(env, "google_failed");
      await run(env, "UPDATE users SET google_sub=? WHERE id=?", googleSub, existing.id);
      userId = existing.id;
    } else {
      const displayName =
        String(profile.name || "").trim() || email.split("@")[0].slice(0, 60);
      const photo = /^https:\/\//.test(String(profile.picture || ""))
        ? String(profile.picture)
        : null;
      const inserted = await run(
        env,
        `INSERT INTO users(email,display_name,google_sub,profile_photo,password_salt,password_hash) VALUES(?,?,?,?,NULL,NULL)`,
        email,
        displayName.slice(0, 60),
        googleSub,
        photo
      );
      userId = inserted.meta.last_row_id;
    }
  }

  const user = await first(env, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id=?`, userId);
  if (!user) return appRedirect(env, "google_failed");

  const token = await createSession(env, userId);
  const origin = env.APP_ORIGIN || "https://circle-app-9nh.pages.dev";
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(origin).toString(),
      "Set-Cookie": [
        sessionCookie(env.SESSION_COOKIE_NAME || "circle_session", token, SESSION_MAX_AGE),
        stateCookie("", 0)
      ],
      "Cache-Control": "no-store"
    }
  });
}
