// Night Agent Tasks Bot — standalone project
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ============================================================
// ERROR HANDLING — catch everything so bot doesn't crash
// ============================================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM signal');
  if (bot) {
    try { bot.stopPolling(); } catch(e) {}
  }
  process.exit(0);
});

// ============================================================
// CONFIGURATION
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CHAT_ID) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

let bot;
try {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  });
} catch (error) {
  console.error('❌ Failed to initialize bot:', error);
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// GEMINI API KEYS ROTATION
// ============================================================
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

if (API_KEYS.length === 0) {
  console.error('❌ No Gemini API keys configured!');
  process.exit(1);
}

console.log(`✅ Loaded ${API_KEYS.length} Gemini API keys`);

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
// GOOGLE OAUTH
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CONFIGURED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiry = 0;

async function getGoogleAccessToken() {
  if (!GOOGLE_CONFIGURED) {
    throw new Error('Google OAuth credentials missing');
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
    
    if (data.error) {
      console.error('❌ Google OAuth Error:', JSON.stringify(data, null, 2));
      let errorMsg = `Google API error: ${data.error}`;
      if (data.error_description) {
        errorMsg += ` - ${data.error_description}`;
      }
      throw new Error(errorMsg);
    }
    
    if (!data.access_token) {
      throw new Error('No access_token in response');
    }
    
    cachedGoogleAccessToken = data.access_token;
    cachedGoogleAccessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('✅ Google token refreshed');
    return cachedGoogleAccessToken;
  } catch (error) {
    console.error('❌ Google token refresh failed:', error.message);
    throw error;
  }
}

// ============================================================
// GOOGLE API TOOLS
// ============================================================
async function getDriveFiles(maxResults = 10, query = "") {
  if (!GOOGLE_CONFIGURED) return { files: [], reason: "Google not connected" };
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
  if (!GOOGLE_CONFIGURED) return { values: [], reason: "Google not connected" };
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
  if (!GOOGLE_CONFIGURED) return { content: "", reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const url = `https://docs.googleapis.com/v1/documents/${documentId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    
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
  if (!GOOGLE_CONFIGURED) return { contacts: [], reason: "Google not connected" };
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
  if (!GOOGLE_CONFIGURED) return { stats: {}, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    
    let channelUrl = 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true';
    if (channelId) {
      channelUrl = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}`;
    }
    const channelRes = await fetch(channelUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const channelData = await channelRes.json();
    if (channelData.error) throw new Error(channelData.error.message);
    
    const channel = channelData.items?.[0];
    if (!channel) throw new Error('YouTube channel not found');
    
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
    const endDate = today.toISOString().split('T')[0];
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    const analyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3D${channel.id}&startDate=${startDate}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,subscribersGained,likes,comments&dimensions=day`;
    const analyticsRes = await fetch(analyticsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const analyticsData = await analyticsRes.json();
    if (analyticsData.error) throw new Error(analyticsData.error.message);
    
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

async function getCalendarEvents(daysAhead = 7) {
  if (!GOOGLE_CONFIGURED) return { events: [], reason: "Google Calendar not connected" };
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
  if (!GOOGLE_CONFIGURED) return { emails: [], reason: "Google not connected" };
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
  if (!GOOGLE_CONFIGURED) return { sent: false, reason: "Google not connected" };
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

// ============================================================
// GEMINI HELPER FUNCTIONS
// ============================================================
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
        console.error(`⚠️ Key index ${keyCursor - 1} (****${key.slice(-4)}) rate-limited`);
        lastErr = new Error("Rate limited");
        continue;
      }
      if (!res.ok && res.status >= 500) {
        console.error(`⚠️ Key index ${keyCursor - 1} (****${key.slice(-4)}) server error ${res.status}`);
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

// Confirmed current model — gemini-1.5-flash and gemini-2.5-flash are both
// retired; don't let a future edit "fix" this back to an older name.
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash";
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

// ============================================================
// SYSTEM INSTRUCTION AND TOOLS
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, a calm, warm assistant
who talks to the user like a close friend who's always there for them —
not a formal professional assistant. Casual, warm tone is fine (including
Sinhala colloquial address like "ඔයා", "බන්" if the user uses that register
with you). Reply briefly — 2-4 short sentences, no markdown, no lists, no
headers. If the user writes in Sinhala, reply in natural, casual Sinhala;
otherwise reply in the same language and register they used.

You have these tools:
- save_memory: Save facts about the user
- get_current_datetime: Get current date/time
- create_task_list: Create a goal with steps
- schedule_research: Schedule web research at a future time
- recall_memories: Get recent saved facts
- search_memories: Search for specific facts (semantic — finds the most
  relevant facts for a topic, not just the newest)
- list_active_goals: Show current goals
- update_goal_status: Mark goal as done/cancelled
- get_calendar_events: Check Google Calendar
- get_gmail_summary: Check Gmail
- send_gmail: Send email (ONLY when user explicitly asks, in this
  conversation, never during autonomous background review)
- web_search: Search the web for current info
- schedule_reminder: Schedule a reminder message
- create_calendar_event: Add event to calendar
- get_drive_files: List files from Google Drive
- get_sheet_data: Read Google Sheet data
- get_doc_content: Read Google Doc content
- get_contacts: Search Google Contacts
- get_youtube_channel_analytics: Check YouTube stats

If a tool errors, don't go silent — tell the user clearly what went wrong,
or retry with corrected arguments if that's likely to fix it.`;

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
        description: "Save a goal broken into ordered steps.",
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
        description: "Schedule a research task for a specific future time.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING", description: "What to research." },
            run_at: { type: "STRING", description: "ISO 8601 datetime with timezone offset." },
            recurrence: { type: "STRING", description: "One of: once, daily, weekly. Defaults to once." },
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
        description: "Find saved facts most relevant to a specific topic.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "The topic to search for." } },
          required: ["query"],
        },
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
            query: { type: "STRING", description: "Gmail search query. Defaults to 'is:unread'." },
            max_results: { type: "NUMBER", description: "Max emails to fetch. Defaults to 10." },
          },
        },
      },
      {
        name: "send_gmail",
        description: "Send an email on the user's behalf. Only use when the user has clearly asked.",
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
        description: "Search the web for current, real-time information.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "What to search for." } },
          required: ["query"],
        },
      },
      {
        name: "schedule_reminder",
        description: "Schedule a plain message to be delivered at a specific future time.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: { type: "STRING", description: "The exact message to send." },
            run_at: { type: "STRING", description: "ISO 8601 datetime with timezone offset." },
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
            start: { type: "STRING", description: "Start time, ISO 8601 with timezone offset." },
            end: { type: "STRING", description: "End time, ISO 8601 with timezone offset. Defaults to 1 hour after start." },
            description: { type: "STRING", description: "Optional event description." },
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
            query: { type: "STRING", description: "Optional search query." },
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
            query: { type: "STRING", description: "Optional search query." },
            max_results: { type: "NUMBER", description: "Max contacts to return. Defaults to 10." },
          },
        },
      },
      {
        name: "get_youtube_channel_analytics",
        description: "Get YouTube channel analytics including views and subscribers.",
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

// ============================================================
// DATABASE FUNCTIONS
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

async function getEmbedding(text) {
  try {
    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      }
    );
    return data.embedding?.values || null;
  } catch (e) {
    console.error("getEmbedding error:", e.message);
    return null;
  }
}

