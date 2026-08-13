// Night Agent Tasks Bot — Enhanced with Google Tools + Smarter Autonomous Thinking
//
// Required environment variables (set these in Railway):
//   TELEGRAM_BOT_TOKEN         (from BotFather)
//   SUPABASE_URL               (Project Settings > API)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings > API > service_role key)
//   NIGHT_AGENT_CHAT_ID        (your personal Telegram chat id)
//   GEMINI_API_KEY             (from AI Studio - single key)
//   GEMINI_API_KEYS            (optional - comma-separated list for rotation)
//   GOOGLE_CLIENT_ID           (from Google Cloud Console)
//   GOOGLE_CLIENT_SECRET       (from Google Cloud Console)
//   GOOGLE_REFRESH_TOKEN       (from OAuth flow - GET THIS CORRECTLY!)
//
// Database tables needed (run in Supabase SQL editor):
//   (see previous migration notes - agent_memories, goals, goal_steps,
//    scheduled_tasks, conversation_log, bot_messages, user_profile,
//    outbox_messages)

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;

// ============================================================
// API KEY ROTATION — supports multiple keys
// ============================================================
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
let keyCursor = 0;
let keyStatusMap = {};

function nextKey() {
  if (API_KEYS.length === 0) return null;
  const k = API_KEYS[keyCursor % API_KEYS.length];
  keyCursor++;
  return k;
}

// ============================================================
// GOOGLE CONFIG
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CONFIGURED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiry = 0;

async function getGoogleAccessToken() {
  if (cachedGoogleAccessToken && Date.now() < cachedGoogleAccessTokenExpiry - 60000) {
    return cachedGoogleAccessToken;
  }
  if (!GOOGLE_CONFIGURED) return null;
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
    if (!data.access_token) {
      console.error("Google token error:", data.error_description || data.error);
      return null;
    }
    cachedGoogleAccessToken = data.access_token;
    cachedGoogleAccessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedGoogleAccessToken;
  } catch (e) {
    console.error("Google token error:", e.message);
    return null;
  }
}

// ============================================================
// GOOGLE TOOLS (NEW)
// ============================================================

// Calendar
async function getCalendarEvents(daysAhead = 7) {
  if (!GOOGLE_CONFIGURED) return { events: [], reason: "Google Calendar not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { events: [], reason: "Google token failed" };
  try {
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
    return { events: [], reason: e.message };
  }
}

// Gmail
async function getGmailSummary(maxResults = 10, query = "is:unread") {
  if (!GOOGLE_CONFIGURED) return { emails: [], reason: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { emails: [], reason: "Google token failed" };
  try {
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
    return { emails: [], reason: e.message };
  }
}

// Docs
async function createGoogleDoc(title, content) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const doc = await res.json();
    if (doc.error) throw new Error(doc.error.message);
    if (content) {
      await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ insertText: { text: content, location: { index: 1 } } }]
        })
      });
    }
    console.log(`📄 Created Google Doc: ${title}`);
    return { docId: doc.documentId, link: `https://docs.google.com/document/d/${doc.documentId}` };
  } catch (e) {
    return { error: e.message };
  }
}

// Sheets
async function createGoogleSheet(title) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { spreadsheetId: data.spreadsheetId, link: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}` };
  } catch (e) {
    return { error: e.message };
  }
}

async function appendToSheet(spreadsheetId, values) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1:append?valueInputOption=RAW`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [values] }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { updated: true };
  } catch (e) {
    return { error: e.message };
  }
}

// Drive
async function searchDrive(query) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,createdTime)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { files: data.files || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// YouTube
async function searchYouTube(query, maxResults = 5) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&maxResults=${maxResults}&type=video`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { videos: data.items || [] };
  } catch (e) {
    return { error: e.message };
  }
}

async function getYouTubeStats(channelId) {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { statistics: data.items?.[0]?.statistics || {} };
  } catch (e) {
    return { error: e.message };
  }
}

// Contacts
async function listContacts() {
  if (!GOOGLE_CONFIGURED) return { error: "Google not connected" };
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return { error: "Google token failed" };
  try {
    const res = await fetch(
      "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { contacts: data.connections || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// GEMINI HELPERS
// ============================================================
const GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const GEMINI_EMBEDDING_MODEL = "text-embedding-004";
const TIMEZONE = "Asia/Colombo";

function nowInTimezone() {
  const now = new Date();
  const readable = now.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const isoWithOffset = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+05:30`;
  return { iso: isoWithOffset, readable, timezone: TIMEZONE };
}

