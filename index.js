// Night Agent Tasks Bot — standalone project
//
// Two things happen in this bot:
// 1. Step-by-step goal check-ins (unchanged from before) — when a goal_step
//    is awaiting_approval and you reply "ok"/"skip".
// 2. NEW: general text chat — any other message you send gets a real
//    reply from Gemini, using the same memory (agent_memories) and the
//    same tools (save_memory, create_task_list) as the orb app. So you can
//    now talk to Night Agent directly through Telegram, not just the orb.
//
// Required environment variables (set these in Railway, never in code):
//   TELEGRAM_BOT_TOKEN         (from BotFather)
//   SUPABASE_URL               (Project Settings > API)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings > API > service_role key)
//   NIGHT_AGENT_CHAT_ID        (your personal Telegram chat id)
//   GEMINI_API_KEY             (same key as the orb app, from AI Studio)
//   GEMINI_API_KEYS            (optional — comma-separated list of keys to
//                               rotate through automatically when one hits
//                               its quota, e.g. "keyA,keyB,keyC")
//
// NEW — schedule_reminder needs two extra columns on scheduled_tasks (this
// table already existed for schedule_research). Run this once in the
// Supabase SQL editor:
//
//   alter table scheduled_tasks add column if not exists kind text not null default 'research';
//   alter table scheduled_tasks add column if not exists message text;
//
// NEW tools added: web_search (live search during chat/autonomous review),
// schedule_reminder (plain timed message, no research), create_calendar_event
// (write access — needs a Google refresh token with calendar write scope,
// not just calendar.readonly).

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ============================================================
// Multi-key rotation — set GEMINI_API_KEYS as a comma-separated list of
// 2+ keys (e.g. from different Google accounts/AI Studio projects) to
// multiply your effective free-tier rate limit. Falls back to the single
// GEMINI_API_KEY above if GEMINI_API_KEYS isn't set.
// ============================================================
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
let keyCursor = 0;
function nextKey() {
  if (API_KEYS.length === 0) return null;
  const k = API_KEYS[keyCursor % API_KEYS.length];
  const maskedKey = k.slice(-4);
  console.log(`🔑 Using Gemini key index ${keyCursor % API_KEYS.length} (****${maskedKey})`);
  keyCursor++;
  return k;
}

// ============================================================
// Google Calendar (read-only)
// Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// in Railway. If any are missing, calendar tools quietly report themselves
// as unavailable instead of erroring.
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CONFIGURED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiry = 0;

