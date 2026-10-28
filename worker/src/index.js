import {
  getCurrentUser,
  parseCookies,
  SESSION_COOKIE_DEFAULT,
} from "./auth.js";
import { json, parseId, BadRequest, setCorsOrigin, corsHeaders } from "./http.js";
import {
  login,
  logout,
  passwordUpdate,
  register,
  settingsGet,
  settingsUpdate,
} from "./routes/auth-routes.js";
import {
  addComment,
  createPost,
  deletePost,
  listComments,
  listPosts,
  listSaved,
  setSaved,
  sharePost,
  toggleLike,
} from "./routes/posts.js";
import {
  createStory,
  deleteStory,
  listStories,
  markStoryViewed,
  storyViewers,
} from "./routes/stories.js";
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
} from "./routes/notifications.js";
import { googleStart, googleCallback } from "./routes/google-auth.js";
import { pushPublicKey, subscribePush, unsubscribePush } from "./routes/push.js";
import { loginVerificationManager } from "./routes/manager-passphrase-auth.js";
import {
  createGroupConversation,
  handleVoiceCall,
  listGroupConversations,
  listGroupMessages,
  mutateMessage,
  sendGroupMessage,
  touchPresence,
} from "./routes/messaging.js";
import {
  lookupVerificationUser,
  setVerificationBadge,
} from "./routes/verification.js";
import {
  acceptFriendRequest,
  createFriendRequest,
  getCommunity,
  listFriends,
  listMessages,
  markMessagesRead,
  searchUsers,
  sendMessage,
  setEventRsvp,
  setGroupMembership,
} from "./routes/social.js";