async function saveMemory(content) {
  const embedding = await getEmbedding(content);
  const { error } = await supabase.from("agent_memories").insert({ content, embedding });
  return { saved: !error, error: error?.message };
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

async function searchMemoriesSemantic(query) {
  const embedding = await getEmbedding(query);
  if (!embedding) {
    // fall back to plain text search if embeddings are unavailable
    const { data, error } = await supabase.from("agent_memories").select("content").ilike("content", `%${query}%`).limit(10);
    return { memories: (data || []).map((r) => r.content), reason: error?.message };
  }
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
  return { scheduled: !error, reason: error ? error.message : null };
}

async function scheduleReminder(message, runAt, recurrence) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ message, run_at: runAt, status: "pending", recurrence: recurrence || "once", kind: "reminder" });
  return { scheduled: !error, reason: error ? error.message : null };
}

async function updateGoalStatus(goalId, status) {
  const { error } = await supabase.from("goals").update({ status }).eq("id", goalId);
  return { updated: !error, reason: error ? error.message : null };
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
  if (!GOOGLE_CONFIGURED) return { created: false, reason: "Google Calendar not connected" };
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

async function executeFunctionCall(fc) {
  try {
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
    if (fc.name === "get_current_datetime") return nowInTimezone();
    return { error: "unknown tool" };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// ============================================================
// CHAT HANDLER
// ============================================================
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
    return "⚠️ No Gemini API keys configured.";
  }
  
  try {
    const memories = await fetchRecentMemories();
    const profile = await getUserProfile();
    
    let systemInstruction = BASE_SYSTEM_INSTRUCTION;
    if (profile) {
      systemInstruction += `\n\nUser profile: ${profile}`;
    }
    if (memories.length > 0) {
      systemInstruction += `\n\nSaved facts:\n- ` + memories.join("\n- ");
    }

    // bring in recent conversation turns so follow-up questions work —
    // the current userText was already logged to bot_messages by the
    // caller before this ran, so drop that trailing duplicate here
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

    for (let i = 0; i < 3; i++) {
      let data;
      try {
        data = await callGemini(contents, systemInstruction);
      } catch (e) {
        console.error("callGemini failed:", e.message);
        return "⚠️ I couldn't reach Gemini right now. Please try again in a moment.";
      }

      if (data.error) {
        return `⚠️ Gemini error: ${data.error.message || JSON.stringify(data.error)}`;
      }

      const parts = data.candidates?.[0]?.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

      if (functionCalls.length === 0) {
        return textReply || "I processed your request but have no response.";
      }

      contents.push({ role: "model", parts });
      const responseParts = [];
      for (const fc of functionCalls) {
        const result = await executeFunctionCall(fc);
        responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }
    
    return "I completed the actions you requested.";
  } catch (e) {
    console.error("handleChatMessage error:", e);
    return "⚠️ Something went wrong processing your request.";
  }
}

// ============================================================
// BACKGROUND TASKS
// ============================================================
async function logBotMessage(role, content) {
  if (!content) return;
  try {
    await supabase.from("bot_messages").insert({ role, content });
  } catch (e) {}
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

setInterval(async () => {
  try {
    const { data: waiting } = await supabase
      .from("goal_steps")
      .select("id")
      .eq("status", "awaiting_approval")
      .limit(1)
      .maybeSingle();
    if (waiting) return;

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
  } catch (e) {
    console.error("checkAndSendNextStep error:", e.message);
  }
}, 30000);

// ---- scheduled_tasks executor (THIS WAS MISSING — without it,
// schedule_research and schedule_reminder just sit in the DB forever) ----
async function runResearch(topic) {
  const data = await fetchGeminiRotating(
    (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: `Research this topic using web search and write a short, spoken-style briefing (4-6 sentences, no markdown, no headers) summarizing the most useful current findings: ${topic}` }],
        }],
        tools: [{ googleSearch: {} }],
      }),
    }
  );
  if (data.error) throw new Error(data.error.message || "Gemini research call failed");
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
  return text || "Couldn't find anything useful.";
}

