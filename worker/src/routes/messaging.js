import { all, batch, first, run } from "../db.js";
import { json, parseId, readJson } from "../http.js";
import { notifyUser } from "./notifications.js";

const MAX_MESSAGE_LENGTH = 500;
const MAX_ATTACHMENT_BYTES = 500 * 1024;
const ALLOWED_EMOJI = new Set(["👍", "❤️", "😂", "😮", "😢", "🔥", "👏", "🙏"]);
async function areFriends(env, userId, peerId) {
  return first(
    env,
    `SELECT id FROM friend_requests WHERE status='accepted'
      AND ((requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?))
      LIMIT 1`,
    userId,
    peerId,
    peerId,
    userId,
  );
}

function validAttachment(data, mime) {
  if (!data) return true;
  if (data.length > 700_000) return false;
  const match = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match || match[1].toLowerCase() !== mime) return false;
  const allowed =
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) ||
    ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"].includes(mime) ||
    ["application/pdf", "text/plain", "text/csv", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mime);
  if (!allowed) return false;
  try {
    return atob(match[2]).length <= MAX_ATTACHMENT_BYTES;
  } catch {
    return false;
  }
}

function validateBody(text, attachment) {
  return (text.length > 0 || attachment) && text.length <= MAX_MESSAGE_LENGTH;
}

async function groupForMember(env, conversationId, userId) {
  return first(
    env,
    `SELECT gc.id,gc.name FROM group_conversations gc
     JOIN group_conversation_members gm ON gm.conversation_id=gc.id
     WHERE gc.id=? AND gm.user_id=? LIMIT 1`,
    conversationId,
    userId,
  );
}

export async function listGroupConversations(env, user) {
  const groups = await all(
    env,
    `SELECT gc.id,gc.name,gc.created_by,gc.created_at,
      (SELECT COUNT(*) FROM group_conversation_members gm WHERE gm.conversation_id=gc.id) AS member_count,
      (SELECT gm2.user_id FROM group_conversation_members gm2
       WHERE gm2.conversation_id=gc.id AND gm2.user_id<>? ORDER BY gm2.user_id LIMIT 1) AS peer_id
     FROM group_conversations gc
     JOIN group_conversation_members gm ON gm.conversation_id=gc.id
     WHERE gm.user_id=? ORDER BY gc.id DESC`,
    user.id,
    user.id,
  );
  return json({ groups });
}

export async function createGroupConversation(env, request, user) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  const memberIds = [...new Set(rawIds.map(parseId).filter(Boolean))]
    .filter((id) => id !== Number(user.id));
  if (name.length < 1 || name.length > 60) {
    return json({ error: "Group name must be between 1 and 60 characters." }, 400);
  }
  if (memberIds.length > 9) {
    return json({ error: "Groups can include up to 9 friends plus you." }, 400);
  }
  for (const id of memberIds) {
    if (!(await areFriends(env, user.id, id))) {
      return json({ error: "Groups can include accepted friends only." }, 403);
    }
  }
  if (!memberIds.length) {
    return json({ error: "Choose at least one friend for the group." }, 400);
  }

  const created = await run(
    env,
    "INSERT INTO group_conversations(name,created_by) VALUES(?,?)",
    name,
    user.id,
  );
  const conversationId = created.meta.last_row_id;
  await batch(env, [
    env.DB.prepare(
      "INSERT INTO group_conversation_members(conversation_id,user_id) VALUES(?,?)",
    ).bind(conversationId, user.id),
    ...memberIds.map((id) =>
      env.DB.prepare(
        "INSERT INTO group_conversation_members(conversation_id,user_id) VALUES(?,?)",
      ).bind(conversationId, id),
    ),
  ]);
  return json(
    { group: { id: conversationId, name, created_by: user.id, member_count: memberIds.length + 1 } },
    201,
  );
}