async function getGoogleAccessToken() {
  if (!GOOGLE_CONFIGURED) {
    throw new Error('Google OAuth credentials missing - check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }

  if (cachedGoogleAccessToken && Date.now() < cachedGoogleAccessTokenExpiry - 60000) {
    return cachedGoogleAccessToken;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    
    const data = await res.json();
    
    // Enhanced error logging
    if (data.error) {
      console.error('❌ Google OAuth Error Details:', JSON.stringify(data, null, 2));
      let errorMsg = `Google API error: ${data.error}`;
      if (data.error_description) {
        errorMsg += ` - ${data.error_description}`;
      }
      // Common root causes
      if (data.error === 'invalid_grant') {
        errorMsg += ' (Possible causes: refresh token expired, revoked, or generated with different client credentials)';
      } else if (data.error === 'invalid_client') {
        errorMsg += ' (Client ID or secret doesn\'t match the refresh token)';
      }
      throw new Error(errorMsg);
    }
    
    if (!data.access_token) {
      throw new Error('No access_token in Google response - check client credentials');
    }
    
    cachedGoogleAccessToken = data.access_token;
    cachedGoogleAccessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('✅ Google token refreshed successfully');
    return cachedGoogleAccessToken;
  } catch (error) {
    console.error('❌ Google token refresh failed:', error.message);
    throw error;
  }
}

// ============================================================
// NEW GOOGLE API TOOLS
// ============================================================

async function getDriveFiles(maxResults = 10, query = "") {
  if (!GOOGLE_CONFIGURED) return { files: [], reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const q = query || "mimeType != 'application/vnd.google-apps.folder'";
    const url = `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime desc`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return {
      files: (data.files || []).map(f => ({
        name: f.name,
        type: f.mimeType,
        lastModified: f.modifiedTime,
        link: f.webViewLink
      }))
    };
  } catch (e) {
    console.error("getDriveFiles error:", e.message);
    return { files: [], reason: e.message };
  }
}

async function getSheetData(spreadsheetId, range) {
  if (!GOOGLE_CONFIGURED) return { values: [], reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return {
      values: data.values || [],
      range: data.range,
      rows: data.values?.length || 0,
      cols: data.values?.[0]?.length || 0
    };
  } catch (e) {
    console.error("getSheetData error:", e.message);
    return { values: [], reason: e.message };
  }
}

async function getDocContent(documentId) {
  if (!GOOGLE_CONFIGURED) return { content: "", reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const url = `https://docs.googleapis.com/v1/documents/${documentId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    
    // Extract text content from document structure
    let content = "";
    if (data.body?.content) {
      for (const element of data.body.content) {
        if (element.paragraph?.elements) {
          for (const elem of element.paragraph.elements) {
            if (elem.textRun?.content) {
              content += elem.textRun.content;
            }
          }
        }
      }
    }
    return {
      title: data.title,
      content: content.trim(),
      revisionId: data.revisionId
    };
  } catch (e) {
    console.error("getDocContent error:", e.message);
    return { content: "", reason: e.message };
  }
}

async function getContacts(query = "", maxResults = 10) {
  if (!GOOGLE_CONFIGURED) return { contacts: [], reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const params = new URLSearchParams({
      personFields: 'names,emailAddresses,phoneNumbers',
      pageSize: maxResults,
      ...(query && { query })
    });
    const url = `https://people.googleapis.com/v1/people/me/connections?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return {
      contacts: (data.connections || []).map(c => ({
        name: c.names?.[0]?.displayName || 'No name',
        emails: c.emailAddresses?.map(e => e.value) || [],
        phones: c.phoneNumbers?.map(p => p.value) || []
      }))
    };
  } catch (e) {
    console.error("getContacts error:", e.message);
    return { contacts: [], reason: e.message };
  }
}

async function getYouTubeAnalytics(channelId = null) {
  if (!GOOGLE_CONFIGURED) return { stats: {}, reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    
    // First get channel info
    let channelUrl = 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true';
    if (channelId) {
      channelUrl = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}`;
    }
    const channelRes = await fetch(channelUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const channelData = await channelRes.json();
    if (channelData.error) throw new Error(channelData.error.message);
    
    const channel = channelData.items?.[0];
    if (!channel) throw new Error('YouTube channel not found');
    
    // Get analytics for last 30 days
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
    const endDate = today.toISOString().split('T')[0];
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    const analyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3D${channel.id}&startDate=${startDate}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,subscribersGained,likes,comments&dimensions=day`;
    const analyticsRes = await fetch(analyticsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const analyticsData = await analyticsRes.json();
    if (analyticsData.error) throw new Error(analyticsData.error.message);
    
    // Get recent videos
    const videosUrl = `https://youtube.googleapis.com/youtube/v3/search?channelId=${channel.id}&part=snippet&order=date&maxResults=5`;
    const videosRes = await fetch(videosUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const videosData = await videosRes.json();
    
    return {
      channel: {
        id: channel.id,
        title: channel.snippet.title,
        subscribers: parseInt(channel.statistics.subscriberCount),
        views: parseInt(channel.statistics.viewCount),
        videos: parseInt(channel.statistics.videoCount)
      },
      analytics: {
        period: { startDate, endDate },
        totals: analyticsData.rows ? analyticsData.rows.reduce((acc, row) => ({
          views: (acc.views || 0) + (row[1] || 0),
          minutesWatched: (acc.minutesWatched || 0) + (row[2] || 0),
          subscribersGained: (acc.subscribersGained || 0) + (row[3] || 0),
          likes: (acc.likes || 0) + (row[4] || 0),
          comments: (acc.comments || 0) + (row[5] || 0)
        }), {}) : null
      },
      recentVideos: (videosData.items || []).map(v => ({
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbnail: v.snippet.thumbnails?.default?.url
      }))
    };
  } catch (e) {
    console.error("getYouTubeAnalytics error:", e.message);
    return { stats: {}, reason: e.message };
  }
}

// ============================================================
// Original Google API functions
// ============================================================

async function getCalendarEvents(daysAhead = 7) {
  if (!GOOGLE_CONFIGURED) return { events: [], reason: "Google Calendar not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=20`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const events = (data.items || []).map((ev) => ({
      title: ev.summary || "(no title)",
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      location: ev.location || null,
    }));
    return { events };
  } catch (e) {
    console.error("getCalendarEvents error:", e.message);
    return { events: [], reason: e.message };
  }
}

async function getGmailSummary(maxResults = 10, query = "is:unread") {
  if (!GOOGLE_CONFIGURED) return { emails: [], reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();
    if (listData.error) throw new Error(listData.error.message);
    const messages = listData.messages || [];
    const emails = [];
    for (const m of messages) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || "";
      emails.push({ from: get("From"), subject: get("Subject"), date: get("Date"), snippet: msgData.snippet || "" });
    }
    return { emails };
  } catch (e) {
    console.error("getGmailSummary error:", e.message);
    return { emails: [], reason: e.message };
  }
}