function computeNextRun(currentRunAt, recurrence) {
  const d = new Date(currentRunAt);
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  return d.toISOString();
}

setInterval(checkScheduledTasks, 60000);
checkScheduledTasks();

async function checkScheduledTasks() {
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
      await logBotMessage("agent", result);
    } catch (e) {
      await supabase.from("scheduled_tasks").update({ status: "failed" }).eq("id", task.id);
      await bot.sendMessage(CHAT_ID, `⚠️ Scheduled task "${task.topic || task.message}" failed: ${e.message}`);
    }
  }
}

// ---- passive memory extraction (every 5 min) ----
setInterval(extractMemoriesFromRecent, 5 * 60 * 1000);

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
    for (const fact of facts) await saveMemory(fact);
    if (facts.length > 0) console.log(`📚 Extracted ${facts.length} memories from background scan.`);
  } catch (e) {
    console.error("extractMemoriesFromRecent error:", e.message);
  }

  const ids = unprocessed.map((m) => m.id);
  await supabase.from("bot_messages").update({ extracted: true }).in("id", ids);
}

// ---- evolving user profile (every 15 min) ----
setInterval(updateUserProfileFromRecent, 15 * 60 * 1000);

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

// ---- autonomous thinking tick (every 7 min) ----
const AUTONOMOUS_SYSTEM_INSTRUCTION = `You are Night Agent's autonomous
background process, running silently every ~7 minutes even when the user
isn't actively chatting. Decide if there's anything worth proactively doing
right now, based on the context you're given. You may take several actions
in a row this tick if needed, then stop.

Good reasons to act:
- A goal step has been sitting pending or awaiting_approval for a long time
  (many hours) — a gentle nudge is fine.
- A goal looks abandoned/stale (no progress in days) — consider marking it
  cancelled with update_goal_status instead of nagging forever.
- A known fact implies something time-sensitive is coming up soon and no
  task exists for it yet.
- A calendar event is coming up soon and seems worth a heads-up.
- The user recently mentioned genuinely liking or being curious about
  something new — like a good friend, look into it (schedule_research with
  run_at set to right now) and share something back informally. Don't do
  this for every passing mention, and never research the same topic twice.

NEVER call send_gmail during this autonomous review — sending email only
happens in direct response to the user explicitly asking, in the moment.

Be conservative — most ticks, there is nothing worth doing. Don't repeat a
nudge about the same thing recently (check recent conversation first). When
completely done acting this tick (including doing nothing), your FINAL
reply must be exactly: NOTHING — unless you want to message the user right
now, in which case your final reply is that short warm message instead.`;