async function fetchGeminiRotating(urlBuilder, options) {
  const attempts = Math.max(API_KEYS.length, 1);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    if (!key) throw new Error("No Gemini API key configured");
    try {
      const res = await fetch(urlBuilder(key), options);
      const data = await res.json();
      if (res.status === 429) {
        console.error(`⚠️ Key ...${key.slice(-4)} rate-limited, rotating`);
        lastErr = new Error("Rate limited");
        continue;
      }
      if (!res.ok && res.status >= 500) {
        console.error(`⚠️ Key ...${key.slice(-4)} server error ${res.status}, rotating`);
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

// ============================================================
// SUPABASE HELPERS
// ============================================================
async function fetchRecentMemories(limit = 20) {
  const { data } = await supabase
    .from("agent_memories")
    .select("content, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse().map((r) => r.content);
}

async function getUserProfile() {
  const { data } = await supabase.from("user_profile").select("summary").eq("id", 1).maybeSingle();
  return data?.summary || "";
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
  if (!data.embedding?.values) throw new Error(data.error?.message || "no embedding");
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

async function updateGoalStatus(goalId, status) {
  const { error } = await supabase.from("goals").update({ status }).eq("id", goalId);
  return { updated: !error, reason: error ? error.message : null };
}

async function scheduleResearch(topic, runAt, recurrence) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ topic, run_at: runAt, status: "pending", recurrence: recurrence || "once", kind: "research" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: runAt };
}

async function scheduleReminder(message, runAt, recurrence) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ message, run_at: runAt, status: "pending", recurrence: recurrence || "once", kind: "reminder" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: runAt };
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

async function logBotMessage(role, content) {
  if (!content) return;
  try {
    await supabase.from("bot_messages").insert({ role, content });
  } catch (e) {}
}

// ============================================================
// STEP CHECK-IN (unchanged)
// ============================================================
const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

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
// OUTBOX + SCHEDULED TASKS
// ============================================================
setInterval(checkOutbox, 15000);
setInterval(checkScheduledResearch, 60000);

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
      await bot.sendMessage(CHAT_ID, `⚠️ Scheduled task failed: ${e.message}`);
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
        contents: [{ role: "user", parts: [{ text: `Research this topic using web search and write a short briefing (4-6 sentences, no markdown): ${topic}` }] }],
        tools: [{ googleSearch: {} }],
      }),
    }
  );
  if (data.error) throw new Error(data.error.message);
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p.text).map((p) => p.text).join(" ").trim() || "Couldn't find anything.";
}

function computeNextRun(currentRunAt, recurrence) {
  const d = new Date(currentRunAt);
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  return d.toISOString();
}

// ============================================================
// KEY STATUS VERIFICATION (NEW)
// ============================================================
async function verifyAllKeys() {
  if (API_KEYS.length === 0) return;
  const results = {};
  for (const key of API_KEYS) {
    const short = key.slice(-4);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        { signal: AbortSignal.timeout(5000) }
      );
      results[short] = {
        status: res.status,
        ok: res.ok,
        quota: res.status === 429 ? "RATE_LIMITED" : res.ok ? "OK" : "ERROR"
      };
    } catch (e) {
      results[short] = { status: "ERROR", error: e.message };
    }
  }
  keyStatusMap = results;
  const ok = Object.values(results).filter(r => r.ok).length;
  console.log(`🔑 Key status: ${ok}/${API_KEYS.length} OK`, results);
  return results;
}

setInterval(verifyAllKeys, 60 * 60 * 1000);
verifyAllKeys();

// ============================================================
// CHAT SYSTEM INSTRUCTION (UPDATED with all tools)
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, a highly competent
professional personal assistant the user talks to through Telegram (as well
as a separate voice app). Address the user the way a sharp, professional
personal assistant addresses their employer: respectful, efficient, and
direct — never like a casual friend. Do NOT use slang, buddy-style address,
or casual filler words under any circumstances. If writing in Sinhala, use
the respectful/formal register. Reply briefly — 2-4 short sentences, no
markdown, no lists, no headers.

