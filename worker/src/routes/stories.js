import { all, first, run } from "../db.js";
import { json, readJson, parseId } from "../http.js";
import {
  storeDataUrl,
  exposeKeyList,
  isVideoDataUrl,
  UNSUPPORTED_VIDEO_MESSAGE
} from "../media.js";

const VISIBLE_STORY_CLAUSE = `(s.user_id=? OR u.audience='public' OR EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status='accepted' AND ((fr.requester_id=? AND fr.target_id=s.user_id) OR (fr.requester_id=s.user_id AND fr.target_id=?))))`;

function shapeStory(row) {
  if (!row) return row;
  return {
    ...row,
    media_data: exposeKeyList(row.media_data),
    audio_data: exposeKeyList(row.audio_data)
  };
}

export async function listStories(env, user) {
  const rows = await all(
    env,
    `SELECT s.id,s.user_id,u.display_name,u.profile_photo,s.media_data,s.audio_data,s.caption,s.created_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',s.created_at,'+24 hours') AS expires_at,
      CASE WHEN s.user_id=? THEN (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id=s.id) ELSE 0 END AS seen_count,
      EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=?) AS viewed_by_me
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND ${VISIBLE_STORY_CLAUSE}
    ORDER BY s.created_at DESC LIMIT 50`,
    user.id,
    user.id,
    user.id,
    user.id,
    user.id
  );
  return json({ stories: rows.map(shapeStory) });
}

export async function createStory(env, request, user) {
  const body = await readJson(request);
  let mediaData = String(body.mediaData ?? "");
  if (!mediaData && body.imageData) mediaData = String(body.imageData);
  if (!mediaData) return json({ error: "A story needs a photo." }, 400);
  if (isVideoDataUrl(mediaData)) return json({ error: UNSUPPORTED_VIDEO_MESSAGE }, 400);

  const caption = String(body.caption ?? "").trim();
  if (caption.length > 200) {
    return json({ error: "Story captions must be under 200 characters." }, 400);
  }

  let mediaKey;
  try {
    mediaKey = storeDataUrl(mediaData);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!mediaKey) return json({ error: "A story needs a photo." }, 400);

  const result = await run(
    env,
    "INSERT INTO stories(user_id,media_data,audio_data,caption) VALUES(?,?,?,?)",
    user.id,
    mediaKey,
    "",
    caption
  );
  const story = await first(
    env,
    "SELECT id,user_id,media_data,audio_data,caption,created_at FROM stories WHERE id=?",
    result.meta.last_row_id
  );
  return json(
    {
      story: {
        ...shapeStory(story),
        display_name: user.display_name,
        profile_photo: user.profile_photo
      }
    },
    201
  );
}

export async function storyViewers(env, user, storyId) {
  const owned = await first(
    env,
    "SELECT id FROM stories WHERE id=? AND user_id=? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') LIMIT 1",
    storyId,
    user.id
  );
  if (!owned) return json({ error: "Story not found." }, 404);
  const viewers = await all(
    env,
    "SELECT u.id,u.display_name,u.profile_photo,sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=? ORDER BY sv.viewed_at DESC",
    storyId
  );
  return json({ viewers });
}

export async function markStoryViewed(env, user, storyId) {
  const visible = await first(
    env,
    `SELECT s.id,s.user_id FROM stories s JOIN users u ON u.id=s.user_id
     WHERE s.id=? AND s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND ${VISIBLE_STORY_CLAUSE} LIMIT 1`,
    storyId,
    user.id,
    user.id,
    user.id
  );
  if (!visible) return json({ error: "Story not found." }, 404);

  const isOwn = visible.user_id === user.id;
  if (!isOwn) {
    await run(
      env,
      "INSERT OR IGNORE INTO story_views(story_id,viewer_id) VALUES(?,?)",
      storyId,
      user.id
    );
  }
  const count = await first(env, "SELECT COUNT(*) AS total FROM story_views WHERE story_id=?", storyId);
  return json({ storyId, seenCount: count.total, viewedByMe: !isOwn });
}

export async function deleteStory(env, user, storyId) {
  const row = await first(
    env,
    "SELECT id,user_id,media_data,audio_data FROM stories WHERE id=? LIMIT 1",
    storyId
  );
  if (!row) return json({ error: "Story not found." }, 404);
  if (row.user_id !== user.id) return json({ error: "You can only delete your own stories." }, 403);
  
  
  await run(env, "DELETE FROM stories WHERE id=? AND user_id=?", storyId, user.id);
  return json({ deleted: true, storyId });
}

export { parseId };