export async function listGroupMessages(env, conversationId, user) {
  const group = await groupForMember(env, conversationId, user.id);
  if (!group) return json({ error: "Conversation not found." }, 404);
  const messages = await all(
    env,
    `SELECT gm.id,gm.conversation_id,gm.sender_id,u.display_name AS sender_name,
      gm.body,gm.attachment_data,gm.attachment_mime,gm.attachment_name,gm.edited_at,gm.reply_to_id,
      gm.forwarded_from_id,gm.created_at
     FROM group_messages gm JOIN users u ON u.id=gm.sender_id
     WHERE gm.conversation_id=? ORDER BY gm.id DESC LIMIT 100`,
    conversationId,
  );
  const reactions = messages.length
    ? await all(
        env,
        `SELECT message_id,emoji,COUNT(*) AS count,
          MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS reacted
         FROM group_message_reactions
         WHERE message_id IN (${messages.map(() => "?").join(",")})
         GROUP BY message_id,emoji`,
        user.id,
        ...messages.map((message) => message.id),
      )
    : [];
  const reactionsByMessage = {};
  for (const reaction of reactions) {
    (reactionsByMessage[reaction.message_id] ||= []).push(reaction);
  }
  for (const message of messages) {
    message.reactions = reactionsByMessage[message.id] || [];
  }
  return json({ conversation: group, messages: messages.reverse() });
}

export async function sendGroupMessage(env, request, conversationId, user) {
  const group = await groupForMember(env, conversationId, user.id);
  if (!group) {
    return json({ error: "Conversation not found." }, 404);
  }
  const body = await readJson(request);
  const text = String(body.body || "").trim();
  const attachment = String(body.attachmentData || "");
  const mime = String(body.attachmentMime || "").toLowerCase();
  const attachmentName = String(body.attachmentName || "attachment")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120) || "attachment";
  if (!validateBody(text, attachment)) {
    return json({ error: "Messages must contain text or an attachment; text is limited to 500 characters." }, 400);
  }
  if (!validAttachment(attachment, mime)) {
    return json({ error: "Attach a supported image, audio, or document under 500 KB." }, 400);
  }
  const replyToId = parseId(body.replyToId);
  if (replyToId && !(await first(
    env,
    "SELECT id FROM group_messages WHERE id=? AND conversation_id=? LIMIT 1",
    replyToId,
    conversationId,
  ))) {
    return json({ error: "Reply target not found in this conversation." }, 404);
  }
  const forwardedFromId = parseId(body.forwardedFromId);
  if (
    forwardedFromId &&
    !(await first(
      env,
      `SELECT gm.id FROM group_messages gm
       JOIN group_conversation_members member ON member.conversation_id=gm.conversation_id
       WHERE gm.id=? AND member.user_id=? LIMIT 1`,
      forwardedFromId,
      user.id,
    ))
  ) {
    return json({ error: "Forwarded message not found." }, 404);
  }
  const created = await run(
    env,
    `INSERT INTO group_messages(conversation_id,sender_id,body,attachment_data,attachment_mime,attachment_name,reply_to_id,forwarded_from_id)
     VALUES(?,?,?,?,?,?,?,?)`,
    conversationId,
    user.id,
    text || (mime.startsWith("audio/") ? "Voice message" : "Shared an attachment"),
    attachment || null,
    attachment ? mime : null,
    attachment ? attachmentName : null,
    replyToId || null,
    forwardedFromId || null,
  );
  const message = await first(
    env,
    "SELECT id,conversation_id,sender_id,body,attachment_data,attachment_mime,attachment_name,reply_to_id,forwarded_from_id,created_at FROM group_messages WHERE id=?",
    created.meta.last_row_id,
  );
  const memberRows = await all(
    env,
    "SELECT user_id FROM group_conversation_members WHERE conversation_id=? AND user_id<>?",
    conversationId,
    user.id,
  );
  await Promise.all(
    memberRows.map((member) =>
      notifyUser(env, {
        userId: member.user_id,
        actorId: user.id,
        type: "message",
        entityType: "group_message",
        entityId: message.id,
        message: `${user.display_name} sent a message in ${group.name}.`,
      }),
    ),
  );
  return json({ message }, 201);
}