function notFound() {
  return json({ error: "Not found." }, 404);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    // No Origin header: reject browser-issued cross-site form posts that would
    // otherwise be authenticated by cookies.
      const secFetchSite = request.headers.get("Sec-Fetch-Site");
    return !secFetchSite || secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const allowed = new Set([new URL(request.url).origin]);
  if (env.APP_ORIGIN) allowed.add(String(env.APP_ORIGIN).replace(/\/$/, ""));
  return allowed.has(origin.replace(/\/$/, ""));
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const cookieName = env.SESSION_COOKIE_NAME || SESSION_COOKIE_DEFAULT;

  const origin = request.headers.get("Origin");
  if (origin && sameOrigin(request, env)) setCorsOrigin(origin);

  if (pathname.startsWith("/api/") && method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (pathname.startsWith("/api/") && !SAFE_METHODS.has(method) && !sameOrigin(request, env)) {
    return json({ error: "Cross-origin request rejected." }, 403);
  }

  if (pathname === "/api/health" && method === "GET") {
    return json({ status: "ok" });
  }
  if (pathname === "/api/register" && method === "POST") {
    return register(env, request, cookieName);
  }
  if (pathname === "/api/login" && method === "POST") {
    return login(env, request, cookieName);
  }
  if (pathname === "/api/logout" && method === "POST") {
    const token = parseCookies(request)[cookieName];
    return logout(env, request, cookieName, token);
  }
  if (pathname === "/api/auth/google" && method === "GET") {
    return googleStart(env, request);
  }
  if (pathname === "/api/auth/google/callback" && method === "GET") {
    return googleCallback(env, request);
  }
  if (pathname === "/api/auth/manager-passphrase" && method === "POST") {
    return loginVerificationManager(env, request, cookieName);
  }

  const user = await getCurrentUser(env, request, cookieName);
  if (pathname === "/api/session" && method === "GET") {
    return user
      ? json({ authenticated: true, user })
      : json({ authenticated: false });
  }
  if (!user) return json({ error: "Sign in to continue." }, 401);

  if (pathname === "/api/calls" && (method === "GET" || method === "POST")) {
    return handleVoiceCall(env, request, url, user);
  }
  if (pathname === "/api/message-groups" && method === "GET") {
    return listGroupConversations(env, user);
  }
  if (pathname === "/api/message-groups" && method === "POST") {
    return createGroupConversation(env, request, user);
  }
  if (pathname === "/api/presence" && method === "POST") {
    return touchPresence(env, request, user);
  }
  if (pathname === "/api/push/public-key" && method === "GET") {
    return pushPublicKey(env);
  }
  if (pathname === "/api/push/subscribe" && method === "POST") {
    return subscribePush(env, request, user);
  }
  if (pathname === "/api/push/unsubscribe" && method === "POST") {
    return unsubscribePush(env, request, user);
  }
  const groupMessageMatch = /^\/api\/message-groups\/(\d+)\/messages$/.exec(pathname);
  if (groupMessageMatch) {
    const conversationId = parseId(groupMessageMatch[1]);
    if (!conversationId) return notFound();
    if (method === "GET") return listGroupMessages(env, conversationId, user);
    if (method === "POST") return sendGroupMessage(env, request, conversationId, user);
  }
  const messageActionMatch = /^\/api\/messages\/(\d+)\/actions$/.exec(pathname);
  if (messageActionMatch && method === "POST") {
    const messageId = parseId(messageActionMatch[1]);
    return messageId ? mutateMessage(env, request, messageId, user) : notFound();
  }
  const groupMessageActionMatch =
    /^\/api\/group-messages\/(\d+)\/actions$/.exec(pathname);
  if (groupMessageActionMatch && method === "POST") {
    const messageId = parseId(groupMessageActionMatch[1]);
    return messageId
      ? mutateMessage(env, request, messageId, user, true)
      : notFound();
  }

  if (pathname === "/api/settings" && method === "GET")
    return settingsGet(user);
  if (pathname === "/api/settings" && method === "PUT") {
    return settingsUpdate(env, request, user);
  }
  if (pathname === "/api/password" && method === "PUT") {
    return passwordUpdate(env, request, user, cookieName);
  }
  if (pathname === "/api/verification/users" && method === "GET") {
    return lookupVerificationUser(env, url, user);
  }
  if (pathname === "/api/verification/badge" && method === "POST") {
    return setVerificationBadge(env, request, user);
  }
  if (pathname === "/api/notifications" && method === "GET")
    return listNotifications(env, url, user);
  if (pathname === "/api/notifications/read" && method === "POST") {
    return markNotificationsRead(env, request, user);
  }
  if (pathname === "/api/notifications" && method === "DELETE") {
    return clearNotifications(env, user);
  }
  if (pathname === "/api/friends" && method === "GET")
    return listFriends(env, user);
  if (pathname === "/api/users" && method === "GET")
    return searchUsers(env, url, user);
  if (pathname === "/api/friends/requests" && method === "POST") {
    return createFriendRequest(env, request, user);
  }
  if (pathname === "/api/friends/requests" && method === "PUT") {
    return acceptFriendRequest(env, request, user);
  }
  if (pathname === "/api/community" && method === "GET")
    return getCommunity(env, user);
  if (pathname === "/api/community/groups" && method === "POST") {
    return setGroupMembership(env, request, user);
  }
  if (pathname === "/api/community/events" && method === "POST") {
    return setEventRsvp(env, request, user);
  }
  if (pathname === "/api/messages" && method === "GET")
    return listMessages(env, user, url);
  if (pathname === "/api/messages" && method === "POST") {
    return sendMessage(env, request, user);
  }
  if (pathname === "/api/messages/read" && method === "POST") {
    return markMessagesRead(env, request, user);
  }

  if (pathname === "/api/posts" && method === "GET")
    return listPosts(env, user);
  if (pathname === "/api/posts" && method === "POST") {
    return createPost(env, request, user);
  }
  if (pathname === "/api/posts" && method === "DELETE") {
    return deletePost(env, request, user);
  }
  if (pathname === "/api/saved" && method === "GET")
    return listSaved(env, user);
  if (pathname === "/api/saved" && method === "POST") {
    return setSaved(env, request, user);
  }

  const postMatch = /^\/api\/posts\/(\d+)\/(like|comments|share)$/.exec(
    pathname,
  );
  if (postMatch) {
    const postId = parseId(postMatch[1]);
    if (!postId) return notFound();
    if (postMatch[2] === "like" && method === "POST") {
      return toggleLike(env, user, postId);
    }
    if (postMatch[2] === "comments" && method === "GET") {
      return listComments(env, user, postId);
    }
    if (postMatch[2] === "comments" && method === "POST") {
      return addComment(env, request, user, postId);
    }
    if (postMatch[2] === "share" && method === "POST") {
      return sharePost(env, user, postId);
    }
  }

  if (pathname === "/api/stories" && method === "GET")
    return listStories(env, user);
  if (pathname === "/api/stories" && method === "POST") {
    return createStory(env, request, user);
  }

  const storyMatch = /^\/api\/stories\/(\d+)(?:\/(views|view))?$/.exec(
    pathname,
  );
  if (storyMatch) {
    const storyId = parseId(storyMatch[1]);
    if (!storyId) return notFound();
    if (storyMatch[2] === "views" && method === "GET") {
      return storyViewers(env, user, storyId);
    }
    if (storyMatch[2] === "view" && method === "POST") {
      return markStoryViewed(env, user, storyId);
    }
    if (!storyMatch[2] && method === "DELETE") {
      return deleteStory(env, user, storyId);
    }
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      if (error instanceof BadRequest) {
        return json({ error: error.message }, 400);
      }
      console.error("Worker request failed:", error);
      return json(
        { error: "The server could not complete that request." },
        500,
      );
    }
  },
};
