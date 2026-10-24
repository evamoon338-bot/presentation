import { all, first, run } from "../db.js";
import {
  createPasswordCredentials,
  verifyPassword,
  createSession,
  destroySession,
  sessionCookie,
  SESSION_MAX_AGE
} from "../auth.js";
import { json, jsonWithCookie, readJson, isEmail } from "../http.js";

const PUBLIC_USER_COLUMNS =
  "id,email,display_name,profile_photo,about_me,audience,email_notifications,product_updates,show_email";

const MAX_PASSWORD_LENGTH = 256;
const PROFILE_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PROFILE_PHOTO_CHARS = 700000;

/**
 * Accepts only an image data URL of an allowed type, so arbitrary text or
 * script-bearing MIME types cannot be stored and later echoed to viewers.
 * Returns "" to clear the photo, or null when the value is invalid.
 */
function normalizeProfilePhoto(value) {
  if (!value) return "";
  if (value.length > MAX_PROFILE_PHOTO_CHARS) return null;
  const match = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return null;
  return PROFILE_PHOTO_TYPES.has(match[1].toLowerCase()) ? value : null;
}

export async function register(env, request, cookieName) {
  const body = await readJson(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim();
  const password = String(body.password ?? "");

  if (!isEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (displayName.length < 1 || displayName.length > 60) {
    return json({ error: "Display name must be between 1 and 60 characters." }, 400);
  }
  if (password.length < 8 || password.length > MAX_PASSWORD_LENGTH) {
    return json({ error: "Password must be at least 8 characters." }, 400);
  }

  const existing = await first(env, "SELECT id FROM users WHERE email=? LIMIT 1", email);
  if (existing) return json({ error: "An account with this email already exists." }, 409);

  const credentials = await createPasswordCredentials(password);
  const result = await run(
    env,
    `INSERT INTO users(email,display_name,password_salt,password_hash,profile_photo) VALUES(?,?,?,?,NULL)`,
    email,
    displayName,
    credentials.salt,
    credentials.hash
  );
  const userId = result.meta.last_row_id;
  const user = await first(env, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id=?`, userId);
  const token = await createSession(env, userId);
  return jsonWithCookie(
    { user },
    201,
    sessionCookie(cookieName, token, SESSION_MAX_AGE)
  );
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const loginAttempts = new Map();

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

function tooManyAttempts(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordAttempt(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

// Constant-cost comparison so a missing account takes as long as a wrong password.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
const DUMMY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function login(env, request, cookieName) {
  const attemptKey = clientKey(request);
  if (tooManyAttempts(attemptKey)) {
    return json({ error: "Too many sign-in attempts. Try again later." }, 429);
  }

  const body = await readJson(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  const row = await first(
    env,
    "SELECT id,password_salt,password_hash FROM users WHERE email=? LIMIT 1",
    email
  );
  const valid = row
    ? await verifyPassword(password, row.password_salt, row.password_hash)
    : (await verifyPassword(password, DUMMY_SALT, DUMMY_HASH), false);
  if (!valid || !row) {
    recordAttempt(attemptKey);
    return json({ error: "Email or password is incorrect." }, 401);
  }

  loginAttempts.delete(attemptKey);
  const user = await first(env, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id=?`, row.id);
  const token = await createSession(env, row.id);
  return jsonWithCookie({ user }, 200, sessionCookie(cookieName, token, SESSION_MAX_AGE));
}

export async function logout(env, request, cookieName, token) {
  await destroySession(env, token);
  return jsonWithCookie({ authenticated: false }, 200, sessionCookie(cookieName, "", 0));
}

export async function settingsGet(user) {
  return json({ user });
}

export async function settingsUpdate(env, request, user) {
  const body = await readJson(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim();
  const aboutMe = String(body.aboutMe ?? "").trim();
  const audience = String(body.audience ?? "");
  const profilePhoto = String(body.profilePhoto ?? "");

  if (!isEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (displayName.length < 1 || displayName.length > 60) {
    return json({ error: "Display name must be between 1 and 60 characters." }, 400);
  }
  if (aboutMe.length > 500) {
    return json({ error: "About me must be 500 characters or fewer." }, 400);
  }
  if (!["friends", "public", "private"].includes(audience)) {
    return json({ error: "Choose a valid post audience." }, 400);
  }

  const normalizedPhoto = normalizeProfilePhoto(profilePhoto);
  if (normalizedPhoto === null) {
    return json(
      {
        error:
          "Profile photos must be a JPEG, PNG, WebP, or GIF image under 700 KB."
      },
      400
    );
  }

  const taken = await first(
    env,
    "SELECT id FROM users WHERE email=? AND id<>? LIMIT 1",
    email,
    user.id
  );
  if (taken) return json({ error: "That email is already used by another account." }, 409);

  await run(
    env,
    `UPDATE users SET email=?,display_name=?,profile_photo=?,about_me=?,audience=?,email_notifications=?,product_updates=?,show_email=? WHERE id=?`,
    email,
    displayName,
    normalizedPhoto || null,
    aboutMe,
    audience,
    body.emailNotifications ? 1 : 0,
    body.productUpdates ? 1 : 0,
    body.showEmail ? 1 : 0,
    user.id
  );

  const updated = await first(env, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id=?`, user.id);
  return json({ user: updated });
}

export async function passwordUpdate(env, request, user, cookieName) {
  const body = await readJson(request);
  const row = await first(
    env,
    "SELECT password_salt,password_hash FROM users WHERE id=? LIMIT 1",
    user.id
  );
  const valid = row && (await verifyPassword(String(body.currentPassword ?? ""), row.password_salt, row.password_hash));
  if (!valid) return json({ error: "Current password is incorrect." }, 400);

  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 8 || newPassword.length > MAX_PASSWORD_LENGTH) {
    return json({ error: "New password must be at least 8 characters." }, 400);
  }

  const credentials = await createPasswordCredentials(newPassword);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_salt=?,password_hash=? WHERE id=?").bind(
      credentials.salt,
      credentials.hash,
      user.id
    ),
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id)
  ]);

  return jsonWithCookie(
    { authenticated: false, message: "Password changed. Please sign in again." },
    200,
    sessionCookie(cookieName, "", 0)
  );
}