export async function mutateMessage(env, request, messageId, user, group = false) {
  const table = group ? "group_messages" : "messages";
  const reactions = group ? "group_message_reactions" : "message_reactions";
  const body = await readJson(request);
  const action = String(body.action || "");
  const message = await first(
    env,
    group
      ? "SELECT id,sender_id,NULL AS recipient_id,conversation_id,body FROM group_messages WHERE id=? LIMIT 1"
      : "SELECT id,sender_id,recipient_id,NULL AS conversation_id,body FROM messages WHERE id=? LIMIT 1",
    messageId,
  );
  if (!message) return json({ error: "Message not found." }, 404);
  const canAccess = group
    ? !!(await groupForMember(env, message.conversation_id, user.id))
    : (Number(message.sender_id) === Number(user.id) ||
        Number(message.recipient_id) === Number(user.id)) &&
      !!(await areFriends(
        env,
        Number(message.sender_id),
        Number(message.recipient_id),
      ));
  if (!canAccess) return json({ error: "Message not found." }, 404);

  if (action === "edit") {
    if (Number(message.sender_id) !== Number(user.id)) {
      return json({ error: "You can only edit your own messages." }, 403);
    }
    const text = String(body.body || "").trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      return json({ error: "Edited messages must be between 1 and 500 characters." }, 400);
    }
    await run(
      env,
      `UPDATE ${table} SET body=?,edited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND sender_id=?`,
      text,
      messageId,
      user.id,
    );
    return json({ updated: true });
  }
  if (action === "delete") {
    if (Number(message.sender_id) !== Number(user.id)) {
      return json({ error: "You can only delete your own messages." }, 403);
    }
    await run(env, `DELETE FROM ${table} WHERE id=? AND sender_id=?`, messageId, user.id);
    return json({ deleted: true });
  }
  if (action === "react") {
    const emoji = String(body.emoji || "");
    if (!ALLOWED_EMOJI.has(emoji)) return json({ error: "Choose a supported reaction." }, 400);
    const existing = await first(
      env,
      `SELECT 1 AS found FROM ${reactions} WHERE message_id=? AND user_id=? AND emoji=?`,
      messageId,
      user.id,
      emoji,
    );
    if (existing) {
      await run(env, `DELETE FROM ${reactions} WHERE message_id=? AND user_id=? AND emoji=?`, messageId, user.id, emoji);
    } else {
      await run(env, `INSERT INTO ${reactions}(message_id,user_id,emoji) VALUES(?,?,?)`, messageId, user.id, emoji);
    }
    return json({ emoji, reacted: !existing });
  }
  return json({ error: "Unsupported message action." }, 400);
}

export async function touchPresence(env, request, user) {
  const body = await readJson(request);
  const targetType = String(body.targetType || "");
  const targetId = parseId(body.targetId);
  if (!["direct", "group"].includes(targetType) || !targetId) {
    return json({ error: "Conversation not found." }, 400);
  }
  if (targetType === "direct") {
    if (targetId === Number(user.id) || !(await areFriends(env, user.id, targetId))) {
      return json({ error: "Conversation not found." }, 404);
    }
  } else if (!(await groupForMember(env, targetId, user.id))) {
    return json({ error: "Conversation not found." }, 404);
  }
  const now = new Date().toISOString();
  await run(
    env,
    "INSERT INTO chat_presence(user_id,last_seen_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at",
    user.id,
    now,
  );
  if (body.typing === true) {
    await run(
      env,
      `INSERT INTO chat_typing(user_id,target_type,target_id,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET target_type=excluded.target_type,target_id=excluded.target_id,updated_at=excluded.updated_at`,
      user.id,
      targetType,
      targetId,
      now,
    );
  } else if (body.typing === false) {
    await run(env, "DELETE FROM chat_typing WHERE user_id=?", user.id);
  }

  const targetUserIds =
    targetType === "direct"
      ? [targetId]
      : (await all(
          env,
          "SELECT user_id FROM group_conversation_members WHERE conversation_id=? AND user_id<>?",
          targetId,
          user.id,
        )).map((row) => row.user_id);
  if (!targetUserIds.length) return json({ online: [], typing: [] });
  const placeholders = targetUserIds.map(() => "?").join(",");
  const online = await all(
    env,
    `SELECT user_id FROM chat_presence WHERE user_id IN (${placeholders}) AND last_seen_at>?`,
    ...targetUserIds,
    new Date(Date.now() - 60_000).toISOString(),
  );
  const typing = await all(
    env,
    `SELECT u.id,u.display_name FROM chat_typing t JOIN users u ON u.id=t.user_id
     WHERE t.user_id IN (${placeholders}) AND t.target_type=? AND t.target_id=? AND t.updated_at>?`,
    ...targetUserIds,
    targetType,
    targetId,
    new Date(Date.now() - 10_000).toISOString(),
  );
  return json({ online: online.map((row) => row.user_id), typing });
}

function isValidSignal(value, maxLength = 100_000) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

async function callForParticipant(env, callId, user) {
  return first(
    env,
    "SELECT * FROM voice_calls WHERE id=? AND (caller_id=? OR callee_id=?) LIMIT 1",
    callId,
    user.id,
    user.id,
  );
}

