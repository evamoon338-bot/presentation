import { all, first, run } from "../db.js";
import { json, readJson, parseId } from "../http.js";
import {
  storeDataUrl,
  deleteKey,
  parseKeyList,
  serializeKeyList,
  exposeKeyList,
  isVideoDataUrl,
  UNSUPPORTED_VIDEO_MESSAGE
} from "../media.js";
import { notifyUser } from "./notifications.js";

/** Returns the owner of a post so notifications can be routed to them. */
async function postOwner(env, postId) {
  const row = await first(env, "SELECT user_id FROM posts WHERE id=? LIMIT 1", postId);
  return row?.user_id || 0;
}

const POST_COLUMNS = `p.id,p.user_id,u.display_name,u.profile_photo,u.about_me,u.audience,p.body,p.image_data,p.audio_data,p.created_at`;

/** Returns a non-negative array index, or -1 when the value is not one. */
function parseIndex(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return -1;
  const index = Number(text);
  return Number.isSafeInteger(index) ? index : -1;
}

function shapePost(row) {
  if (!row) return row;
  return {
    ...row,
    image_data: exposeKeyList(row.image_data),
    audio_data: exposeKeyList(row.audio_data)
  };
}

export async function visibility(env, postId, userId) {
  const row = await first(
    env,
    `SELECT p.id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? AND (u.audience='public' OR p.user_id=? OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=? AND fr.target_id=p.user_id) OR (fr.requester_id=p.user_id AND fr.target_id=?)))) LIMIT 1`,
    postId,
    userId,
    userId,
    userId
  );
  return !!row;
}