function base64UrlEncode(str) {
  return Buffer.from(str, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendGmail(to, subject, body) {
  if (!GOOGLE_CONFIGURED) return { sent: false, reason: "Google not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const rawMessage = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n");
    const raw = base64UrlEncode(rawMessage);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { sent: true, id: data.id };
  } catch (e) {
    console.error("sendGmail error:", e.message);
    return { sent: false, reason: e.message };
  }
}

// Tries each configured key in turn. On a 429 (rate limited) it moves to
// the next key immediately (no wait — a different key has its own quota).
// On a 5xx it also rotates+retries. Only throws once every key has failed.
async function fetchGeminiRotating(urlBuilder, options) {
  const attempts = Math.max(API_KEYS.length, 1);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    if (!key) throw new Error("No Gemini API key configured (set GEMINI_API_KEY or GEMINI_API_KEYS)");
    try {
      const res = await fetch(urlBuilder(key), options);
      const data = await res.json();
      if (res.status === 429) {
        console.error(`⚠️ Key index ${keyCursor - 1} (****${key.slice(-4)}) rate-limited (429), rotating to next key`);
        lastErr = new Error("All available keys are rate limited right now");
        continue;
      }
      if (!res.ok && res.status >= 500) {
        console.error(`⚠️ Key index ${keyCursor - 1} (****${key.slice(-4)}) server error ${res.status}, rotating`);
        lastErr = new Error(data.error?.message || `HTTP ${res.status}`);
        continue;
      }
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Gemini API keys failed");
}

// Confirm this matches a text-capable Gemini model on your AI Studio account.
const GEMINI_TEXT_MODEL = "gemini-2.0-flash-exp"; // Updated to latest
const GEMINI_EMBEDDING_MODEL = "text-embedding-004";
const TIMEZONE = "Asia/Colombo"; // fixed regardless of the server's own timezone

function nowInTimezone() {
  const now = new Date();
  const readable = now.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  // build an ISO string that carries the Colombo offset explicitly, so it's
  // unambiguous no matter what timezone Postgres/Node/Railway default to
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const isoWithOffset = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+05:30`;
  return { iso: isoWithOffset, readable, timezone: TIMEZONE };
}

const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

// ============================================================
// PART 0 — self-correction / error recovery helpers
// ============================================================
async function withRetry(fn, { retries = 2, delayMs = 800, label = "operation" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ ${label} failed (attempt ${attempt + 1}/${retries + 1}): ${e.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Catch anything that slips past local try/catch so the bot never dies
// silently. Railway restarts the container anyway on exit, but we notify
// first so you know something crashed instead of just going quiet.
process.on("unhandledRejection", async (reason) => {
  console.error("⚠️ Unhandled rejection:", reason);
  try { await bot.sendMessage(CHAT_ID, `⚠️ Background error (recovered): ${String(reason).slice(0, 300)}`); } catch (e) {}
});
process.on("uncaughtException", async (err) => {
  console.error("⚠️ Uncaught exception:", err);
  try { await bot.sendMessage(CHAT_ID, `⚠️ Bot crashed and is restarting: ${err.message}`); } catch (e) {}
  setTimeout(() => process.exit(1), 1500); // let the message send, then let Railway restart us
});

console.log("Night Agent Tasks Bot started.");

// ============================================================
// PART 1 — step-by-step goal check-ins (unchanged behavior)
// ============================================================
setInterval(checkAndSendNextStep, 30000);
checkAndSendNextStep();

async function checkAndSendNextStep() {
  const { data: alreadyWaiting } = await supabase
    .from("goal_steps")
    .select("id")
    .eq("status", "awaiting_approval")
    .limit(1)
    .maybeSingle();
  if (alreadyWaiting) return;

  const { data: nextStep } = await supabase
    .from("goal_steps")
    .select("*, goals!inner(status, title)")
    .eq("status", "pending")
    .eq("goals.status", "active")
    .order("goal_id", { ascending: true })
    .order("step_number", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextStep) return;

  await supabase.from("goal_steps").update({ status: "awaiting_approval" }).eq("id", nextStep.id);
  await bot.sendMessage(
    CHAT_ID,
    `🌙 "${nextStep.goals.title}" — step ${nextStep.step_number}:\n${nextStep.description}\n\nReply "ok" when done, or "skip" to skip this step.`
  );
}

async function maybeCompleteGoal(goalId, title) {
  const { data: remaining } = await supabase
    .from("goal_steps")
    .select("id")
    .eq("goal_id", goalId)
    .eq("status", "pending");

  if (remaining && remaining.length === 0) {
    await supabase.from("goals").update({ status: "done" }).eq("id", goalId);
    await bot.sendMessage(CHAT_ID, `🎉 All steps done for "${title}"!`);
  }
}

// ============================================================
// PART 1b — scheduled research tasks
// ============================================================
setInterval(checkScheduledResearch, 60000);

// ============================================================
// PART 1c — outbox (lets the voice orb app relay a message here,
// since it can't hold the Telegram bot token itself)
// ============================================================
setInterval(checkOutbox, 15000);

async function checkOutbox() {
  const { data: pending } = await supabase
    .from("outbox_messages")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  if (!pending || pending.length === 0) return;

  for (const msg of pending) {
    try {
      await bot.sendMessage(CHAT_ID, msg.content);
      await logBotMessage("agent", msg.content);
      await supabase.from("outbox_messages").update({ status: "sent" }).eq("id", msg.id);
    } catch (e) {
      console.error("checkOutbox send failed:", e.message);
    }
  }
}
checkScheduledResearch();

async function checkScheduledResearch() {
  const nowIso = new Date().toISOString();
  const { data: dueTasks } = await supabase
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", nowIso)
    .order("run_at", { ascending: true })
    .limit(3);

  if (!dueTasks || dueTasks.length === 0) return;

  for (const task of dueTasks) {
    // claim it immediately so a second tick can't pick it up too
    await supabase.from("scheduled_tasks").update({ status: "running" }).eq("id", task.id);
    try {
      const isReminder = task.kind === "reminder";
      const result = isReminder ? task.message : await runResearch(task.topic);
      if (task.recurrence && task.recurrence !== "once") {
        const nextRun = computeNextRun(task.run_at, task.recurrence);
        await supabase.from("scheduled_tasks").update({ status: "pending", run_at: nextRun, result }).eq("id", task.id);
      } else {
        await supabase.from("scheduled_tasks").update({ status: "done", result }).eq("id", task.id);
      }
      const icon = isReminder ? "⏰" : "🔎";
      await bot.sendMessage(CHAT_ID, `${icon} ${result}`);
    } catch (e) {
      await supabase.from("scheduled_tasks").update({ status: "failed" }).eq("id", task.id);
      await bot.sendMessage(CHAT_ID, `⚠️ Scheduled task "${task.topic || task.message}" failed: ${e.message}`);
    }
  }
}

async function runResearch(topic) {
  const data = await fetchGeminiRotating(
    (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Research this topic using web search and write a short, spoken-style briefing (4-6 sentences, no markdown, no headers, no bullet points) summarizing the most useful current findings: ${topic}`,
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
      }),
    }
  );
  if (data.error) throw new Error(data.error.message || "Gemini research call failed");
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
  return text || "Couldn't find anything useful.";
}