You have these tools available:
- save_memory: save a fact about the user
- get_current_datetime: get current date/time
- create_task_list: break a goal into ordered steps
- recall_memories: fetch all saved facts
- search_memories: find facts relevant to a topic
- list_active_goals: show current goals
- update_goal_status: mark a goal as done/cancelled
- schedule_research: schedule web research at a future time
- schedule_reminder: schedule a plain message reminder
- web_search: search the web for current information
- get_calendar_events: fetch upcoming Google Calendar events
- get_gmail_summary: fetch email summary
- create_google_doc: create a new Google Doc
- create_google_sheet: create a new Google Sheet
- append_to_sheet: add a row to an existing Google Sheet
- search_drive: search Google Drive for files
- search_youtube: search YouTube for videos
- list_contacts: list Google Contacts
- get_youtube_stats: get channel statistics

If a tool result comes back with an error, either retry with corrected
arguments or clearly tell the user what went wrong.`;

const CHAT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "save_memory",
        description: "Save a short fact about the user for future sessions.",
        parameters: { type: "OBJECT", properties: { content: { type: "STRING" } }, required: ["content"] },
      },
      {
        name: "get_current_datetime",
        description: "Get the current date, day of week, and time.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "create_task_list",
        description: "Save a goal broken into ordered steps.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            steps: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["title", "steps"],
        },
      },
      {
        name: "recall_memories",
        description: "Fetch and read back the facts saved about the user.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "search_memories",
        description: "Find saved facts relevant to a specific topic.",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
      },
      {
        name: "list_active_goals",
        description: "Fetch the user's currently active goals.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "update_goal_status",
        description: "Mark a goal as done or cancelled.",
        parameters: {
          type: "OBJECT",
          properties: {
            goal_id: { type: "NUMBER" },
            status: { type: "STRING", enum: ["done", "cancelled", "active"] },
          },
          required: ["goal_id", "status"],
        },
      },
      {
        name: "schedule_research",
        description: "Schedule a research task for a specific future time.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            run_at: { type: "STRING", description: "ISO 8601 with offset (e.g. 2026-08-12T06:00:00+05:30)" },
            recurrence: { type: "STRING", enum: ["once", "daily", "weekly"] },
          },
          required: ["topic", "run_at"],
        },
      },
      {
        name: "schedule_reminder",
        description: "Schedule a plain message reminder at a future time.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: { type: "STRING" },
            run_at: { type: "STRING", description: "ISO 8601 with offset" },
            recurrence: { type: "STRING", enum: ["once", "daily", "weekly"] },
          },
          required: ["message", "run_at"],
        },
      },
      {
        name: "web_search",
        description: "Search the web for current, real-time information.",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
      },
      {
        name: "get_calendar_events",
        description: "Fetch upcoming Google Calendar events.",
        parameters: { type: "OBJECT", properties: { days_ahead: { type: "NUMBER" } } },
      },
      {
        name: "get_gmail_summary",
        description: "Fetch a summary of recent or unread emails.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING" },
            max_results: { type: "NUMBER" },
          },
        },
      },
      {
        name: "create_google_doc",
        description: "Create a new Google Doc.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            content: { type: "STRING" },
          },
          required: ["title"],
        },
      },
      {
        name: "create_google_sheet",
        description: "Create a new Google Sheet.",
        parameters: {
          type: "OBJECT",
          properties: { title: { type: "STRING" } },
          required: ["title"],
        },
      },
      {
        name: "append_to_sheet",
        description: "Append a row to an existing Google Sheet.",
        parameters: {
          type: "OBJECT",
          properties: {
            spreadsheet_id: { type: "STRING" },
            values: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["spreadsheet_id", "values"],
        },
      },
      {
        name: "search_drive",
        description: "Search Google Drive for files.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING" } },
          required: ["query"],
        },
      },
      {
        name: "search_youtube",
        description: "Search YouTube for videos.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING" },
            max_results: { type: "NUMBER" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_youtube_stats",
        description: "Get statistics for a YouTube channel.",
        parameters: {
          type: "OBJECT",
          properties: { channel_id: { type: "STRING" } },
          required: ["channel_id"],
        },
      },
      {
        name: "list_contacts",
        description: "List the user's Google Contacts.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

function buildSystemInstruction(memories, profile) {
  let instr = BASE_SYSTEM_INSTRUCTION;
  if (profile) {
    instr += `\n\nWhat you've learned about the user over time:\n${profile}`;
  }
  if (memories.length > 0) {
    instr += `\n\nSpecific saved facts:\n- ` + memories.join("\n- ");
  }
  return instr;
}