setInterval(autonomousTick, 7 * 60 * 1000);

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

    for (let i = 0; i < 4; i++) {
      const data = await callGemini(contents, AUTONOMOUS_SYSTEM_INSTRUCTION);
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
        const result = await executeFunctionCall(fc);
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
// MAIN MESSAGE HANDLER
// ============================================================
const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  if (!msg.text) return;
  
  const text = msg.text.trim();
  const lower = text.toLowerCase();
  await logBotMessage("user", text);

  try {
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
      await logBotMessage("agent", `Done: ${waiting.description}`);
      return;
    }
    
    if (waiting && SKIP_WORDS.includes(lower)) {
      await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", waiting.id);
      await bot.sendMessage(CHAT_ID, `⏭️ Skipped: ${waiting.description}`);
      await logBotMessage("agent", `Skipped: ${waiting.description}`);
      return;
    }

    bot.sendChatAction(CHAT_ID, "typing");
    const reply = await handleChatMessage(text);
    await bot.sendMessage(CHAT_ID, reply);
    await logBotMessage("agent", reply);
  } catch (e) {
    console.error("Message handler error:", e);
    await bot.sendMessage(CHAT_ID, "⚠️ Sorry, something went wrong. Please try again.");
  }
});

// ============================================================
// STARTUP
// ============================================================
console.log(`🚀 Night Agent started with ${API_KEYS.length} Gemini keys`);
console.log(`✅ Google OAuth: ${GOOGLE_CONFIGURED ? 'Configured' : 'Not configured'}`);
console.log(`✅ Model: ${GEMINI_TEXT_MODEL}`);
console.log(`✅ Timezone: ${TIMEZONE}`);