// ============================================================
// PART 2 — general text chat with Gemini (NEW)
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, a highly competent
professional personal assistant the user talks to through Telegram (as well
as a separate voice app). Address the user the way a sharp, professional
personal assistant addresses their employer: respectful, efficient, and
direct — never like a casual friend. Do NOT use slang, buddy-style address,
or casual filler words (no "bro", "dude", "මචන්", "බන්", "යාළුවා", "ගගා", or
similar) under any circumstances. If writing in Sinhala, use the
respectful/formal register (e.g. address the user as "ඔබතුමා" or "සර්", not
the casual "ඔයා") — natural, polished Sinhala, not textbook-stiff. Reply
briefly — 2-4 short sentences, no markdown, no lists, no headers. If the
user writes in Sinhala, reply in respectful Sinhala; otherwise reply in the
same language they used, keeping the same formal register.

You have twenty tools available:
- save_memory: call this whenever the user tells you something worth
  remembering (a preference, a recurring task, a fact about their life).
  Keep saved facts short, third person (e.g. "User sleeps around 12:30am").
- get_current_datetime: call this whenever you need today's date or time,
  including before computing a future run_at time for schedule_research.
- create_task_list: call this when the user gives you a goal or list of
  things they want tracked. Break it into short ordered steps. After
  calling it, tell the user you'll check in step-by-step right here on
  Telegram — don't say you'll do the steps yourself right now.
- schedule_research: call this when the user asks you to look something up
  or research something at a specific future time, once or repeating (e.g.
  "at 9am tomorrow" = once, "every morning at 6" = daily). Compute the
  exact first run_at time. Tell the user you'll send findings here on
  Telegram at that time — don't do the research yourself right now.
- recall_memories: call this whenever the user asks what you know about
  them in general, or what's saved — never guess, always call this tool.
- search_memories: call this instead of recall_memories when the user asks
  about a specific topic (e.g. "what do you know about my exams") — it
  finds the most relevant saved facts for that topic, not just the newest.
- list_active_goals: call this whenever the user asks about their current
  tasks, goals, or what's pending — never guess, always call this tool.
- update_goal_status: call this to mark a goal as "done" or "cancelled"
  when the user says it's finished or no longer relevant, or when you
  (during autonomous review) decide a stale goal should be closed.
- get_calendar_events: call this whenever the user asks what's on their
  calendar, schedule, or upcoming events — never guess, always call this
  tool. If it reports Calendar isn't connected yet, tell the user that.
- get_gmail_summary: call this whenever the user asks about their email,
  inbox, or unread messages — never guess, always call this tool.
- send_gmail: call this ONLY when the user has explicitly asked you to
  send a specific email in THIS conversation and you're confident of the
  recipient, subject, and content — read it back to confirm if there's any
  ambiguity before sending. NEVER call this during autonomous background
  review (only in direct response to the user asking, in the moment).
- web_search: call this whenever the user asks something that needs
  current, real-time information you wouldn't reliably know (news, prices,
  scores, "what's going on with X", fact-checking something recent). Also
  usable during autonomous review when something worth checking comes up.
- schedule_reminder: call this when the user wants a plain message
  delivered to them at a specific future time, once or repeating (e.g.
  "remind me to call the plumber at 5pm", "ping me every morning at 7").
  Unlike schedule_research, this does no research — it just delivers the
  exact message you give it, at that time. Compute run_at using
  get_current_datetime first, same as schedule_research.
- create_calendar_event: call this when the user asks you to add something
  to their calendar. If it reports the calendar isn't writable, tell the
  user clearly (their Google connection may only be authorized for
  read access) rather than pretending it worked.
- get_drive_files: call this when the user asks about files in their Google
  Drive, recent documents, or anything stored in Drive.
- get_sheet_data: call this when the user asks for data from a specific
  Google Sheet. They need to provide the spreadsheet ID and range.
- get_doc_content: call this when the user wants to read the content of a
  specific Google Doc by its ID.
- get_contacts: call this when the user asks for contact information from
  their Google Contacts (names, emails, phone numbers).
- get_youtube_channel_analytics: call this when the user asks about their
  YouTube channel performance, views, subscribers, or recent video stats.

If a tool result comes back with an error field, don't just give up or go
silent — read the error, and either retry with corrected arguments (e.g.
a differently formatted date) or clearly tell the user what went wrong and
what you'd need to try again.`;

