import { all, first, run } from "../db.js";
import { json, parseId, readJson } from "../http.js";
import { notifyUser } from "./notifications.js";

export async function listFriends(env, user) {
  const friends = await all(
    env,
    `SELECT fr.id AS request_id,u.id,u.display_name,
      CASE WHEN u.show_email=1 THEN u.email ELSE NULL END AS email,
      u.show_email,fr.status,
      CASE WHEN fr.requester_id=? THEN 1 ELSE 0 END AS sent_by_me
    FROM friend_requests fr
    JOIN users u ON u.id=CASE WHEN fr.requester_id=? THEN fr.target_id ELSE fr.requester_id END
    WHERE fr.requester_id=? OR fr.target_id=?
    ORDER BY fr.id DESC`,
    user.id,
    user.id,
    user.id,
    user.id,
  );
  return json({ friends });
}

export async function searchUsers(env, url, user) {
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2 || query.length > 60) return json({ users: [] });
  const users = await all(
    env,
    `SELECT id,display_name,
      CASE WHEN show_email=1 THEN email ELSE NULL END AS email
    FROM users WHERE id<>? AND instr(lower(display_name),lower(?))>0
    ORDER BY display_name LIMIT 20`,
    user.id,
    query,
  );
  return json({ users });
}

export async function createFriendRequest(env, request, user) {
  const body = await readJson(request);
  const requestedId = parseId(body.userId);
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const target = requestedId
    ? await first(
        env,
        "SELECT id FROM users WHERE id=? AND id<>? LIMIT 1",
        requestedId,
        user.id,
      )
    : await first(
        env,
        "SELECT id FROM users WHERE email=? AND id<>? LIMIT 1",
        email,
        user.id,
      );
  // Respond identically whether or not the account exists so this endpoint
  // cannot be used to confirm which emails are registered.
  if (!target) {
    return json(
      { error: "If that account exists, a friend request was sent." },
      202
    );
  }

  const existing = await first(
    env,
    "SELECT id FROM friend_requests WHERE (requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?) LIMIT 1",
    user.id,
    target.id,
    target.id,
    user.id,
  );
  if (existing) {
    return json(
      { error: "If that account exists, a friend request was sent." },
      202
    );
  }

  await run(
    env,
    "INSERT INTO friend_requests(requester_id,target_id,status) VALUES(?,?,'pending')",
    user.id,
    target.id,
  );
  await notifyUser(env, {
    userId: target.id,
    actorId: user.id,
    type: "friend_request",
    entityType: "user",
    entityId: user.id,
    message: `${user.display_name} sent you a friend request.`,
  });
  return json(
    { error: "If that account exists, a friend request was sent." },
    202
  );
}

export async function acceptFriendRequest(env, request, user) {
  const body = await readJson(request);
  const requestId = parseId(body.id);
  if (!requestId) return json({ error: "Pending request not found." }, 404);
  const result = await run(
    env,
    "UPDATE friend_requests SET status='accepted' WHERE id=? AND target_id=? AND status='pending'",
    requestId,
    user.id,
  );
  if (!result.meta.changes)
    return json({ error: "Pending request not found." }, 404);
  const requester = await first(
    env,
    "SELECT requester_id FROM friend_requests WHERE id=? LIMIT 1",
    requestId,
  );
  await notifyUser(env, {
    userId: requester?.requester_id,
    actorId: user.id,
    type: "friend_accept",
    entityType: "user",
    entityId: user.id,
    message: `${user.display_name} accepted your friend request.`,
  });
  return json({ accepted: true });
}

export async function getCommunity(env, user) {
  const [groups, rsvps] = await Promise.all([
    all(
      env,
      "SELECT group_slug FROM group_memberships WHERE user_id=?",
      user.id,
    ),
    all(env, "SELECT event_slug FROM event_rsvps WHERE user_id=?", user.id),
  ]);
  return json({ groups, rsvps });
}

export async function setGroupMembership(env, request, user) {
  const body = await readJson(request);
  const slug = String(body.slug ?? "");
  if (!["hikers", "recipes", "neighborhood"].includes(slug)) {
    return json({ error: "Group not found." }, 400);
  }
  const joined = !!body.joined;
  if (joined) {
    await run(
      env,
      "INSERT OR IGNORE INTO group_memberships(user_id,group_slug) VALUES(?,?)",
      user.id,
      slug,
    );
  } else {
    await run(
      env,
      "DELETE FROM group_memberships WHERE user_id=? AND group_slug=?",
      user.id,
      slug,
    );
  }
  return json({ slug, joined });
}

export async function setEventRsvp(env, request, user) {
  const body = await readJson(request);
  const slug = String(body.slug ?? "");
  if (!["market", "hike", "dinner"].includes(slug)) {
    return json({ error: "Event not found." }, 400);
  }
  const going = !!body.going;
  if (going) {
    await run(
      env,
      "INSERT OR IGNORE INTO event_rsvps(user_id,event_slug) VALUES(?,?)",
      user.id,
      slug,
    );
  } else {
    await run(
      env,
      "DELETE FROM event_rsvps WHERE user_id=? AND event_slug=?",
      user.id,
      slug,
    );
  }
  return json({ slug, going });
}

async function areFriends(env, firstUserId, secondUserId) {
  return first(
    env,
    `SELECT id FROM friend_requests WHERE status='accepted'
      AND ((requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?)) LIMIT 1`,
    firstUserId,
    secondUserId,
    secondUserId,
    firstUserId,
  );
}

export async function listMessages(env, user) {
  const messages = await all(
    env,
    `SELECT m.id,m.sender_id,s.display_name AS sender_name,
      m.recipient_id,r.display_name AS recipient_name,m.body,m.created_at,m.read_at
    FROM messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.recipient_id
    WHERE m.sender_id=? OR m.recipient_id=? ORDER BY m.id ASC LIMIT 500`,
    user.id,
    user.id,
  );
  return json({ messages });
}

export async function markMessagesRead(env, request, user) {
  const body = await readJson(request);
  const senderId = parseId(body.senderId);
  if (
    !senderId ||
    senderId === user.id ||
    !(await areFriends(env, user.id, senderId))
  ) {
    return json({ error: "Conversation not found." }, 404);
  }
  const result = await run(
    env,
    "UPDATE messages SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sender_id=? AND recipient_id=? AND read_at IS NULL",
    senderId,
    user.id,
  );
  return json({ senderId, updated: result.meta.changes || 0 });
}

export async function sendMessage(env, request, user) {
  const body = await readJson(request);
  const recipientId = parseId(body.recipientId);
  const text = String(body.body ?? "").trim();
  if (text.length < 1 || text.length > 500) {
    return json(
      { error: "Messages must be between 1 and 500 characters." },
      400,
    );
  }
  if (
    !recipientId ||
    recipientId === user.id ||
    !(await areFriends(env, user.id, recipientId))
  ) {
    return json({ error: "You can message accepted friends only." }, 403);
  }
  const result = await run(
    env,
    "INSERT INTO messages(sender_id,recipient_id,body) VALUES(?,?,?)",
    user.id,
    recipientId,
    text,
  );
  const message = await first(
    env,
    "SELECT id,body,created_at FROM messages WHERE id=?",
    result.meta.last_row_id,
  );
  await notifyUser(env, {
    userId: recipientId,
    actorId: user.id,
    type: "message",
    entityType: "message",
    entityId: result.meta.last_row_id,
    message: `${user.display_name} sent you a message.`,
  });
  return json({ message }, 201);
}
