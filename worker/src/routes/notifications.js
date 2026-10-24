import { all, first, run } from "../db.js";
import { json, readJson, parseId } from "../http.js";

const LIST_LIMIT = 50;

/**
 * Records a notification for another user. Never throws: notification
 * delivery is best-effort and must not fail the action that triggered it.
 */
export async function notifyUser(env, { userId, actorId, type, entityType = "", entityId = null, message }) {
  if (!userId || !message) return;
  if (actorId && actorId === userId) return;
  try {
    await run(
      env,
      "INSERT INTO notifications(user_id,actor_id,type,entity_type,entity_id,message) VALUES(?,?,?,?,?,?)",
      userId,
      actorId || null,
      type,
      entityType,
      entityId || null,
      message
    );
  } catch (error) {
    console.error("Notification insert failed:", error);
  }
}

function shapeNotification(row) {
  return {
    id: row.id,
    type: row.type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    message: row.message,
    actor_id: row.actor_id,
    actor_name: row.actor_name || "",
    actor_photo: row.actor_photo || "",
    read: Boolean(row.read_at),
    created_at: row.created_at
  };
}

const SELECT_COLUMNS = `n.id,n.type,n.entity_type,n.entity_id,n.message,n.actor_id,n.read_at,n.created_at,
  a.display_name AS actor_name,a.profile_photo AS actor_photo`;

export async function listNotifications(env, url, user) {
  const since = parseId(url.searchParams.get("since"));
  const rows = since
    ? await all(
        env,
        `SELECT ${SELECT_COLUMNS} FROM notifications n LEFT JOIN users a ON a.id=n.actor_id
         WHERE n.user_id=? AND n.id>? ORDER BY n.id ASC LIMIT ?`,
        user.id,
        since,
        LIST_LIMIT
      )
    : await all(
        env,
        `SELECT ${SELECT_COLUMNS} FROM notifications n LEFT JOIN users a ON a.id=n.actor_id
         WHERE n.user_id=? ORDER BY n.id DESC LIMIT ?`,
        user.id,
        LIST_LIMIT
      );

  const countRow = await first(
    env,
    "SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND read_at IS NULL",
    user.id
  );
  const latest = await first(
    env,
    "SELECT COALESCE(MAX(id),0) AS latest FROM notifications WHERE user_id=?",
    user.id
  );

  return json({
    notifications: rows.map(shapeNotification),
    unreadCount: countRow?.total || 0,
    latestId: latest?.latest || 0,
    since
  });
}

export async function markNotificationsRead(env, request, user) {
  const body = await readJson(request);
  const id = parseId(body.id);
  if (id) {
    await run(
      env,
      "UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? AND read_at IS NULL",
      id,
      user.id
    );
  } else {
    await run(
      env,
      "UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND read_at IS NULL",
      user.id
    );
  }
  const countRow = await first(
    env,
    "SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND read_at IS NULL",
    user.id
  );
  return json({ unreadCount: countRow?.total || 0 });
}