const CHAT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "save_memory",
        description: "Save a short fact about the user for future sessions.",
        parameters: {
          type: "OBJECT",
          properties: { content: { type: "STRING", description: "The fact to remember." } },
          required: ["content"],
        },
      },
      {
        name: "get_current_datetime",
        description: "Get the current date, day of week, and time.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "create_task_list",
        description: "Save a goal broken into ordered steps, confirmed one at a time on Telegram.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Short title for the goal." },
            steps: { type: "ARRAY", items: { type: "STRING" }, description: "Ordered list of short steps." },
          },
          required: ["title", "steps"],
        },
      },
      {
        name: "schedule_research",
        description:
          "Schedule a research task for a specific future time, once or repeating. At that time, the agent will search the web on the given topic and send the findings on Telegram automatically — no confirmation needed.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING", description: "What to research." },
            run_at: {
              type: "STRING",
              description:
                "The exact first time to run this, as an ISO 8601 datetime WITH the timezone offset always included (e.g. 2026-08-12T06:00:00+05:30 for 6am Sri Lanka time). Never omit the offset. Compute this from the user's request and the current date/time (use get_current_datetime first — it returns time in Asia/Colombo).",
            },
            recurrence: {
              type: "STRING",
              description: "One of: once, daily, weekly. Defaults to once if not specified.",
            },
          },
          required: ["topic", "run_at"],
        },
      },
      {
        name: "recall_memories",
        description: "Fetch and read back the most recent facts currently saved about the user.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "search_memories",
        description: "Find the saved facts most relevant to a specific topic or question.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "The topic to search saved memories for." } },
          required: ["query"],
        },
      },
      {
        name: "list_active_goals",
        description: "Fetch the user's currently active goals/task lists and each step's status.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "update_goal_status",
        description: "Mark a goal as done or cancelled.",
        parameters: {
          type: "OBJECT",
          properties: {
            goal_id: { type: "NUMBER", description: "The id of the goal to update." },
            status: { type: "STRING", description: "One of: done, cancelled, active." },
          },
          required: ["goal_id", "status"],
        },
      },
      {
        name: "get_calendar_events",
        description: "Fetch the user's upcoming Google Calendar events.",
        parameters: {
          type: "OBJECT",
          properties: {
            days_ahead: { type: "NUMBER", description: "How many days ahead to look. Defaults to 7." },
          },
        },
      },
      {
        name: "get_gmail_summary",
        description: "Fetch a summary of the user's recent or unread emails.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Gmail search query, e.g. 'is:unread' or 'is:important'. Defaults to is:unread." },
            max_results: { type: "NUMBER", description: "Max emails to fetch. Defaults to 10." },
          },
        },
      },
      {
        name: "send_gmail",
        description: "Send an email on the user's behalf. Only use when the user has clearly asked for this specific email to be sent.",
        parameters: {
          type: "OBJECT",
          properties: {
            to: { type: "STRING", description: "Recipient email address." },
            subject: { type: "STRING", description: "Email subject." },
            body: { type: "STRING", description: "Email body text." },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "web_search",
        description: "Search the web for current, real-time information not reliably known otherwise (news, prices, scores, recent events, fact-checks).",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "What to search for." } },
          required: ["query"],
        },
      },
      {
        name: "schedule_reminder",
        description: "Schedule a plain message to be delivered automatically at a specific future time, once or repeating. Does no research — just delivers the exact message given.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: { type: "STRING", description: "The exact message to send at that time." },
            run_at: {
              type: "STRING",
              description:
                "The exact first time to send this, as an ISO 8601 datetime WITH the timezone offset always included (e.g. 2026-08-12T17:00:00+05:30 for 5pm Sri Lanka time). Compute using get_current_datetime first.",
            },
            recurrence: { type: "STRING", description: "One of: once, daily, weekly. Defaults to once." },
          },
          required: ["message", "run_at"],
        },
      },
      {
        name: "create_calendar_event",
        description: "Add a new event to the user's Google Calendar.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Event title." },
            start: { type: "STRING", description: "Start time, ISO 8601 with timezone offset (e.g. 2026-08-12T17:00:00+05:30)." },
            end: { type: "STRING", description: "End time, ISO 8601 with timezone offset. If omitted, defaults to 1 hour after start." },
            description: { type: "STRING", description: "Optional event description/notes." },
          },
          required: ["title", "start"],
        },
      },
      {
        name: "get_drive_files",
        description: "List recent or searched files from Google Drive.",
        parameters: {
          type: "OBJECT",
          properties: {
            max_results: { type: "NUMBER", description: "Max files to return. Defaults to 10." },
            query: { type: "STRING", description: "Optional search query (e.g., 'name contains \"project\"')." },
          },
        },
      },
      {
        name: "get_sheet_data",
        description: "Read data from a specific Google Sheet range.",
        parameters: {
          type: "OBJECT",
          properties: {
            spreadsheet_id: { type: "STRING", description: "The ID of the spreadsheet." },
            range: { type: "STRING", description: "Range in A1 notation (e.g., 'Sheet1!A1:C10')." },
          },
          required: ["spreadsheet_id", "range"],
        },
      },
      {
        name: "get_doc_content",
        description: "Read the text content of a Google Doc by its ID.",
        parameters: {
          type: "OBJECT",
          properties: {
            document_id: { type: "STRING", description: "The ID of the document." },
          },
          required: ["document_id"],
        },
      },
      {
        name: "get_contacts",
        description: "Search or list contacts from Google Contacts.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Optional search query (name or email)." },
            max_results: { type: "NUMBER", description: "Max contacts to return. Defaults to 10." },
          },
        },
      },
      {
        name: "get_youtube_channel_analytics",
        description: "Get YouTube channel analytics including views, subscribers, and recent video performance.",
        parameters: {
          type: "OBJECT",
          properties: {
            channel_id: { type: "STRING", description: "Optional channel ID (defaults to authenticated channel)." },
          },
        },
      },
    ],
  },
];

