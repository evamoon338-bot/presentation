import { first, run } from "../db.js";
import {
  createSession,
  sessionCookie,
  SESSION_MAX_AGE,
  sha256Base64,
} from "../auth.js";
import { json, jsonWithCookie, readJson } from "../http.js";
import { PUBLIC_USER_COLUMNS } from "./auth-routes.js";

const MIN_PASSPHRASE_LENGTH = 32;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attemptsByIp = new Map();
const encoder = new TextEncoder();

function isRateLimited(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  let entry = attemptsByIp.get(ip);
  if (!entry || now - entry.startedAt >= ATTEMPT_WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
    attemptsByIp.set(ip, entry);
  }
  if (attemptsByIp.size > 1000) {
    for (const [key, value] of attemptsByIp) {
      if (now - value.startedAt >= ATTEMPT_WINDOW_MS) attemptsByIp.delete(key);
    }
  }
  if (entry.count >= MAX_ATTEMPTS) return true;
  entry.count += 1;
  return false;
}

function constantTimeEqual(candidate, expected) {
  const candidateBytes = encoder.encode(candidate);
  const expectedBytes = encoder.encode(expected);
  let difference = candidateBytes.length ^ expectedBytes.length;
  const length = Math.max(candidateBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return difference === 0;
}

export async function loginVerificationManager(env, request, cookieName) {
  if (isRateLimited(request)) {
    return json(
      { error: "Too many attempts. Wait 15 minutes before trying again." },
      429,
    );
  }

  const expected = String(env.VERIFICATION_MANAGER_PASSPHRASE || "");
  if (encoder.encode(expected).length < MIN_PASSPHRASE_LENGTH) {
    return json(
      { error: "Manager passphrase sign-in is not configured. Contact the site administrator." },
      503,
    );
  }

  const body = await readJson(request);
  const candidate = String(body.passphrase || "");
  if (!constantTimeEqual(candidate, expected)) {
    return json({ error: "The manager passphrase is incorrect." }, 401);
  }

  const managerEmail = String(env.VERIFICATION_MANAGER_EMAIL || "")
    .trim()
    .toLowerCase();
  const manager = await first(
    env,
    "SELECT id FROM users WHERE lower(email)=? LIMIT 1",
    managerEmail,
  );
  if (!manager) {
    return json(
      { error: "The configured verification manager account was not found." },
      403,
    );
  }

  const token = await createSession(env, manager.id);
  const tokenHash = await sha256Base64(token);
  await run(
    env,
    "INSERT INTO manager_access_sessions(token_hash) VALUES(?)",
    tokenHash,
  );
  const user = await first(
    env,
    `SELECT ${PUBLIC_USER_COLUMNS},1 AS is_verification_manager FROM users WHERE id=?`,
    manager.id,
  );
  return jsonWithCookie(
    { user },
    200,
    sessionCookie(cookieName, token, SESSION_MAX_AGE),
  );
}
