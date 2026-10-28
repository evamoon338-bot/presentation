import { all, run } from "../db.js";
import { json, readJson } from "../http.js";

const SUBSCRIBE_LIMIT = 10;

function trim(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/** Encrypts a JSON payload for one push subscription (RFC 8291, aes128gcm). */
async function encryptPayload(payloadText, p256dh, authSecret) {
  const uaPublic = base64UrlToBytes(p256dh);
  const authBytes = base64UrlToBytes(authSecret);

  const asKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256)
  );

  const authPrk = await hkdf(authBytes, shared, new TextEncoder().encode("WebPush: info\0"), 32);
  const ikm = await hkdf(
    authPrk,
    shared,
    concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublicRaw),
    32
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(new TextEncoder().encode(payloadText), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext)
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, ciphertext.length + 1, false);

  return concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

async function createVapidJwt(env, audience) {
  const subject = env.VAPID_SUBJECT || "mailto:admin@example.com";
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;

  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const signingInput = `${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)))}.${bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims))
  )}`;

  const publicRaw = base64UrlToBytes(publicKey);
  if (publicRaw.length !== 65) return null;
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicRaw.slice(1, 33)),
    y: bytesToBase64Url(publicRaw.slice(33, 65)),
    d: bytesToBase64Url(base64UrlToBytes(privateKey)),
  };
  let key;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
  } catch (error) {
    console.error("VAPID key import failed:", error);
    return null;
  }

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput)
    )
  );
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

async function deliverPush(env, subscription, payloadText) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await createVapidJwt(env, audience);
  if (!jwt) return;

  const body = await encryptPayload(payloadText, subscription.p256dh, subscription.auth);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "3600",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });

  if (response.status === 404 || response.status === 410) {
    await run(env, "DELETE FROM push_subscriptions WHERE endpoint=?", subscription.endpoint);
  } else if (!response.ok) {
    console.error("Push delivery failed:", response.status, await response.text().catch(() => ""));
  }
}

/** Best-effort: sends a Web Push notification to every device a user has registered. */
export async function sendPushToUser(env, userId, payload) {
  try {
    const rows = await all(
      env,
      "SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?",
      userId
    );
    if (!rows.length) return;
    const text = JSON.stringify(payload);
    await Promise.all(rows.map((row) => deliverPush(env, row, text).catch(() => {})));
  } catch (error) {
    console.error("Push dispatch failed:", error);
  }
}

export async function pushPublicKey(env) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY || "" });
}

export async function subscribePush(env, request, user) {
  const body = await readJson(request);
  const endpoint = trim(body.endpoint, 1024);
  const p256dh = trim(body.keys && body.keys.p256dh, 256);
  const auth = trim(body.keys && body.keys.auth, 256);
  if (!endpoint || !p256dh || !auth) return json({ error: "Invalid subscription." }, 400);

  const existing = await all(env, "SELECT id FROM push_subscriptions WHERE user_id=?", user.id);
  if (existing.length >= SUBSCRIBE_LIMIT) {
    await run(
      env,
      "DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY id ASC LIMIT ?)",
      user.id,
      existing.length - SUBSCRIBE_LIMIT + 1
    );
  }

  const userAgent = trim(request.headers.get("User-Agent"), 255) || null;
  await run(
    env,
    "INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent",
    user.id,
    endpoint,
    p256dh,
    auth,
    userAgent
  );
  return json({ ok: true });
}

export async function unsubscribePush(env, request, user) {
  const body = await readJson(request);
  const endpoint = trim(body.endpoint, 1024);
  if (endpoint) {
    await run(env, "DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?", endpoint, user.id);
  } else {
    await run(env, "DELETE FROM push_subscriptions WHERE user_id=?", user.id);
  }
  return json({ ok: true });
}