async function fetchRecentConversation(limit = 16) {
  const { data } = await supabase
    .from("bot_messages")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

async function executeFunctionCall(fc) {
  switch(fc.name) {
    case "save_memory": return await saveMemory(fc.args?.content || "");
    case "create_task_list": return await createTaskList(fc.args?.title || "Untitled", fc.args?.steps || []);
    case "recall_memories": return await recallMemories();
    case "search_memories": return await searchMemoriesSemantic(fc.args?.query || "");
    case "list_active_goals": return await listActiveGoals();
    case "update_goal_status": return await updateGoalStatus(fc.args?.goal_id, fc.args?.status);
    case "schedule_research": return await scheduleResearch(fc.args?.topic || "", fc.args?.run_at || "", fc.args?.recurrence);
    case "schedule_reminder": return await scheduleReminder(fc.args?.message || "", fc.args?.run_at || "", fc.args?.recurrence);
    case "web_search": return await webSearch(fc.args?.query || "");
    case "get_calendar_events": return await getCalendarEvents(fc.args?.days_ahead || 7);
    case "get_gmail_summary": return await getGmailSummary(fc.args?.max_results || 10, fc.args?.query || "is:unread");
    case "create_google_doc": return await createGoogleDoc(fc.args?.title, fc.args?.content);
    case "create_google_sheet": return await createGoogleSheet(fc.args?.title);
    case "append_to_sheet": return await appendToSheet(fc.args?.spreadsheet_id, fc.args?.values);
    case "search_drive": return await searchDrive(fc.args?.query);
    case "search_youtube": return await searchYouTube(fc.args?.query, fc.args?.max_results);
    case "get_youtube_stats": return await getYouTubeStats(fc.args?.channel_id);
    case "list_contacts": return await listContacts();
    case "get_current_datetime": return nowInTimezone();
    default: return { error: "unknown tool" };
  }
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

async function handleChatMessage(userText) {
  if (API_KEYS.length === 0) {
    return "⚠️ GEMINI_API_KEY is not set in Railway variables.";
  }
  const memories = await fetchRecentMemories();
  const profile = await getUserProfile();
  const systemInstruction = buildSystemInstruction(memories, profile);

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
      console.error("handleChatMessage callGemini failed:", e.message);
      return "⚠️ I couldn't reach Gemini right now — try again in a moment.";
    }

    if (data.error) {
      return `⚠️ Gemini error: ${data.error.message || JSON.stringify(data.error)}`;
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

    if (functionCalls.length === 0) {
      if (textReply) return textReply;
      return `⚠️ No response from Gemini: ${JSON.stringify(data).slice(0, 500)}`;
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
      responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return "Sorry, something went wrong on my end.";
}

// ============================================================
// AUTONOMOUS THINKING (ENHANCED — runs every 10 minutes)
// ============================================================
const AUTONOMOUS_SYSTEM_INSTRUCTION = `You are Night Agent's autonomous
background process, running every ~10 minutes. You are highly proactive and
observant. You have access to ALL the same tools as the chat interface.

Good reasons to act (be MORE proactive than before):
- A goal has been sitting for >2 hours with no progress → gentle nudge
- Calendar event in <2 hours → remind and offer to prep
- Unread important emails → summarize and ask if action needed
- User mentioned a topic of interest → research it and report findings
- Daily briefing opportunity → morning routine check
- Inconsistent facts in memory → flag and ask for clarification

NEVER send emails autonomously. Everything else is fair game.

After taking actions, if you did something significant, send a short message:
"🌙 [brief update on what you did/found]"

If nothing to do, reply EXACTLY: "NOTHING"`;

setInterval(enhancedAutonomousTick, 10 * 60 * 1000);

async function enhancedAutonomousTick() {
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

Active goals (each has an id):
${goals.length ? JSON.stringify(goals) : "none"}

Calendar events in the next 3 days:
${calendarEvents.length ? JSON.stringify(calendarEvents) : "none / not connected"}

Recent conversation (most recent last):
${(recentMsgs || []).reverse().map((m) => `${m.role}: ${m.content}`).join("\n") || "none"}

Decide if you should act now.`;

    let contents = [{ role: "user", parts: [{ text: contextText }] }];

    for (let i = 0; i < 4; i++) {
      let data;
      try {
        data = await callGemini(contents, AUTONOMOUS_SYSTEM_INSTRUCTION);
      } catch (e) {
        console.error("autonomousTick callGemini failed:", e.message);
        return;
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
// USER PROFILE UPDATE (every 30 min)
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

    if (!recentMsgs || recentMsgs.length < 6) return;

    const transcript = recentMsgs.reverse().map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = `You maintain an evolving profile of the user.

Current profile:
${currentProfile || "(none yet)"}

Recent conversation:
${transcript}

Write an UPDATED profile — a few short paragraphs covering: interests,
personality, communication style, current focus, notable life context.
Revise and consolidate, dropping anything outdated. Under 200 words.`;

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

// ============================================================
// PASSIVE MEMORY EXTRACTION (every 10 min)
// ============================================================
setInterval(extractMemoriesFromRecent, 10 * 60 * 1000);

async function extractMemoriesFromRecent() {
  if (API_KEYS.length === 0) return;
  const { data: unprocessed } = await supabase
    .from("bot_messages")
    .select("*")
    .eq("extracted", false)
    .order("created_at", { ascending: true })
    .limit(40);

  if (!unprocessed || unprocessed.length < 4) return;

  const transcript = unprocessed.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = `Read this conversation and list any facts worth remembering
long-term about the user. Write each as a short third-person sentence.
Reply with ONLY a JSON array of strings. If nothing, reply with: []

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
// TELEGRAM COMMANDS
// ============================================================

// OAuth Status Command
bot.onText(/\/oauthstatus/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  
  let status = `🔑 OAuth Status:\n`;
  status += `Google configured: ${GOOGLE_CONFIGURED ? '✅' : '❌'}\n`;
  status += `API Keys: ${API_KEYS.length} keys loaded\n`;
  
  if (GOOGLE_CONFIGURED) {
    try {
      const token = await getGoogleAccessToken();
      status += `Access token: ${token ? '✅ obtained' : '❌ failed'}\n`;
      if (token) {
        status += `Token expiry: ${new Date(cachedGoogleAccessTokenExpiry).toLocaleString()}\n`;
        const cal = await getCalendarEvents(1);
        status += `Calendar test: ${cal.events ? `✅ ${cal.events.length} events` : '❌'}\n`;
        const gmail = await getGmailSummary(3);
        status += `Gmail test: ${gmail.emails ? `✅ ${gmail.emails.length} emails` : '❌'}\n`;
      }
    } catch (e) {
      status += `❌ Error: ${e.message}\n`;
    }
  }
  
  // Key status
  status += `\n🔑 Key Status:\n`;
  for (const [short, info] of Object.entries(keyStatusMap)) {
    const icon = info.ok ? '🟢' : '🔴';
    status += `${icon} ...${short}: ${info.quota || info.status}\n`;
  }
  
  await bot.sendMessage(CHAT_ID, status);
});

// Key Status Command
bot.onText(/\/keystatus/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  const results = await verifyAllKeys();
  let text = `🔑 API Key Status:\n`;
  for (const [short, info] of Object.entries(results)) {
    const icon = info.ok ? '🟢' : '🔴';
    text += `${icon} ...${short}: ${info.quota || info.status}\n`;
  }
  text += `\nTotal: ${Object.values(results).filter(r => r.ok).length}/${API_KEYS.length} OK`;
  await bot.sendMessage(CHAT_ID, text);
});

// ============================================================
// MESSAGE ROUTER
// ============================================================
bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return; // commands handled above
  
  const text = msg.text.trim();
  const lower = text.toLowerCase();
  logBotMessage("user", text);

  // Check if it's a step reply
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

  // Regular chat
  bot.sendChatAction(CHAT_ID, "typing");
  const reply = await handleChatMessage(text);
  await bot.sendMessage(CHAT_ID, reply);
  logBotMessage("agent", reply);
});

// ============================================================
// ERROR HANDLING
// ============================================================
process.on("unhandledRejection", async (reason) => {
  console.error("⚠️ Unhandled rejection:", reason);
  try {
    await bot.sendMessage(CHAT_ID, `⚠️ Background error: ${String(reason).slice(0, 300)}`);
  } catch (e) {}
});

process.on("uncaughtException", async (err) => {
  console.error("⚠️ Uncaught exception:", err);
  try {
    await bot.sendMessage(CHAT_ID, `⚠️ Bot crashed: ${err.message}`);
  } catch (e) {}
  setTimeout(() => process.exit(1), 1500);
});

console.log("🌙 Night Agent Tasks Bot started.");
console.log(`🔑 ${API_KEYS.length} API keys loaded.`);
console.log(`📊 Google configured: ${GOOGLE_CONFIGURED}`);
console.log(`⏰ Autonomous thinking runs every 10 minutes.`);