import { all, run } from "../db.js";
import { json, readJson } from "../http.js";

function isManager(user) {
  return Number(user.is_verification_manager) === 1;
}

function usernameFor(displayName) {
  return String(displayName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function requestedUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export async function lookupVerificationUser(env, url, user) {
  if (!isManager(user)) {
    return json({ error: "You are not allowed to manage verification badges." }, 403);
  }

  const username = requestedUsername(url.searchParams.get("username"));
  if (!/^[a-z0-9_]{1,60}$/.test(username)) {
    return json({ error: "Enter a valid username." }, 400);
  }

  const matches = (await all(env, "SELECT id,display_name,is_verified FROM users"))
    .filter((candidate) => usernameFor(candidate.display_name) === username);
  if (!matches.length) return json({ error: "No account matches that username." }, 404);
  if (matches.length > 1) {
    return json({ error: "That username is ambiguous. Use a more unique display name." }, 409);
  }

  return json({ user: { ...matches[0], username } });
}

export async function setVerificationBadge(env, request, user) {
  if (!isManager(user)) {
    return json({ error: "You are not allowed to manage verification badges." }, 403);
  }

  const body = await readJson(request);
  const username = requestedUsername(body.username);
  if (!/^[a-z0-9_]{1,60}$/.test(username)) {
    return json({ error: "Enter a valid username." }, 400);
  }
  if (typeof body.verified !== "boolean") {
    return json({ error: "Choose whether to grant or remove the badge." }, 400);
  }

  const matches = (await all(env, "SELECT id,display_name FROM users"))
    .filter((candidate) => usernameFor(candidate.display_name) === username);
  if (!matches.length) return json({ error: "No account matches that username." }, 404);
  if (matches.length > 1) {
    return json({ error: "That username is ambiguous. Use a more unique display name." }, 409);
  }

  const target = matches[0];
  await run(env, "UPDATE users SET is_verified=? WHERE id=?", body.verified ? 1 : 0, target.id);
  return json({
    user: {
      ...target,
      username,
      is_verified: body.verified ? 1 : 0,
    },
  });
}