export async function listPosts(env, user) {
  const rows = await all(
    env,
    `SELECT ${POST_COLUMNS},
      COALESCE((SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id),0) AS like_count,
      COALESCE((SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id),0) AS comment_count,
      COALESCE((SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id=p.id),0) AS share_count,
      CASE WHEN EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=?) THEN 1 ELSE 0 END AS liked_by_me,
      CASE WHEN EXISTS (SELECT 1 FROM saved_posts sp WHERE sp.post_id=p.id AND sp.user_id=?) THEN 1 ELSE 0 END AS saved_by_me
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE u.audience='public' OR p.user_id=? OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=? AND fr.target_id=p.user_id) OR (fr.requester_id=p.user_id AND fr.target_id=?)))
    ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
    user.id,
    user.id,
    user.id,
    user.id,
    user.id
  );
  return json({ posts: rows.map(shapePost) });
}

export async function createPost(env, request, user) {
  const body = await readJson(request);
  let text = String(body.body ?? "").trim();
  const imageData = String(body.imageData ?? "");

  if (!text && !imageData) return json({ error: "Posts must include text or media." }, 400);
  if (isVideoDataUrl(imageData)) return json({ error: UNSUPPORTED_VIDEO_MESSAGE }, 400);
  if (!text && imageData) text = "Shared media";
  if (text.length > 500) return json({ error: "Posts must be between 1 and 500 characters." }, 400);

  let imageKey = "";
  if (imageData) {
    if (imageData.length > 20000000) {
      return json({ error: "Media uploads must be smaller than 20 MB each." }, 400);
    }
    try {
      imageKey = (await storeDataUrl(env, imageData, "posts")) || "";
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }

  const result = await run(
    env,
    "INSERT INTO posts(user_id,body,image_data,audio_data) VALUES(?,?,?,?)",
    user.id,
    text,
    imageKey,
    ""
  );
  const post = await first(
    env,
    `SELECT ${POST_COLUMNS} FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?`,
    result.meta.last_row_id
  );
  return json({ post: shapePost(post) }, 201);
}

export async function deletePost(env, request, user) {
  const body = await readJson(request);
  const postId = parseId(body.postId);
  if (!postId) return json({ error: "Post not found." }, 404);

  const row = await first(
    env,
    "SELECT id,user_id,body,image_data,audio_data FROM posts WHERE id=? LIMIT 1",
    postId
  );
  if (!row) return json({ error: "Post not found." }, 404);
  if (row.user_id !== user.id) return json({ error: "You can only delete your own posts." }, 403);

  const hasIndex = body.photoIndex !== undefined || body.imageIndex !== undefined;
  if (hasIndex) {
    const raw = body.photoIndex !== undefined ? body.photoIndex : body.imageIndex;
    const imageIndex = parseIndex(raw);
    if (imageIndex < 0) return json({ error: "Selected photo not found." }, 400);

    const imageKeys = parseKeyList(row.image_data);
    if (imageIndex >= imageKeys.length) {
      return json({ error: "Selected photo not found." }, 400);
    }

    await deleteKey(env, imageKeys[imageIndex]);
    const remainingImages = imageKeys.filter((_, index) => index !== imageIndex);
    // Audio entries are only index-aligned when the lists have the same
    // length; otherwise removing by index would drop an unrelated track.
    const audioKeys = parseKeyList(row.audio_data);
    const remainingAudio =
      audioKeys.length === imageKeys.length
        ? audioKeys.filter((_, index) => index !== imageIndex)
        : audioKeys;

    if (remainingImages.length === 0 && !String(row.body ?? "").trim()) {
      await run(env, "DELETE FROM posts WHERE id=? AND user_id=?", postId, user.id);
      return json({ deleted: true, postId });
    }

    await run(
      env,
      "UPDATE posts SET image_data=?,audio_data=? WHERE id=?",
      serializeKeyList(remainingImages),
      serializeKeyList(remainingAudio),
      postId
    );

    const updated = await first(
      env,
      `SELECT ${POST_COLUMNS} FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? LIMIT 1`,
      postId
    );
    return json({ post: shapePost(updated) });
  }

  for (const key of parseKeyList(row.image_data)) await deleteKey(env, key);
  for (const key of parseKeyList(row.audio_data)) await deleteKey(env, key);
  await run(env, "DELETE FROM posts WHERE id=? AND user_id=?", postId, user.id);
  return json({ deleted: true, postId });
}

export async function toggleLike(env, user, postId) {
  if (!(await visibility(env, postId, user.id))) {
    return json({ error: "Post not found." }, 404);
  }
  const existing = await first(
    env,
    "SELECT id FROM post_likes WHERE post_id=? AND user_id=? LIMIT 1",
    postId,
    user.id
  );
  let liked = false;
  if (!existing) {
    await run(env, "INSERT INTO post_likes(post_id,user_id) VALUES(?,?)", postId, user.id);
    liked = true;
    const ownerId = await postOwner(env, postId);
    await notifyUser(env, {
      userId: ownerId,
      actorId: user.id,
      type: "like",
      entityType: "post",
      entityId: postId,
      message: `${user.display_name} liked your post.`
    });
  } else {
    await run(env, "DELETE FROM post_likes WHERE post_id=? AND user_id=?", postId, user.id);
  }
  const count = await first(env, "SELECT COUNT(*) AS total FROM post_likes WHERE post_id=?", postId);
  return json({ postId, liked, likeCount: count.total });
}

export async function listComments(env, user, postId) {
  if (!(await visibility(env, postId, user.id))) {
    return json({ error: "Post not found." }, 404);
  }
  const comments = await all(
    env,
    "SELECT pc.id,pc.body,pc.created_at,u.display_name,u.profile_photo FROM post_comments pc JOIN users u ON u.id=pc.user_id WHERE pc.post_id=? ORDER BY pc.created_at ASC,pc.id ASC LIMIT 100",
    postId
  );
  return json({ postId, comments });
}

export async function addComment(env, request, user, postId) {
  if (!(await visibility(env, postId, user.id))) {
    return json({ error: "Post not found." }, 404);
  }
  const body = await readJson(request);
  const text = String(body.body ?? "").trim();
  if (text.length < 1 || text.length > 500) {
    return json({ error: "Comments must be between 1 and 500 characters." }, 400);
  }
  const result = await run(
    env,
    "INSERT INTO post_comments(post_id,user_id,body) VALUES(?,?,?)",
    postId,
    user.id,
    text
  );
  const comment = await first(
    env,
    "SELECT id,post_id,user_id,body,created_at FROM post_comments WHERE id=?",
    result.meta.last_row_id
  );
  const count = await first(env, "SELECT COUNT(*) AS total FROM post_comments WHERE post_id=?", postId);
  const ownerId = await postOwner(env, postId);
  await notifyUser(env, {
    userId: ownerId,
    actorId: user.id,
    type: "comment",
    entityType: "post",
    entityId: postId,
    message: `${user.display_name} commented on your post.`
  });
  return json({ postId, comment, commentCount: count.total }, 201);
}

export async function sharePost(env, user, postId) {
  if (!(await visibility(env, postId, user.id))) {
    return json({ error: "Post not found." }, 404);
  }
  const result = await run(
    env,
    "INSERT INTO post_shares(post_id,user_id) VALUES(?,?)",
    postId,
    user.id
  );
  const share = await first(
    env,
    "SELECT id,post_id,user_id,created_at FROM post_shares WHERE id=?",
    result.meta.last_row_id
  );
  const count = await first(env, "SELECT COUNT(*) AS total FROM post_shares WHERE post_id=?", postId);
  const ownerId = await postOwner(env, postId);
  await notifyUser(env, {
    userId: ownerId,
    actorId: user.id,
    type: "share",
    entityType: "post",
    entityId: postId,
    message: `${user.display_name} shared your post.`
  });
  return json({ postId, share, shareCount: count.total }, 201);
}

export async function listSaved(env, user) {
  const rows = await all(
    env,
    `SELECT ${POST_COLUMNS}
    FROM saved_posts sp
    JOIN posts p ON p.id=sp.post_id
    JOIN users u ON u.id=p.user_id
    WHERE sp.user_id=?
      AND (u.audience='public' OR p.user_id=? OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=? AND fr.target_id=p.user_id) OR (fr.requester_id=p.user_id AND fr.target_id=?))))
    ORDER BY sp.saved_at DESC`,
    user.id,
    user.id,
    user.id,
    user.id
  );
  return json({ posts: rows.map(shapePost) });
}

export async function setSaved(env, request, user) {
  const body = await readJson(request);
  const postId = parseId(body.postId);
  if (!postId) return json({ error: "Post not found." }, 400);
  const saved = !!body.saved;
  if (saved) {
    if (!(await visibility(env, postId, user.id))) {
      return json({ error: "Post not found." }, 404);
    }
    await run(
      env,
      "INSERT OR IGNORE INTO saved_posts(user_id,post_id) VALUES(?,?)",
      user.id,
      postId
    );
  } else {
    await run(env, "DELETE FROM saved_posts WHERE user_id=? AND post_id=?", user.id, postId);
  }
  return json({ postId, saved });
}