async function fetchRecentMemories(limit = 20) {
  const { data } = await supabase
    .from("agent_memories")
    .select("content, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse().map((r) => r.content);
}

function buildSystemInstruction(memories, profile) {
  let instr = BASE_SYSTEM_INSTRUCTION;
  if (profile) {
    instr += `\n\nWhat you've learned about the user over time (an evolving picture — use this to engage naturally, don't just recite it):\n${profile}`;
  }
  if (memories.length > 0) {
    instr += `\n\nSpecific saved facts:\n- ` + memories.join("\n- ");
  }
  return instr;
}

async function getUserProfile() {
  const { data } = await supabase.from("user_profile").select("summary").eq("id", 1).maybeSingle();
  return data?.summary || "";
}

// ============================================================
// PART 4b — evolving user profile
// Every 30 min: read recent conversation + the current profile, and ask
// Gemini to produce a REVISED profile (not just appended) — a compact,
// evolving picture of who the user is, updated as things change.
// ============================================================
setInterval(updateUserProfileFromRecent, 30 * 60 * 1000);

async function updateUserProfileFromRecent() {
  if (API_KEYS.length === 0) return;
  try {
    const currentProfile = await getUserProfile();
    const { data: recentMsgs } = await supabase
      .from("bot_messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(40);

    if (!recentMsgs || recentMsgs.length < 6) return; // not enough new material yet

    const transcript = recentMsgs.reverse().map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = `You maintain an evolving profile of the user, built from
everything they've said over time, so you can engage with them more
naturally and personally in future conversations.

Current profile (may be empty if this is the first update):
${currentProfile || "(none yet)"}

Recent conversation to incorporate:
${transcript}

Write an UPDATED profile — a few short paragraphs covering: their interests
and personality, how they like to communicate, what they're currently
focused on or working towards, and anything notable about their situation.
Don't just append to the old profile — revise and consolidate it, dropping
anything now outdated or contradicted. Keep it under 200 words, plain prose,
third person, no markdown.`;

    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      }
    );
    const newProfile = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (newProfile) {
      await supabase.from("user_profile").upsert({ id: 1, summary: newProfile, updated_at: new Date().toISOString() });
      console.log("📇 Updated user profile.");
    }
  } catch (e) {
    console.error("updateUserProfileFromRecent error:", e.message);
  }
}

async function saveMemory(content) {
  const embedding = await getEmbedding(content).catch(() => null);
  const { error } = await supabase.from("agent_memories").insert({ content, embedding });
  return { saved: !error };
}

async function getEmbedding(text) {
  const data = await fetchGeminiRotating(
    (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    }
  );
  if (!data.embedding?.values) throw new Error(data.error?.message || "no embedding returned");
  return data.embedding.values;
}

async function searchMemoriesSemantic(query) {
  const embedding = await getEmbedding(query).catch(() => null);
  if (!embedding) return { memories: [], reason: "embedding failed" };
  const { data, error } = await supabase.rpc("match_memories", { query_embedding: embedding, match_count: 10 });
  if (error) return { memories: [], reason: error.message };
  return { memories: (data || []).map((r) => r.content) };
}

async function createTaskList(title, steps) {
  const { data: goal, error: goalErr } = await supabase.from("goals").insert({ title }).select().single();
  if (goalErr) return { created: false, reason: goalErr.message };
  const rows = steps.map((description, i) => ({ goal_id: goal.id, step_number: i + 1, description }));
  const { error: stepsErr } = await supabase.from("goal_steps").insert(rows);
  return { created: !stepsErr, goal_id: goal.id, steps_count: steps.length };
}

async function scheduleResearch(topic, runAt, recurrence) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ topic, run_at: runAt, status: "pending", recurrence: recurrence || "once", kind: "research" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: runAt, recurrence: recurrence || "once" };
}

async function scheduleReminder(message, runAt, recurrence) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ message, run_at: runAt, status: "pending", recurrence: recurrence || "once", kind: "reminder" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: runAt, recurrence: recurrence || "once" };
}