export async function handleVoiceCall(env, request, url, user) {
  if (request.method === "GET") {
    const callId = String(url.searchParams.get("callId") || "");
    if (callId) {
      const call = await callForParticipant(env, callId, user);
      if (!call) return json({ error: "Call not found." }, 404);
      const afterId = parseId(url.searchParams.get("after")) || 0;
      const candidates = await all(
        env,
        "SELECT id,sender_id,candidate FROM voice_call_candidates WHERE call_id=? AND sender_id<>? AND id>? ORDER BY id ASC LIMIT 50",
        callId,
        user.id,
        afterId,
      );
      return json({ call, candidates });
    }
    const incoming = await all(
      env,
      `SELECT vc.id,vc.caller_id,u.display_name AS caller_name,vc.status,vc.created_at,
        CASE WHEN instr(vc.offer,'m=video')>0 THEN 1 ELSE 0 END AS is_video
       FROM voice_calls vc JOIN users u ON u.id=vc.caller_id
       WHERE vc.callee_id=? AND vc.status='ringing'
         AND vc.updated_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')
       ORDER BY vc.created_at DESC LIMIT 5`,
      user.id,
    );
    return json({ incoming });
  }

  const body = await readJson(request);
  const action = String(body.action || "");
  if (action === "start") {
    const calleeId = parseId(body.calleeId);
    if (!calleeId || calleeId === Number(user.id) || !(await areFriends(env, user.id, calleeId))) {
      return json({ error: "Voice calls are available between accepted friends only." }, 403);
    }
    if (!isValidSignal(body.offer)) return json({ error: "Invalid call offer." }, 400);
    await run(
      env,
      `UPDATE voice_calls SET status='ended',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE (status='ringing' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))
          OR (status='accepted' AND updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))`,
    );
    const active = await first(
      env,
      `SELECT id FROM voice_calls
       WHERE ((status='ringing' AND updated_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))
          OR (status='accepted' AND updated_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')))
       AND (caller_id IN (?,?) OR callee_id IN (?,?)) LIMIT 1`,
      user.id,
      calleeId,
      user.id,
      calleeId,
    );
    if (active) return json({ error: "One of you is already in a call." }, 409);
    const callId = crypto.randomUUID();
    await run(
      env,
      "INSERT INTO voice_calls(id,caller_id,callee_id,status,offer) VALUES(?,?,?,'ringing',?)",
      callId,
      user.id,
      calleeId,
      body.offer,
    );
    const isVideo = String(body.mediaType || body.callType || "audio") === "video" || body.video === true;
    notifyUser(env, {
      userId: calleeId,
      actorId: user.id,
      type: "call",
      entityType: "call",
      entityId: null,
      message: `${user.display_name} is calling you${isVideo ? " on video" : ""}.`,
    }).catch(() => {});
    return json({ callId }, 201);
  }

  const callId = String(body.callId || "");
  const call = callId ? await callForParticipant(env, callId, user) : null;
  if (!call) return json({ error: "Call not found." }, 404);
  const isCaller = Number(call.caller_id) === Number(user.id);
  const now = new Date().toISOString();
  if (action === "heartbeat") {
    if (call.status !== "accepted") {
      return json({ error: "Only an accepted call can be kept active." }, 409);
    }
    await run(
      env,
      "UPDATE voice_calls SET updated_at=? WHERE id=? AND status='accepted'",
      now,
      callId,
    );
    return json({ updated: true });
  }
  if (action === "answer" && !isCaller && call.status === "ringing") {
    if (!isValidSignal(body.answer)) return json({ error: "Invalid call answer." }, 400);
    await run(env, "UPDATE voice_calls SET answer=?,status='accepted',updated_at=? WHERE id=? AND status='ringing'", body.answer, now, callId);
    return json({ updated: true });
  }
  if (action === "candidate") {
    if (!isValidSignal(body.candidate, 10_000)) return json({ error: "Invalid call network candidate." }, 400);
    if (!["ringing", "accepted"].includes(call.status)) return json({ error: "Call has ended." }, 409);
    await run(env, "INSERT INTO voice_call_candidates(call_id,sender_id,candidate) VALUES(?,?,?)", callId, user.id, body.candidate);
    return json({ sent: true });
  }
  if (action === "reject" && !isCaller && call.status === "ringing") {
    await run(env, "UPDATE voice_calls SET status='rejected',updated_at=? WHERE id=?", now, callId);
    return json({ updated: true });
  }
  if (action === "end" && ["ringing", "accepted"].includes(call.status)) {
    await run(env, "UPDATE voice_calls SET status='ended',updated_at=? WHERE id=?", now, callId);
    return json({ updated: true });
  }
  return json({ error: "Unsupported call action." }, 400);
}