async function webSearch(query) {
  try {
    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Search the web and answer concisely (2-4 sentences, no markdown): ${query}` }] }],
          tools: [{ googleSearch: {} }],
        }),
      }
    );
    if (data.error) return { result: null, reason: data.error.message };
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
    return { result: text || "No useful results found." };
  } catch (e) {
    return { result: null, reason: e.message };
  }
}

async function createCalendarEvent(title, start, end, description) {
  if (!GOOGLE_CONFIGURED) return { created: false, reason: "Google Calendar not connected yet" };
  try {
    const accessToken = await getGoogleAccessToken();
    const endTime = end || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: title,
        description: description || undefined,
        start: { dateTime: start },
        end: { dateTime: endTime },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { created: true, id: data.id, link: data.htmlLink };
  } catch (e) {
    console.error("createCalendarEvent error:", e.message);
    return { created: false, reason: e.message };
  }
}

function computeNextRun(currentRunAt, recurrence) {
  const d = new Date(currentRunAt);
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  return d.toISOString();
}

async function updateGoalStatus(goalId, status) {
  const { error } = await supabase.from("goals").update({ status }).eq("id", goalId);
  return { updated: !error, reason: error ? error.message : null };
}

async function recallMemories() {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("content, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { memories: [], reason: error.message };
  return { memories: (data || []).map((r) => r.content) };
}

async function listActiveGoals() {
  const { data: goals, error } = await supabase
    .from("goals")
    .select("id, title, status, goal_steps(step_number, description, status)")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return { goals: [], reason: error.message };
  const shaped = (goals || []).map((g) => ({
    title: g.title,
    steps: (g.goal_steps || [])
      .sort((a, b) => a.step_number - b.step_number)
      .map((s) => ({ description: s.description, status: s.status })),
  }));
  return { goals: shaped };
}

async function executeFunctionCall(fc) {
  if (fc.name === "save_memory") return await saveMemory(fc.args?.content || "");
  if (fc.name === "create_task_list") return await createTaskList(fc.args?.title || "Untitled goal", fc.args?.steps || []);
  if (fc.name === "schedule_research") return await scheduleResearch(fc.args?.topic || "", fc.args?.run_at || "", fc.args?.recurrence);
  if (fc.name === "recall_memories") return await recallMemories();
  if (fc.name === "search_memories") return await searchMemoriesSemantic(fc.args?.query || "");
  if (fc.name === "list_active_goals") return await listActiveGoals();
  if (fc.name === "update_goal_status") return await updateGoalStatus(fc.args?.goal_id, fc.args?.status);
  if (fc.name === "get_calendar_events") return await getCalendarEvents(fc.args?.days_ahead || 7);
  if (fc.name === "get_gmail_summary") return await getGmailSummary(fc.args?.max_results || 10, fc.args?.query || "is:unread");
  if (fc.name === "send_gmail") return await sendGmail(fc.args?.to, fc.args?.subject, fc.args?.body);
  if (fc.name === "web_search") return await webSearch(fc.args?.query || "");
  if (fc.name === "schedule_reminder") return await scheduleReminder(fc.args?.message || "", fc.args?.run_at || "", fc.args?.recurrence);
  if (fc.name === "create_calendar_event") return await createCalendarEvent(fc.args?.title || "Untitled event", fc.args?.start, fc.args?.end, fc.args?.description);
  if (fc.name === "get_drive_files") return await getDriveFiles(fc.args?.max_results || 10, fc.args?.query || "");
  if (fc.name === "get_sheet_data") return await getSheetData(fc.args?.spreadsheet_id, fc.args?.range);
  if (fc.name === "get_doc_content") return await getDocContent(fc.args?.document_id);
  if (fc.name === "get_contacts") return await getContacts(fc.args?.query || "", fc.args?.max_results || 10);
  if (fc.name === "get_youtube_channel_analytics") return await getYouTubeAnalytics(fc.args?.channel_id || null);
  if (fc.name === "get_current_datetime") {
    return nowInTimezone();
  }
  return { error: "unknown tool" };
}

async function callGemini(contents, systemInstruction) {
  const data = await fetchGeminiRotating(
    (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: CHAT_TOOLS,
      }),
    }
  );
  if (data.error) console.error("Gemini API error:", JSON.stringify(data));
  return data;
}

async function fetchRecentConversation(limit = 16) {
  const { data } = await supabase
    .from("bot_messages")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

async function handleChatMessage(userText) {
  if (API_KEYS.length === 0) {
    return "⚠️ Debug: GEMINI_API_KEY is not set in Railway variables.";
  }
  const memories = await fetchRecentMemories();
  const profile = await getUserProfile();
  const systemInstruction = buildSystemInstruction(memories, profile);

  // bring in the last several turns of actual conversation so follow-up
  // questions ("what about the second one?") work like a real chat.
  // (the current userText was already logged to bot_messages by the
  // caller before this ran, so drop that trailing duplicate here)
  const history = await fetchRecentConversation();
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.role === "user" && last.content === userText) history.pop();
  }
  let contents = history.map((m) => ({
    role: m.role === "agent" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });

  for (let i = 0; i < 5; i++) {
    let data;
    try {
      data = await callGemini(contents, systemInstruction);
    } catch (e) {
      console.error("handleChatMessage callGemini failed after retries:", e.message);
      return "⚠️ I couldn't reach Gemini right now (network issue) — try again in a moment.";
    }

    if (data.error) {
      return `⚠️ Debug — Gemini error: ${data.error.message || JSON.stringify(data.error)}`;
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

    if (functionCalls.length === 0) {
      if (textReply) return textReply;
      return `⚠️ Debug — no text or function call in response: ${JSON.stringify(data).slice(0, 500)}`;
    }

    contents.push({ role: "model", parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      let result;
      try {
        result = await executeFunctionCall(fc);
      } catch (e) {
        // feed the failure back to the model instead of crashing —
        // it can see what went wrong and try a different approach
        result = { error: true, message: e.message };
      }
      responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return "Sorry, something went wrong on my end.";
}

// ============================================================
// PART 3 — logging every message (needed for both loops below)
// ============================================================
async function logBotMessage(role, content) {
  if (!content) return;
  try {
    await supabase.from("bot_messages").insert({ role, content });
  } catch (e) {}
}

// ============================================================
// PART 4 — passive memory extraction (UPDATED: every 5 min)
// Every 5 min: read unprocessed messages, ask Gemini what's worth
// remembering long-term, save it, mark those messages as processed.
// Catches things the live chat model didn't think to save_memory on.
// ============================================================
setInterval(extractMemoriesFromRecent, 5 * 60 * 1000);

async function extractMemoriesFromRecent() {
  if (API_KEYS.length === 0) return;
  const { data: unprocessed } = await supabase
    .from("bot_messages")
    .select("*")
    .eq("extracted", false)
    .order("created_at", { ascending: true })
    .limit(40);

  if (!unprocessed || unprocessed.length < 4) return; // not enough new context yet

  const transcript = unprocessed.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = `Read this conversation and list any facts worth remembering
long-term about the user (preferences, recurring habits, life context,
upcoming deadlines). Write each as a short third-person sentence. Reply with
ONLY a JSON array of strings, nothing else. If nothing is worth saving,
reply with exactly: []

Conversation:
${transcript}`;

  try {
    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      }
    );
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let facts = [];
    try { facts = JSON.parse(cleaned); } catch (e) { facts = []; }

    for (const fact of facts) {
      await saveMemory(fact);
    }
    if (facts.length > 0) {
      console.log(`Extracted ${facts.length} memories from background scan.`);
    }
  } catch (e) {
    console.error("extractMemoriesFromRecent error:", e.message);
  }

  const ids = unprocessed.map((m) => m.id);
  await supabase.from("bot_messages").update({ extracted: true }).in("id", ids);
}

// ============================================================
// PART 5 — autonomous thinking loop (UPDATED: every 5 min)
// Every 5 min: look at memories + active goals + recent chat + the
// current time, and decide whether to proactively do or say something.
// Most ticks should do nothing — this is deliberately conservative.
// ============================================================
const AUTONOMOUS_SYSTEM_INSTRUCTION = `You are Night Agent's autonomous
background process, running silently every ~5 minutes even when the user
isn't actively chatting. Decide if there's anything worth proactively doing
right now, based on the context you're given. You may take several actions
in a row this tick if needed (e.g. update_goal_status on a stale goal, then
save_memory noting why) — call tools as many times as genuinely useful, then
stop.

CRITICAL: Before taking ANY action, check if you've already sent a similar
message in the last 2 hours. Check the recent conversation below. If you
already nudged about the same thing recently, do NOT repeat it.

Good reasons to act:
- A goal step has been sitting pending or awaiting_approval for a long time
  (many hours) — a gentle nudge is fine.
- A goal looks abandoned/stale (no progress in days) — consider marking it
  cancelled with update_goal_status instead of nagging forever.
- A known fact implies something time-sensitive is coming up soon and no
  task exists for it yet — consider schedule_reminder for a simple nudge, or
  create_task_list if it needs multiple steps.
- A calendar event is coming up soon (next few hours) and it seems worth a
  heads-up, especially if it needs prep the user hasn't mentioned doing.
- The user asked you to check on or remind them about something and enough
  time has clearly passed.
- The user recently mentioned a genuine, specific interest or open question
  worth following up on (a topic, a decision they're weighing, something
  they said they'd look into). Use web_search or schedule_research (with
  run_at set to right now via get_current_datetime) to look into it and
  report back. Phrase the finding as a concise, useful briefing — direct and
  professional, not chatty. Don't do this for every passing mention — only
  genuine open threads, and never research the same thing twice (check
  recent conversation and memories first).

NEVER call send_gmail during this autonomous review — sending email is only
ever done in direct response to the user explicitly asking, in the moment.

Be conservative — most ticks, there is nothing worth doing. When you are
completely done acting for this tick (including if you decided to do
nothing), your FINAL reply must be exactly: NOTHING — unless you want to
send the user a message right now, in which case your final reply is that
short, professional message instead (2-3 sentences, no markdown).`;

setInterval(autonomousTick, 5 * 60 * 1000);

async function autonomousTick() {
  if (API_KEYS.length === 0) return;
  try {
    const memories = await fetchRecentMemories();
    const profile = await getUserProfile();
    const { goals } = await listActiveGoals();
    const { events: calendarEvents } = GOOGLE_CONFIGURED ? await getCalendarEvents(3) : { events: [] };
    const { data: recentMsgs } = await supabase
      .from("bot_messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(15);

    const contextText = `Current time: ${nowInTimezone().readable} (${TIMEZONE})

User profile: ${profile || "none yet"}

Known facts:
${memories.length ? memories.map((m) => `- ${m}`).join("\n") : "none"}

Active goals (each has an id you can pass to update_goal_status):
${goals.length ? JSON.stringify(goals) : "none"}

Calendar events in the next 3 days:
${calendarEvents.length ? JSON.stringify(calendarEvents) : "none / not connected"}

Recent conversation (most recent last):
${(recentMsgs || []).reverse().map((m) => `${m.role}: ${m.content}`).join("\n") || "none"}

Decide if you should act now.`;

    let contents = [{ role: "user", parts: [{ text: contextText }] }];

    // chained loop — the agent can take several actions in one tick
    for (let i = 0; i < 4; i++) {
      let data;
      try {
        data = await callGemini(contents, AUTONOMOUS_SYSTEM_INSTRUCTION);
      } catch (e) {
        console.error("autonomousTick callGemini failed after retries:", e.message);
        return; // stay silent this tick, try again next tick
      }
      if (data.error) { console.error("autonomousTick Gemini error:", data.error.message); return; }

      const parts = data.candidates?.[0]?.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const text = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

      if (functionCalls.length === 0) {
        if (text && text.toUpperCase() !== "NOTHING") {
          await bot.sendMessage(CHAT_ID, `🌙 ${text}`);
          await logBotMessage("agent", text);
        }
        return;
      }

      contents.push({ role: "model", parts });
      const responseParts = [];
      for (const fc of functionCalls) {
        let result;
        try {
          result = await executeFunctionCall(fc);
        } catch (e) {
          result = { error: true, message: e.message };
        }
        console.log("Autonomous tool call:", fc.name, JSON.stringify(result));
        responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }
  } catch (e) {
    console.error("autonomousTick error:", e.message);
  }
}

// ============================================================
// message router — decides: is this a step reply, or general chat?
// ============================================================
bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  if (!msg.text) return; // voice/files not handled yet
  const text = msg.text.trim();
  const lower = text.toLowerCase();
  logBotMessage("user", text);

  const { data: waiting } = await supabase
    .from("goal_steps")
    .select("*, goals!inner(title)")
    .eq("status", "awaiting_approval")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (waiting && YES_WORDS.includes(lower)) {
    await supabase.from("goal_steps").update({ status: "done" }).eq("id", waiting.id);
    await maybeCompleteGoal(waiting.goal_id, waiting.goals.title);
    await bot.sendMessage(CHAT_ID, `✅ Done: ${waiting.description}`);
    logBotMessage("agent", `Done: ${waiting.description}`);
    checkAndSendNextStep();
    return;
  }
  if (waiting && SKIP_WORDS.includes(lower)) {
    await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", waiting.id);
    await bot.sendMessage(CHAT_ID, `⏭️ Skipped: ${waiting.description}`);
    logBotMessage("agent", `Skipped: ${waiting.description}`);
    checkAndSendNextStep();
    return;
  }

  // not a step reply — treat as general conversation
  bot.sendChatAction(CHAT_ID, "typing");
  const reply = await handleChatMessage(text);
  await bot.sendMessage(CHAT_ID, reply);
  logBotMessage("agent", reply);
});
