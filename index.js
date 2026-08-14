// Night Agent Tasks Bot — standalone project
//
// NEW in this update — run once in the Supabase SQL editor:
//
//   -- usage tracking (Gemini calls / Vercel deploys per day)
//   create table if not exists api_usage (
//     date date primary key,
//     gemini_calls integer not null default 0,
//     vercel_deploys integer not null default 0
//   );
//
//   -- scheduled_tasks.kind may have a CHECK constraint restricting it to
//   -- ('research','reminder') from before — the morning digest needs
//   -- 'digest' allowed too. If you get an error scheduling the digest,
//   -- widen or drop that constraint, e.g.:
//   -- alter table scheduled_tasks drop constraint if exists scheduled_tasks_kind_check;
//
// NEW optional env vars:
//   MORNING_DIGEST_HOUR            (hour, Colombo time, to send the daily
//                                   digest — defaults to 7 for 7am)
//   GEMINI_ROUGH_DAILY_LIMIT_PER_KEY (rough free-tier requests/day per key,
//                                   used only for the usage-warning
//                                   estimate — defaults to 1000)
//   USAGE_WARN_RATIO               (0-1, warn once daily usage crosses this
//                                   fraction of the rough estimate — default 0.8)
//
// NEW features: voice message transcription (Telegram voice notes),
// document/photo upload with Gemini summary + auto Drive save, memory
// forget_memory/update_memory, morning digest (calendar+Gmail+weather+
// goals sent daily), deployed-website list/delete, and a self-tracked
// Gemini/Vercel usage counter with a proactive warning.

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

// node-telegram-bot-api emits 'polling_error' for network hiccups against
// Telegram's servers (e.g. "socket hang up", ECONNRESET, timeouts) — these
// are common on long-poll connections and NOT fatal: the library keeps
// polling and retries on its own. Without this listener the error was only
// visible as a raw log line with no context; now it's clearly labeled so
// it's obvious in Railway logs that the bot is still running.
bot.on('polling_error', (error) => {
  console.error(`⚠️ Telegram polling error (${error.code || 'unknown'}): ${error.message}. Still polling — this is usually transient.`);
});

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

// ============================================================
// VERCEL (website generation + deploy)
// ============================================================
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN || "";
const VERCEL_CONFIGURED = !!VERCEL_API_TOKEN;

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

async function resolveContactEmail(nameOrEmail) {
  if (!nameOrEmail) return { email: null, reason: "no name/email given" };
  if (nameOrEmail.includes("@")) return { email: nameOrEmail };
  if (!GOOGLE_CONFIGURED) return { email: null, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(nameOrEmail)}&readMask=names,emailAddresses`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const match = (data.results || [])[0]?.person;
    const email = match?.emailAddresses?.[0]?.value;
    if (!email) return { email: null, reason: `No contact matching "${nameOrEmail}" with an email address` };
    return { email, matchedName: match?.names?.[0]?.displayName };
  } catch (e) {
    console.error("resolveContactEmail error:", e.message);
    return { email: null, reason: e.message };
  }
}

async function sendGmail(to, subject, body) {
  if (!GOOGLE_CONFIGURED) return { sent: false, reason: "Google not connected" };
  try {
    const resolved = await resolveContactEmail(to);
    if (!resolved.email) return { sent: false, reason: resolved.reason || `Could not resolve "${to}" to an email address` };
    const accessToken = await getGoogleAccessToken();
    const rawMessage = [`To: ${resolved.email}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n");
    const raw = base64UrlEncode(rawMessage);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { sent: true, id: data.id, to: resolved.email };
  } catch (e) {
    console.error("sendGmail error:", e.message);
    return { sent: false, reason: e.message };
  }
}

async function createDriveFolder(name, parentId) {
  if (!GOOGLE_CONFIGURED) return { created: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const body = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parentId) body.parents = [parentId];
    const res = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      const scopeHint = data.error.status === "PERMISSION_DENIED" || res.status === 403
        ? " — the current Google connection only has drive.readonly, which cannot create files. It needs to be re-authorized with drive.file or drive scope."
        : "";
      throw new Error(data.error.message + scopeHint);
    }
    return { created: true, id: data.id, name: data.name, link: `https://drive.google.com/drive/folders/${data.id}` };
  } catch (e) {
    console.error("createDriveFolder error:", e.message);
    return { created: false, reason: e.message };
  }
}

// Uploads a raw file (buffer) to Drive — used by the Telegram document/photo
// handler to save whatever the user just sent. Not exposed as an LLM tool
// (the bytes only exist in this one request), just called directly.
async function uploadBufferToDrive(buffer, fileName, mimeType) {
  const accessToken = await getGoogleAccessToken();
  const boundary = "nightagent" + Date.now();
  const metadata = JSON.stringify({ name: fileName });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    "utf-8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf-8");
  const body = Buffer.concat([head, buffer, tail]);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { id: data.id, link: `https://drive.google.com/file/d/${data.id}/view` };
}

async function createGoogleDoc(title, content) {
  if (!GOOGLE_CONFIGURED) return { created: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await res.json();
    if (data.error) {
      const scopeHint = res.status === 403
        ? " — the current Google connection only has documents.readonly, which cannot create docs. It needs to be re-authorized with the documents scope (not readonly)."
        : "";
      throw new Error(data.error.message + scopeHint);
    }
    if (content) {
      const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${data.documentId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        }),
      });
      const updateData = await updateRes.json();
      if (updateData.error) console.error("createGoogleDoc content insert warning:", updateData.error.message);
    }
    return { created: true, id: data.documentId, title: data.title, link: `https://docs.google.com/document/d/${data.documentId}/edit` };
  } catch (e) {
    console.error("createGoogleDoc error:", e.message);
    return { created: false, reason: e.message };
  }
}

async function createGoogleSheet(title) {
  if (!GOOGLE_CONFIGURED) return { created: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { created: true, id: data.spreadsheetId, title: data.properties?.title, link: data.spreadsheetUrl };
  } catch (e) {
    console.error("createGoogleSheet error:", e.message);
    return { created: false, reason: e.message };
  }
}

async function updateSheetData(spreadsheetId, range, values) {
  if (!GOOGLE_CONFIGURED) return { updated: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, values }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { updated: true, updatedCells: data.updatedCells, updatedRange: data.updatedRange };
  } catch (e) {
    console.error("updateSheetData error:", e.message);
    return { updated: false, reason: e.message };
  }
}

// ---- Drive: delete / rename / move / share ----
async function deleteDriveFile(fileId) {
  if (!GOOGLE_CONFIGURED) return { deleted: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }
    return { deleted: true, id: fileId };
  } catch (e) {
    console.error("deleteDriveFile error:", e.message);
    return { deleted: false, reason: e.message };
  }
}

async function renameDriveFile(fileId, newName) {
  if (!GOOGLE_CONFIGURED) return { renamed: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { renamed: true, id: data.id, name: data.name };
  } catch (e) {
    console.error("renameDriveFile error:", e.message);
    return { renamed: false, reason: e.message };
  }
}

async function moveDriveFile(fileId, newParentId, oldParentId) {
  if (!GOOGLE_CONFIGURED) return { moved: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    let removeParents = oldParentId;
    if (!removeParents) {
      const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const getData = await getRes.json();
      removeParents = (getData.parents || []).join(",");
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${encodeURIComponent(newParentId)}&removeParents=${encodeURIComponent(removeParents)}&fields=id,parents`;
    const res = await fetch(url, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { moved: true, id: data.id, parents: data.parents };
  } catch (e) {
    console.error("moveDriveFile error:", e.message);
    return { moved: false, reason: e.message };
  }
}

async function shareDriveFile(fileId, email, role) {
  if (!GOOGLE_CONFIGURED) return { shared: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role: role || "reader", emailAddress: email }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { shared: true, permissionId: data.id, email, role: role || "reader" };
  } catch (e) {
    console.error("shareDriveFile error:", e.message);
    return { shared: false, reason: e.message };
  }
}

// ---- Gmail: delete (trash) / archive / label / read state ----
async function trashGmail(messageId) {
  if (!GOOGLE_CONFIGURED) return { trashed: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { trashed: true, id: messageId };
  } catch (e) {
    console.error("trashGmail error:", e.message);
    return { trashed: false, reason: e.message };
  }
}

async function modifyGmailLabels(messageId, addLabelIds, removeLabelIds) {
  if (!GOOGLE_CONFIGURED) return { modified: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { modified: true, id: data.id, labelIds: data.labelIds };
  } catch (e) {
    console.error("modifyGmailLabels error:", e.message);
    return { modified: false, reason: e.message };
  }
}

async function archiveGmail(messageId) {
  return modifyGmailLabels(messageId, [], ["INBOX"]);
}

async function markGmailRead(messageId, read) {
  return read
    ? modifyGmailLabels(messageId, [], ["UNREAD"])
    : modifyGmailLabels(messageId, ["UNREAD"], []);
}

async function labelGmail(messageId, labelName, remove) {
  if (!GOOGLE_CONFIGURED) return { labeled: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const listData = await listRes.json();
    if (listData.error) throw new Error(listData.error.message);
    let label = (listData.labels || []).find((l) => l.name.toLowerCase() === labelName.toLowerCase());
    if (!label && !remove) {
      const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }),
      });
      label = await createRes.json();
      if (label.error) throw new Error(label.error.message);
    }
    if (!label) return { labeled: false, reason: `Label "${labelName}" not found` };
    return remove
      ? await modifyGmailLabels(messageId, [], [label.id])
      : await modifyGmailLabels(messageId, [label.id], []);
  } catch (e) {
    console.error("labelGmail error:", e.message);
    return { labeled: false, reason: e.message };
  }
}

// ---- Calendar: update / delete / free-busy check ----
async function updateCalendarEvent(eventId, updates) {
  if (!GOOGLE_CONFIGURED) return { updated: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const body = {};
    if (updates.title) body.summary = updates.title;
    if (updates.description) body.description = updates.description;
    if (updates.start) body.start = { dateTime: updates.start };
    if (updates.end) body.end = { dateTime: updates.end };
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { updated: true, id: data.id, link: data.htmlLink };
  } catch (e) {
    console.error("updateCalendarEvent error:", e.message);
    return { updated: false, reason: e.message };
  }
}

async function deleteCalendarEvent(eventId) {
  if (!GOOGLE_CONFIGURED) return { deleted: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 204 && res.status !== 200) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }
    return { deleted: true, id: eventId };
  } catch (e) {
    console.error("deleteCalendarEvent error:", e.message);
    return { deleted: false, reason: e.message };
  }
}

async function checkFreeBusy(daysAhead) {
  if (!GOOGLE_CONFIGURED) return { busy: [], reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + (daysAhead || 3) * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const busy = data.calendars?.primary?.busy || [];
    return { busy, timeMin, timeMax };
  } catch (e) {
    console.error("checkFreeBusy error:", e.message);
    return { busy: [], reason: e.message };
  }
}

// ---- Contacts: add / update ----
async function addContact(name, email, phone) {
  if (!GOOGLE_CONFIGURED) return { added: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const body = { names: [{ givenName: name }] };
    if (email) body.emailAddresses = [{ value: email }];
    if (phone) body.phoneNumbers = [{ value: phone }];
    const res = await fetch("https://people.googleapis.com/v1/people:createContact", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { added: true, resourceName: data.resourceName, name };
  } catch (e) {
    console.error("addContact error:", e.message);
    return { added: false, reason: e.message };
  }
}

async function updateContact(resourceName, updates) {
  if (!GOOGLE_CONFIGURED) return { updated: false, reason: "Google not connected" };
  try {
    const accessToken = await getGoogleAccessToken();
    const getRes = await fetch(
      `https://people.googleapis.com/v1/${resourceName}?personFields=names,emailAddresses,phoneNumbers`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const person = await getRes.json();
    if (person.error) throw new Error(person.error.message);

    const fields = [];
    if (updates.name) { person.names = [{ givenName: updates.name }]; fields.push("names"); }
    if (updates.email) { person.emailAddresses = [{ value: updates.email }]; fields.push("emailAddresses"); }
    if (updates.phone) { person.phoneNumbers = [{ value: updates.phone }]; fields.push("phoneNumbers"); }
    if (fields.length === 0) return { updated: false, reason: "Nothing to update" };

    const res = await fetch(
      `https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=${fields.join(",")}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(person),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { updated: true, resourceName: data.resourceName };
  } catch (e) {
    console.error("updateContact error:", e.message);
    return { updated: false, reason: e.message };
  }
}

// ============================================================
// GEMINI HELPER FUNCTIONS
// ============================================================
// Every fetch() in this file used to have no timeout at all — if Gemini or
// Vercel's API ever hung instead of erroring, an await would sit there
// forever with the user seeing no reply and no error (this is what caused
// deploy_website to go silent after the confirm tap). Wrap outbound calls
// so a stuck connection surfaces as an error within a bounded time instead.
async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- usage tracking (best-effort — counts calls THIS bot makes, not a
// live pull from Google/Vercel's own dashboards) ----
async function incrementUsage(field) {
  try {
    const today = nowInTimezone().iso.slice(0, 10);
    const { data: existing } = await supabase.from("api_usage").select("*").eq("date", today).maybeSingle();
    if (existing) {
      await supabase.from("api_usage").update({ [field]: (existing[field] || 0) + 1 }).eq("date", today);
    } else {
      await supabase.from("api_usage").insert({ date: today, [field]: 1 });
    }
  } catch (e) {
    // usage tracking should never break the actual request
  }
}

async function fetchGeminiRotating(urlBuilder, options) {
  const attempts = Math.max(API_KEYS.length, 1);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    if (!key) throw new Error("No Gemini API key configured");
    try {
      const res = await fetchWithTimeout(urlBuilder(key), options);
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
      incrementUsage("gemini_calls"); // fire-and-forget, doesn't block the response
      return data;
    } catch (e) {
      if (e.name === "AbortError") {
        console.error(`⚠️ Key index ${keyCursor - 1} (****${key.slice(-4)}) timed out`);
        lastErr = new Error("Gemini request timed out");
      } else {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("All Gemini API keys failed");
}

async function getUsageStats() {
  const today = nowInTimezone().iso.slice(0, 10);
  const { data } = await supabase.from("api_usage").select("*").eq("date", today).maybeSingle();
  const geminiCallsToday = data?.gemini_calls || 0;
  const vercelDeploysToday = data?.vercel_deploys || 0;
  // Rough, approximate free-tier request-per-day figure per key — actual
  // limits vary by model/account and can change; treat this as a heads-up
  // trigger, not an authoritative number.
  const roughLimitPerKey = parseInt(process.env.GEMINI_ROUGH_DAILY_LIMIT_PER_KEY || "1000", 10);
  const roughTotalLimit = API_KEYS.length * roughLimitPerKey;
  return {
    date: today,
    gemini_calls_today: geminiCallsToday,
    gemini_keys_active: API_KEYS.length,
    rough_daily_gemini_limit_estimate: roughTotalLimit,
    percent_of_rough_limit_used: roughTotalLimit > 0 ? Math.round((geminiCallsToday / roughTotalLimit) * 100) : null,
    vercel_deploys_today: vercelDeploysToday,
    note: "These are counts this bot tracks itself, not live numbers pulled from Google/Vercel's own dashboards — treat the Gemini limit as a rough estimate.",
  };
}

// warn once per day if usage looks close to the rough estimated limit
let usageWarnedDate = null;
setInterval(async () => {
  try {
    const stats = await getUsageStats();
    if (!stats.rough_daily_gemini_limit_estimate) return;
    const ratio = stats.gemini_calls_today / stats.rough_daily_gemini_limit_estimate;
    const threshold = parseFloat(process.env.USAGE_WARN_RATIO || "0.8");
    if (ratio >= threshold && usageWarnedDate !== stats.date) {
      usageWarnedDate = stats.date;
      await bot.sendMessage(
        CHAT_ID,
        `⚠️ Boss, අද Gemini API calls ${stats.gemini_calls_today}ක් — rough estimate limit එකෙන් ~${stats.percent_of_rough_limit_used}%ක් පාවිච්චි වෙලා (keys ${stats.gemini_keys_active}ක් active). අවශ්‍ය නම් GEMINI_API_KEYS එකට තවත් key එකක් දාන්න.`
      );
    }
  } catch (e) {
    console.error("usage warn check error:", e.message);
  }
}, 30 * 60 * 1000);

// Using the Flash-Lite tier on purpose: much higher free-tier RPM than
// Flash, so the frequent background ticks + tool-call loops here are far
// less likely to hit rate limits. Don't downgrade to 2.5 (worse quality,
// no upside) or upgrade back to full Flash without checking rate limits.
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite";
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

// Whatever offset format the model hands us (it's told to use +05:30, but
// don't trust that blindly), always store run_at as a normalized UTC ISO
// string (ends in Z). scheduled_tasks.run_at is compared against
// new Date().toISOString() in checkScheduledTasks — if the two values are
// in different offset formats and the column isn't a real timestamptz,
// string comparison silently breaks, causing reminders to fire at the
// wrong time or never. Normalizing here removes that whole class of bug
// regardless of the column type.
function normalizeRunAt(runAt) {
  if (!runAt) return { ok: false, reason: "No run_at provided." };
  const d = new Date(runAt);
  if (isNaN(d.getTime())) return { ok: false, reason: `Could not parse run_at "${runAt}" as a valid date/time.` };
  const nowMs = Date.now();
  if (d.getTime() < nowMs - 60000) {
    return { ok: false, reason: `run_at "${runAt}" is in the past (current time is ${nowInTimezone().readable}).` };
  }
  return { ok: true, iso: d.toISOString() };
}

// ============================================================
// SYSTEM INSTRUCTION AND TOOLS
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, the user's personal
assistant. Address the user respectfully as "Boss" (or "බොස්" in Sinhala) —
not as a casual friend/buddy ("මචන්" etc — never use that). Warm and
helpful, but the relationship is assistant-to-boss, not peer-to-peer.
Reply briefly — 2-4 short sentences, no markdown, no lists, no headers.
If the user writes in Sinhala, reply in natural Sinhala, addressing them
as "බොස්"; otherwise reply in the same language they used.

BE PROACTIVE: don't wait for the user to explicitly say "add this to my
calendar" or "send an email about this." If something they mention in
normal conversation clearly implies an actionable task — an appointment,
a deadline, something that should be emailed to someone, a file to
delete/share, a reminder — just call the relevant tool. You don't need to
ask permission in words first: any sensitive tool (creating/deleting/
sending/sharing anything real) is automatically intercepted by the system
and shown to the user as a Yes/No button in Telegram before it actually
runs — so calling the tool is safe, it will not silently execute without
their tap. When you call one of those tools, briefly mention in your
reply what you're about to do so the button makes sense (e.g. "Sent you a
confirm for adding that to the calendar, Boss.").

BE HONEST ABOUT PROBLEMS: if a tool fails or something isn't possible,
say exactly why in plain terms (e.g. "the Google connection doesn't have
permission to create Drive files, only to read them" or "the Google token
failed to refresh"). Never just say "can't do it" without a reason, and
never quietly make something up instead of using a tool.

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
- send_gmail: Send email (button-confirmed; never during autonomous
  background review)
- web_search: Search the web for current info
- schedule_reminder: Schedule a reminder message
- create_calendar_event: Add event to calendar (button-confirmed)
- get_drive_files: List files from Google Drive
- get_sheet_data: Read Google Sheet data
- get_doc_content: Read Google Doc content
- get_contacts: Search Google Contacts
- get_youtube_channel_analytics: Check YouTube stats
- create_drive_folder: Create a new folder in Google Drive
- create_google_doc: Create a new Google Doc, optionally with initial text
- create_google_sheet: Create a new Google Sheet
- update_sheet_data: Write/update values into an existing Google Sheet range
- delete_drive_file / rename_drive_file / move_drive_file / share_drive_file
- delete_gmail (trash) / archive_gmail / label_gmail / mark_gmail_read
- update_calendar_event / delete_calendar_event / check_free_time
- add_contact / update_contact
- deploy_website: write a full website from a description (3D/animated
  pages included, via three.js) and deploy it live to Vercel — returns a
  real public URL. Only available if Vercel is connected. Takes ~30-60s
  to build after deploying, mention that when you report the link.
- list_deployed_sites: list websites you've deployed to Vercel, with URLs.
- delete_deployed_site: permanently take down a deployed website
  (button-confirmed) — get the project name/id from list_deployed_sites.
- forget_memory: delete a specific saved fact that's wrong/outdated
  (button-confirmed) — get its id from recall_memories or search_memories.
- update_memory: correct a specific saved fact in place — get its id from
  recall_memories or search_memories first.
- get_usage_stats: check today's self-tracked Gemini call count and Vercel
  deploy count, to gauge how close to free-tier limits things are.

You also receive voice messages and uploaded files/photos directly (handled
before this chat loop): voice notes are transcribed and fed to you as if
typed; documents/images are summarized and, if Google Drive is connected,
saved there automatically — you don't need a tool call for either of those,
they already happened by the time you see them in conversation.

Every morning at 7am Colombo time, a digest (today's calendar, unread
Gmail, weather, active goals) is sent automatically — this also doesn't
need a tool call, it's handled by a background job.

All of the above except the two read/list-only groups (get_*, list_*,
recall_*, search_*, check_free_time) are button-confirmed automatically —
call them directly when the situation calls for it.

If a tool errors, don't go silent — tell the user clearly what went wrong
(pass along the real reason from the tool result, e.g. a permission/scope
problem vs a connection problem), or retry with corrected arguments if
that's likely to fix it.`;

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
        name: "deploy_website",
        description: "Write a complete website (HTML/CSS/JS, including 3D or animated pages via three.js if asked) from a description, and deploy it live to Vercel. Returns a real public URL.",
        parameters: {
          type: "OBJECT",
          properties: {
            description: { type: "STRING", description: "What the site should be, look like, and do — as detailed as the user gave it." },
            project_name: { type: "STRING", description: "Short slug-friendly name for the site. Optional — derived from the description if omitted." },
          },
          required: ["description"],
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
      {
        name: "create_drive_folder",
        description: "Create a new folder in Google Drive. Requires drive.file or drive scope.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Name of the folder." },
            parent_id: { type: "STRING", description: "Optional parent folder ID to create it inside." },
          },
          required: ["name"],
        },
      },
      {
        name: "create_google_doc",
        description: "Create a new Google Doc, optionally with initial text content. Requires the documents scope (not documents.readonly).",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Title of the document." },
            content: { type: "STRING", description: "Optional initial text content." },
          },
          required: ["title"],
        },
      },
      {
        name: "create_google_sheet",
        description: "Create a new, empty Google Sheet.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Title of the spreadsheet." },
          },
          required: ["title"],
        },
      },
      {
        name: "update_sheet_data",
        description: "Write or update values into a range of an existing Google Sheet.",
        parameters: {
          type: "OBJECT",
          properties: {
            spreadsheet_id: { type: "STRING", description: "The ID of the spreadsheet." },
            range: { type: "STRING", description: "Range in A1 notation (e.g., 'Sheet1!A1:C3')." },
            values: {
              type: "ARRAY",
              description: "2D array of row values, e.g. [[\"a\",\"b\"],[\"c\",\"d\"]].",
              items: { type: "ARRAY", items: { type: "STRING" } },
            },
          },
          required: ["spreadsheet_id", "range", "values"],
        },
      },
      {
        name: "delete_drive_file",
        description: "Delete a file or folder from Google Drive.",
        parameters: {
          type: "OBJECT",
          properties: { file_id: { type: "STRING", description: "The Drive file/folder ID." } },
          required: ["file_id"],
        },
      },
      {
        name: "rename_drive_file",
        description: "Rename a file or folder in Google Drive.",
        parameters: {
          type: "OBJECT",
          properties: {
            file_id: { type: "STRING", description: "The Drive file/folder ID." },
            new_name: { type: "STRING", description: "The new name." },
          },
          required: ["file_id", "new_name"],
        },
      },
      {
        name: "move_drive_file",
        description: "Move a Drive file/folder into a different folder.",
        parameters: {
          type: "OBJECT",
          properties: {
            file_id: { type: "STRING", description: "The Drive file/folder ID to move." },
            new_parent_id: { type: "STRING", description: "The destination folder ID." },
            old_parent_id: { type: "STRING", description: "Optional current parent folder ID to remove from." },
          },
          required: ["file_id", "new_parent_id"],
        },
      },
      {
        name: "share_drive_file",
        description: "Share a Drive file/folder with someone by email.",
        parameters: {
          type: "OBJECT",
          properties: {
            file_id: { type: "STRING", description: "The Drive file/folder ID." },
            email: { type: "STRING", description: "Email address to share with." },
            role: { type: "STRING", description: "One of: reader, writer, commenter. Defaults to reader." },
          },
          required: ["file_id", "email"],
        },
      },
      {
        name: "delete_gmail",
        description: "Move an email to Trash (recoverable for 30 days).",
        parameters: {
          type: "OBJECT",
          properties: { message_id: { type: "STRING", description: "The Gmail message ID." } },
          required: ["message_id"],
        },
      },
      {
        name: "archive_gmail",
        description: "Archive an email (remove it from the inbox).",
        parameters: {
          type: "OBJECT",
          properties: { message_id: { type: "STRING", description: "The Gmail message ID." } },
          required: ["message_id"],
        },
      },
      {
        name: "label_gmail",
        description: "Add or remove a Gmail label on a message. Creates the label if it doesn't exist yet.",
        parameters: {
          type: "OBJECT",
          properties: {
            message_id: { type: "STRING", description: "The Gmail message ID." },
            label_name: { type: "STRING", description: "The label name." },
            remove: { type: "BOOLEAN", description: "True to remove the label instead of adding it." },
          },
          required: ["message_id", "label_name"],
        },
      },
      {
        name: "mark_gmail_read",
        description: "Mark a Gmail message as read or unread.",
        parameters: {
          type: "OBJECT",
          properties: {
            message_id: { type: "STRING", description: "The Gmail message ID." },
            read: { type: "BOOLEAN", description: "True for read, false for unread." },
          },
          required: ["message_id", "read"],
        },
      },
      {
        name: "update_calendar_event",
        description: "Update an existing Google Calendar event's title, time, or description.",
        parameters: {
          type: "OBJECT",
          properties: {
            event_id: { type: "STRING", description: "The event ID (from get_calendar_events)." },
            title: { type: "STRING", description: "New title." },
            start: { type: "STRING", description: "New start time, ISO 8601 with timezone offset." },
            end: { type: "STRING", description: "New end time, ISO 8601 with timezone offset." },
            description: { type: "STRING", description: "New description." },
          },
          required: ["event_id"],
        },
      },
      {
        name: "delete_calendar_event",
        description: "Delete an event from Google Calendar.",
        parameters: {
          type: "OBJECT",
          properties: { event_id: { type: "STRING", description: "The event ID (from get_calendar_events)." } },
          required: ["event_id"],
        },
      },
      {
        name: "check_free_time",
        description: "Get the user's busy blocks over the next N days, to help find free time slots.",
        parameters: {
          type: "OBJECT",
          properties: { days_ahead: { type: "NUMBER", description: "How many days ahead to check. Defaults to 3." } },
        },
      },
      {
        name: "add_contact",
        description: "Add a new Google Contact.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Contact's name." },
            email: { type: "STRING", description: "Optional email address." },
            phone: { type: "STRING", description: "Optional phone number." },
          },
          required: ["name"],
        },
      },
      {
        name: "update_contact",
        description: "Update an existing Google Contact's name, email, or phone.",
        parameters: {
          type: "OBJECT",
          properties: {
            resource_name: { type: "STRING", description: "The contact's resourceName (from get_contacts)." },
            name: { type: "STRING", description: "New name." },
            email: { type: "STRING", description: "New email." },
            phone: { type: "STRING", description: "New phone." },
          },
          required: ["resource_name"],
        },
      },
      {
        name: "forget_memory",
        description: "Delete a specific saved fact that's wrong or no longer relevant. Get its memory_id from recall_memories or search_memories first.",
        parameters: {
          type: "OBJECT",
          properties: { memory_id: { type: "NUMBER", description: "The id of the memory to delete." } },
          required: ["memory_id"],
        },
      },
      {
        name: "update_memory",
        description: "Correct/edit a specific saved fact in place, instead of deleting and re-saving. Get its memory_id from recall_memories or search_memories first.",
        parameters: {
          type: "OBJECT",
          properties: {
            memory_id: { type: "NUMBER", description: "The id of the memory to update." },
            new_content: { type: "STRING", description: "The corrected fact, replacing the old content entirely." },
          },
          required: ["memory_id", "new_content"],
        },
      },
      {
        name: "list_deployed_sites",
        description: "List websites this bot has deployed to Vercel, with their live URLs.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "delete_deployed_site",
        description: "Permanently delete/take down a deployed website by its Vercel project name or id (from list_deployed_sites).",
        parameters: {
          type: "OBJECT",
          properties: { project: { type: "STRING", description: "The Vercel project name or id to delete." } },
          required: ["project"],
        },
      },
      {
        name: "get_usage_stats",
        description: "Check today's Gemini API call count and Vercel deploy count, so you know how close to free-tier limits things are. These are self-tracked counts, not a live pull from Google/Vercel's dashboards.",
        parameters: { type: "OBJECT", properties: {} },
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

async function forgetMemory(memoryId) {
  if (!memoryId) return { deleted: false, reason: "No memory_id given." };
  const { error } = await supabase.from("agent_memories").delete().eq("id", memoryId);
  return { deleted: !error, reason: error?.message };
}

async function updateMemory(memoryId, newContent) {
  if (!memoryId) return { updated: false, reason: "No memory_id given." };
  if (!newContent) return { updated: false, reason: "No new_content given." };
  const embedding = await getEmbedding(newContent);
  const { error } = await supabase.from("agent_memories").update({ content: newContent, embedding }).eq("id", memoryId);
  return { updated: !error, reason: error?.message };
}

async function recallMemories() {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("id, content, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { memories: [], reason: error.message };
  // id is included so forget_memory/update_memory can target a specific one
  return { memories: (data || []).map((r) => ({ id: r.id, content: r.content })) };
}

async function searchMemoriesSemantic(query) {
  const embedding = await getEmbedding(query);
  if (!embedding) {
    const { data, error } = await supabase.from("agent_memories").select("id, content").ilike("content", `%${query}%`).limit(10);
    return { memories: (data || []).map((r) => ({ id: r.id, content: r.content })), reason: error?.message };
  }
  const { data, error } = await supabase.rpc("match_memories", { query_embedding: embedding, match_count: 10 });
  if (error) return { memories: [], reason: error.message };
  return { memories: (data || []).map((r) => ({ id: r.id, content: r.content })) };
}

async function createTaskList(title, steps) {
  const { data: goal, error: goalErr } = await supabase.from("goals").insert({ title }).select().single();
  if (goalErr) return { created: false, reason: goalErr.message };
  const rows = steps.map((description, i) => ({ goal_id: goal.id, step_number: i + 1, description }));
  const { error: stepsErr } = await supabase.from("goal_steps").insert(rows);
  return { created: !stepsErr, goal_id: goal.id, steps_count: steps.length };
}

async function scheduleResearch(topic, runAt, recurrence) {
  const normalized = normalizeRunAt(runAt);
  if (!normalized.ok) return { scheduled: false, reason: normalized.reason };
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ topic, run_at: normalized.iso, status: "pending", recurrence: recurrence || "once", kind: "research" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: normalized.iso };
}

async function scheduleReminder(message, runAt, recurrence) {
  const normalized = normalizeRunAt(runAt);
  if (!normalized.ok) return { scheduled: false, reason: normalized.reason };
  const { error } = await supabase
    .from("scheduled_tasks")
    .insert({ message, run_at: normalized.iso, status: "pending", recurrence: recurrence || "once", kind: "reminder" });
  return { scheduled: !error, reason: error ? error.message : null, run_at: normalized.iso };
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

// Write a complete single-file website for the given description using
// Gemini, then deploy it straight to Vercel and hand back the live link.
async function deployWebsite(description, projectName) {
  if (!VERCEL_CONFIGURED) return { deployed: false, reason: "Vercel not connected (VERCEL_API_TOKEN missing)" };
  if (!description) return { deployed: false, reason: "No description given for the site." };

  let html;
  try {
    const codePrompt = `Write a complete, single-file HTML page for this request: "${description}"

Requirements:
- Everything — HTML, CSS, and JS — goes in this one file. No build step, no separate files, no server-side code.
- If 3D graphics, animation, or particle effects are wanted, use three.js loaded from
  https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js (r128 — don't use APIs newer than that, e.g. no OrbitControls import, no CapsuleGeometry; use CylinderGeometry/SphereGeometry/custom geometry instead).
- Make it genuinely polished: real typography choices, a deliberate color palette, smooth motion, good spacing — not a generic template look.
- Must work as a static site opened directly in a browser, nothing that requires a backend.
- Respond with ONLY the raw HTML, starting at <!DOCTYPE html> — no markdown code fences, no explanation before or after.`;

    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: codePrompt }] }] }),
      }
    );
    if (data.error) return { deployed: false, reason: `Code generation failed: ${data.error.message}` };
    html = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    html = html.replace(/^```html\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    if (!html || html.length < 100 || !/<html/i.test(html)) {
      return { deployed: false, reason: "The model didn't return usable HTML — try rephrasing the description." };
    }
  } catch (e) {
    return { deployed: false, reason: `Code generation error: ${e.message}` };
  }

  try {
    const slugBase = (projectName || description)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45);
    const slug = slugBase || `site-${Date.now()}`;

    const res = await fetchWithTimeout("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: slug,
        files: [{ file: "index.html", data: html }],
        projectSettings: { framework: null },
        target: "production",
      }),
    }, 60000);
    const result = await res.json();
    if (result.error) return { deployed: false, reason: result.error.message || JSON.stringify(result.error) };
    const url = result.url ? `https://${result.url}` : (result.alias?.[0] ? `https://${result.alias[0]}` : null);
    if (!url) return { deployed: false, reason: "Vercel didn't return a deployment URL." };
    // Save this as a real fact — without it, asking "what's the status" in a
    // later message has nothing to go on and the model was re-triggering a
    // whole new deploy instead of just answering with the existing link.
    await saveMemory(`Deployed a website — "${description}" — live at ${url} (Vercel project: ${slug})`);
    incrementUsage("vercel_deploys");
    return { deployed: true, url, project: slug, note: "May take ~30-60 seconds to finish building before it's live." };
  } catch (e) {
    console.error("deployWebsite error:", e.message);
    return { deployed: false, reason: e.name === "AbortError" ? "Vercel deploy request timed out." : e.message };
  }
}

async function listDeployedSites() {
  if (!VERCEL_CONFIGURED) return { sites: [], reason: "Vercel not connected (VERCEL_API_TOKEN missing)" };
  try {
    const res = await fetchWithTimeout("https://api.vercel.com/v9/projects?limit=50", {
      headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}` },
    }, 20000);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const sites = (data.projects || []).map((p) => {
      const alias = p.targets?.production?.alias?.[0];
      const latestUrl = p.latestDeployments?.[0]?.url;
      return {
        name: p.name,
        id: p.id,
        url: alias ? `https://${alias}` : (latestUrl ? `https://${latestUrl}` : null),
        created: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      };
    });
    return { sites };
  } catch (e) {
    console.error("listDeployedSites error:", e.message);
    return { sites: [], reason: e.message };
  }
}

async function deleteDeployedSite(projectIdOrName) {
  if (!VERCEL_CONFIGURED) return { deleted: false, reason: "Vercel not connected (VERCEL_API_TOKEN missing)" };
  if (!projectIdOrName) return { deleted: false, reason: "No project id/name given." };
  try {
    const res = await fetchWithTimeout(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectIdOrName)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}` },
    }, 20000);
    if (res.status === 204 || res.ok) return { deleted: true };
    const data = await res.json().catch(() => ({}));
    return { deleted: false, reason: data.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    console.error("deleteDeployedSite error:", e.message);
    return { deleted: false, reason: e.message };
  }
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

// ============================================================
// BUTTON-CONFIRMED (SENSITIVE) TOOLS
// ============================================================
// Any tool in here is intercepted before it runs: instead of executing
// immediately, we stash the call and show the user an inline Yes/No
// button in Telegram. It only actually runs if they tap Confirm.
const SENSITIVE_TOOLS = new Set([
  "send_gmail",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "create_drive_folder",
  "create_google_doc",
  "create_google_sheet",
  "update_sheet_data",
  "delete_drive_file",
  "rename_drive_file",
  "move_drive_file",
  "share_drive_file",
  "delete_gmail",
  "archive_gmail",
  "label_gmail",
  "mark_gmail_read",
  "add_contact",
  "update_contact",
  "deploy_website",
  "forget_memory",
  "delete_deployed_site",
]);

let pendingConfirmation = null; // { id, toolName, args, description }
let confirmationCounter = 0;

function describeAction(name, args) {
  args = args || {};
  switch (name) {
    case "send_gmail": return `📧 Email යවන්නද — to: ${args.to}, subject: "${args.subject}"?`;
    case "create_calendar_event": return `📅 Calendar event add කරන්නද — "${args.title}" (${args.start})?`;
    case "update_calendar_event": return `📅 Calendar event update කරන්නද (id: ${args.event_id})?`;
    case "delete_calendar_event": return `🗑️ Calendar event delete කරන්නද (id: ${args.event_id})?`;
    case "create_drive_folder": return `📁 Drive folder "${args.name}" හදන්නද?`;
    case "create_google_doc": return `📄 Google Doc "${args.title}" හදන්නද?`;
    case "create_google_sheet": return `📊 Google Sheet "${args.title}" හදන්නද?`;
    case "update_sheet_data": return `📊 Sheet එකේ (${args.range}) data update කරන්නද?`;
    case "delete_drive_file": return `🗑️ Drive file/folder එක delete කරන්නද (id: ${args.file_id})?`;
    case "rename_drive_file": return `✏️ Drive file එක "${args.new_name}" ලෙස rename කරන්නද?`;
    case "move_drive_file": return `📂 Drive file එක වෙනත් folder එකකට move කරන්නද?`;
    case "share_drive_file": return `🔗 Drive file එක ${args.email} සමග share කරන්නද (${args.role || "reader"})?`;
    case "delete_gmail": return `🗑️ Email එක Trash එකට දාන්නද?`;
    case "archive_gmail": return `📥 Email එක archive කරන්නද?`;
    case "label_gmail": return `🏷️ Email එකට "${args.label_name}" label එක ${args.remove ? "අයින්" : "දාන්නද"}?`;
    case "mark_gmail_read": return `✅ Email එක ${args.read ? "read" : "unread"} ලෙස mark කරන්නද?`;
    case "add_contact": return `👤 Contact "${args.name}" add කරන්නද?`;
    case "update_contact": return `👤 Contact එක update කරන්නද?`;
    case "deploy_website": {
      const shortDesc = (args.description || "").length > 300 ? args.description.slice(0, 300) + "…" : args.description;
      return `🌐 Website එකක් හදලා deploy කරන්නද — "${shortDesc}"? (code ලියලා Vercel එකට යවනවා, පොඩි වෙලාවක් යනවා)`;
    }
    case "forget_memory": return `🧠 මතකයෙන් අයින් කරන්නද (id: ${args.memory_id})?`;
    case "delete_deployed_site": return `🗑️ Website "${args.project}" delete කරන්නද? (live link එක නවත්තනවා)`;
    default: return `මේ action එක කරන්නද?`;
  }
}

async function sendConfirmationButtons() {
  const pc = pendingConfirmation;
  if (!pc || pc.buttonsSent) return;
  try {
    await bot.sendMessage(CHAT_ID, pc.description, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ ඔව්", callback_data: `confirm:${pc.id}` },
          { text: "❌ එපා", callback_data: `cancel:${pc.id}` },
        ]],
      },
    });
    // Only mark as sent once it actually went through — this used to be
    // set to true unconditionally *before* the send attempt, so a failed
    // send (e.g. a description long enough to hit Telegram's 4096-char
    // message limit) would silently mark the button "sent" and it would
    // never be retried, while the model kept telling the user it had been.
    pc.buttonsSent = true;
  } catch (e) {
    console.error("sendConfirmationButtons error:", e.message);
    // Fall back to a short plain message so the user at least sees
    // something went wrong, instead of silence. Leave buttonsSent false so
    // the next message from the user retries the real button.
    try {
      await bot.sendMessage(CHAT_ID, `⚠️ Confirm button එක යවන්න බැරි වුනා (${e.message}). "ok" කියලා reply කරන්න, ආයෙත් try කරන්නම්.`);
    } catch (_) {}
  }
}

async function runToolDirectly(name, args) {
  args = args || {};
  if (name === "save_memory") return await saveMemory(args.content || "");
  if (name === "create_task_list") return await createTaskList(args.title || "Untitled goal", args.steps || []);
  if (name === "schedule_research") return await scheduleResearch(args.topic || "", args.run_at || "", args.recurrence);
  if (name === "recall_memories") return await recallMemories();
  if (name === "search_memories") return await searchMemoriesSemantic(args.query || "");
  if (name === "list_active_goals") return await listActiveGoals();
  if (name === "update_goal_status") return await updateGoalStatus(args.goal_id, args.status);
  if (name === "get_calendar_events") return await getCalendarEvents(args.days_ahead || 7);
  if (name === "get_gmail_summary") return await getGmailSummary(args.max_results || 10, args.query || "is:unread");
  if (name === "send_gmail") return await sendGmail(args.to, args.subject, args.body);
  if (name === "web_search") return await webSearch(args.query || "");
  if (name === "schedule_reminder") return await scheduleReminder(args.message || "", args.run_at || "", args.recurrence);
  if (name === "create_calendar_event") return await createCalendarEvent(args.title || "Untitled event", args.start, args.end, args.description);
  if (name === "get_drive_files") return await getDriveFiles(args.max_results || 10, args.query || "");
  if (name === "get_sheet_data") return await getSheetData(args.spreadsheet_id, args.range);
  if (name === "get_doc_content") return await getDocContent(args.document_id);
  if (name === "get_contacts") return await getContacts(args.query || "", args.max_results || 10);
  if (name === "get_youtube_channel_analytics") return await getYouTubeAnalytics(args.channel_id || null);
  if (name === "create_drive_folder") return await createDriveFolder(args.name || "Untitled folder", args.parent_id);
  if (name === "create_google_doc") return await createGoogleDoc(args.title || "Untitled document", args.content || "");
  if (name === "create_google_sheet") return await createGoogleSheet(args.title || "Untitled spreadsheet");
  if (name === "update_sheet_data") return await updateSheetData(args.spreadsheet_id, args.range, args.values || []);
  if (name === "delete_drive_file") return await deleteDriveFile(args.file_id);
  if (name === "rename_drive_file") return await renameDriveFile(args.file_id, args.new_name);
  if (name === "move_drive_file") return await moveDriveFile(args.file_id, args.new_parent_id, args.old_parent_id);
  if (name === "share_drive_file") return await shareDriveFile(args.file_id, args.email, args.role);
  if (name === "delete_gmail") return await trashGmail(args.message_id);
  if (name === "archive_gmail") return await archiveGmail(args.message_id);
  if (name === "label_gmail") return await labelGmail(args.message_id, args.label_name, !!args.remove);
  if (name === "mark_gmail_read") return await markGmailRead(args.message_id, !!args.read);
  if (name === "update_calendar_event") return await updateCalendarEvent(args.event_id, args);
  if (name === "delete_calendar_event") return await deleteCalendarEvent(args.event_id);
  if (name === "check_free_time") return await checkFreeBusy(args.days_ahead || 3);
  if (name === "add_contact") return await addContact(args.name, args.email, args.phone);
  if (name === "update_contact") return await updateContact(args.resource_name, args);
  if (name === "forget_memory") return await forgetMemory(args.memory_id);
  if (name === "update_memory") return await updateMemory(args.memory_id, args.new_content || "");
  if (name === "list_deployed_sites") return await listDeployedSites();
  if (name === "delete_deployed_site") return await deleteDeployedSite(args.project);
  if (name === "get_usage_stats") return await getUsageStats();
  if (name === "deploy_website") return await deployWebsite(args.description || "", args.project_name || "");
  if (name === "get_current_datetime") return nowInTimezone();
  return { error: "unknown tool" };
}

async function executeFunctionCall(fc) {
  try {
    if (SENSITIVE_TOOLS.has(fc.name)) {
      confirmationCounter++;
      const id = String(confirmationCounter);
      const description = describeAction(fc.name, fc.args);
      pendingConfirmation = { id, toolName: fc.name, args: fc.args || {}, description, buttonsSent: false };
      return {
        status: "pending_confirmation",
        note: "A Yes/No button has been queued for the user in Telegram. This action will only run if they tap Confirm — do not tell them it's done yet.",
      };
    }
    return await runToolDirectly(fc.name, fc.args);
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
    const now = nowInTimezone();
    // Ground the model in the real current date/time on every message —
    // don't rely on it remembering to call get_current_datetime before
    // computing a relative date like "tomorrow" or "next week". Missing
    // that call was the cause of reminders landing on the wrong day.
    systemInstruction += `\n\nCurrent date/time right now: ${now.readable} (ISO: ${now.iso}, timezone ${TIMEZONE}).
When the user says something relative — "tomorrow", "tonight", "next
Monday", "in 2 hours", "in 3 days" — compute the exact run_at yourself
from THIS current date/time, not from any date you might otherwise
assume. Always include the +05:30 offset in run_at.`;
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
async function logBotMessage(role, content, channel = "telegram") {
  if (!content) return;
  try {
    const { error } = await supabase.from("bot_messages").insert({ role, content, channel });
    // Falls back to the old 2-column insert if the `channel` column hasn't
    // been added yet (see schema_migration.sql) — logging still works
    // either way, it just won't be tagged with the source channel until
    // the migration is run.
    if (error) await supabase.from("bot_messages").insert({ role, content });
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

// ---- morning digest ----
const MORNING_DIGEST_HOUR = parseInt(process.env.MORNING_DIGEST_HOUR || "7", 10); // Colombo local hour

async function buildMorningDigest() {
  const now = nowInTimezone();
  const parts = [`☀️ සුභ උදෑසනක්, Boss! (${now.readable})`];

  const { events } = GOOGLE_CONFIGURED ? await getCalendarEvents(1) : { events: [] };
  if (events && events.length > 0) {
    const list = events.map((e) => {
      const t = e.start ? new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE }) : "";
      return `${t ? t + " — " : ""}${e.title}`;
    });
    parts.push(`📅 අද: ${list.join(", ")}`);
  } else {
    parts.push("📅 අද calendar එකේ specific event නෑ.");
  }

  if (GOOGLE_CONFIGURED) {
    const { emails } = await getGmailSummary(5, "is:unread");
    if (emails && emails.length > 0) {
      parts.push(`📧 Unread emails ${emails.length}ක් — වැදගත්ම එක "${emails[0].subject}" (${emails[0].from}).`);
    }
  }

  try {
    const w = await webSearch("today's weather forecast Colombo Sri Lanka");
    if (w.result) parts.push(`🌤️ ${w.result}`);
  } catch (e) {}

  const { goals } = await listActiveGoals();
  if (goals && goals.length > 0) parts.push(`🎯 Active goals ${goals.length}ක් තියෙනවා.`);

  return parts.join("\n");
}

// Colombo is a fixed UTC+5:30 offset (no DST) — compute the next instant
// that is MORNING_DIGEST_HOUR:00 Colombo time, as a true UTC ISO string.
function nextColomboDigestRun() {
  const OFFSET_MIN = 330;
  const now = new Date();
  const nowColombo = new Date(now.getTime() + OFFSET_MIN * 60000);
  const targetColomboLabeled = new Date(Date.UTC(
    nowColombo.getUTCFullYear(), nowColombo.getUTCMonth(), nowColombo.getUTCDate(),
    MORNING_DIGEST_HOUR, 0, 0
  ));
  let targetUtc = new Date(targetColomboLabeled.getTime() - OFFSET_MIN * 60000);
  if (targetUtc <= now) targetUtc = new Date(targetUtc.getTime() + 24 * 60 * 60 * 1000);
  return targetUtc.toISOString();
}

async function ensureMorningDigestScheduled() {
  try {
    const { data: existing } = await supabase
      .from("scheduled_tasks")
      .select("id")
      .eq("kind", "digest")
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    await supabase.from("scheduled_tasks").insert({
      kind: "digest",
      message: "Morning digest",
      run_at: nextColomboDigestRun(),
      status: "pending",
      recurrence: "daily",
    });
    console.log(`☀️ Morning digest scheduled for ${MORNING_DIGEST_HOUR}:00 Colombo time.`);
  } catch (e) {
    console.error("ensureMorningDigestScheduled error (has scheduled_tasks.kind been widened? see setup notes):", e.message);
  }
}
ensureMorningDigestScheduled();

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
      const isDigest = task.kind === "digest";
      const result = isDigest ? await buildMorningDigest() : isReminder ? task.message : await runResearch(task.topic);
      if (task.recurrence && task.recurrence !== "once") {
        const nextRun = isDigest ? nextColomboDigestRun() : computeNextRun(task.run_at, task.recurrence);
        await supabase.from("scheduled_tasks").update({ status: "pending", run_at: nextRun, result }).eq("id", task.id);
      } else {
        await supabase.from("scheduled_tasks").update({ status: "done", result }).eq("id", task.id);
      }
      const icon = isDigest ? "☀️" : isReminder ? "⏰" : "🔎";
      await bot.sendMessage(CHAT_ID, isDigest ? result : `${icon} ${result}`);
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
isn't actively chatting — this is your self-study time. Decide if there's
anything worth proactively doing right now, based on the context you're
given. You may take several actions in a row this tick if needed, then
stop. You have the full tool set, including create/update/delete on
Calendar, Gmail, Drive, and Contacts — every one of those is button-gated
(the user gets a Yes/No tap in Telegram before anything real actually
happens), so it's safe to queue one whenever you have a good reason. Use
the read tools (get_calendar_events, get_gmail_summary, get_drive_files,
get_sheet_data, get_doc_content, get_contacts, check_free_time) freely to
build situational awareness before deciding — don't only react to what's
already in front of you, go look.

Good reasons to act:
- A goal step has been sitting pending or awaiting_approval for a long time
  (many hours) — a gentle nudge is fine.
- A goal looks abandoned/stale (no progress in days) — consider marking it
  cancelled with update_goal_status instead of nagging forever.
- A known fact implies something time-sensitive is coming up soon and no
  task exists for it yet.
- A calendar event is coming up soon and seems worth a heads-up, or two
  events look like they conflict, or check_free_time reveals a good slot
  for something the user said they wanted to schedule.
- Gmail has unread messages that look like they need a reply, filing, or
  archiving — you can label/archive/mark-read directly (button-gated), or
  flag one worth a heads-up.
- Drive has clutter worth naming (duplicate-looking files, an obviously
  misplaced item) — suggest or queue a tidy-up action.
- The user recently mentioned genuinely liking or being curious about
  something new — like a good friend, look into it with web_search or
  schedule_research, and share something back informally. Don't do this
  for every passing mention, and never research the same topic twice.

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
        await sendConfirmationButtons();
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
    // loop ended after max iterations — still surface any queued confirmation
    await sendConfirmationButtons();
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

  // ---- voice notes: transcribe with Gemini, then run through the normal
  // chat pipeline exactly as if it had been typed ----
  if (msg.voice || msg.audio) {
    try {
      bot.sendChatAction(CHAT_ID, "typing");
      const fileId = (msg.voice || msg.audio).file_id;
      const mimeType = msg.voice ? "audio/ogg" : (msg.audio.mime_type || "audio/mpeg");
      const fileLink = await bot.getFileLink(fileId);
      const fileRes = await fetch(fileLink);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const base64Audio = buffer.toString("base64");

      const data = await fetchGeminiRotating(
        (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { inlineData: { mimeType, data: base64Audio } },
                { text: "Transcribe exactly what is said in this audio (it may be Sinhala or English). Reply with ONLY the transcription, nothing else." },
              ],
            }],
          }),
        }
      );
      if (data.error) throw new Error(data.error.message);
      const transcript = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim();
      if (!transcript) {
        await bot.sendMessage(CHAT_ID, "⚠️ Voice message එක තේරුම් ගන්න බැරි උනා.");
        return;
      }

      await bot.sendMessage(CHAT_ID, `🎤 "${transcript}"`);
      await logBotMessage("user", transcript);
      bot.sendChatAction(CHAT_ID, "typing");
      const reply = await handleChatMessage(transcript);
      await bot.sendMessage(CHAT_ID, reply);
      await logBotMessage("agent", reply);
      await sendConfirmationButtons();
    } catch (e) {
      console.error("Voice handling error:", e.message);
      await bot.sendMessage(CHAT_ID, `⚠️ Voice message process කරගන්න බැරි උනා: ${e.message}`);
    }
    return;
  }

  // ---- documents/photos: summarize with Gemini, save a copy to Drive if
  // connected ----
  if (msg.document || (msg.photo && msg.photo.length > 0)) {
    try {
      bot.sendChatAction(CHAT_ID, "typing");
      let fileId, mimeType, fileName;
      if (msg.document) {
        fileId = msg.document.file_id;
        mimeType = msg.document.mime_type || "application/octet-stream";
        fileName = msg.document.file_name || `file_${Date.now()}`;
      } else {
        const photo = msg.photo[msg.photo.length - 1]; // largest available size
        fileId = photo.file_id;
        mimeType = "image/jpeg";
        fileName = `photo_${Date.now()}.jpg`;
      }

      const fileLink = await bot.getFileLink(fileId);
      const fileRes = await fetch(fileLink);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const base64Data = buffer.toString("base64");

      const summaryData = await fetchGeminiRotating(
        (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { inlineData: { mimeType, data: base64Data } },
                { text: "Summarize this document/image concisely (4-6 sentences, no markdown, no headers) — what it is and the key points a busy person needs to know." },
              ],
            }],
          }),
        }
      );
      const summary = (summaryData.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim()
        || "Content එක කියවගන්න බැරි උනා.";

      let driveNote = "";
      if (GOOGLE_CONFIGURED) {
        try {
          const uploaded = await uploadBufferToDrive(buffer, fileName, mimeType);
          driveNote = `\n📁 Drive එකට save කළා: ${uploaded.link}`;
        } catch (e) {
          console.error("uploadBufferToDrive error:", e.message);
          driveNote = `\n⚠️ Drive එකට save කරන්න බැරි උනා: ${e.message}`;
        }
      }

      const replyText = `📄 ${summary}${driveNote}`;
      await bot.sendMessage(CHAT_ID, replyText);
      await logBotMessage("user", `[Sent a file: ${fileName}]`);
      await logBotMessage("agent", replyText);
    } catch (e) {
      console.error("File handling error:", e.message);
      await bot.sendMessage(CHAT_ID, `⚠️ File එක process කරගන්න බැරි උනා: ${e.message}`);
    }
    return;
  }

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
    // If the model queued a sensitive action this turn, send the button now
    await sendConfirmationButtons();
  } catch (e) {
    console.error("Message handler error:", e);
    await bot.sendMessage(CHAT_ID, "⚠️ Sorry, something went wrong. Please try again.");
  }
});

// ============================================================
// BUTTON CALLBACKS — confirm/cancel a pending sensitive action
// ============================================================
bot.on("callback_query", async (query) => {
  if (!query.message || String(query.message.chat.id) !== String(CHAT_ID)) return;
  const data = query.data || "";
  const [action, id] = data.split(":");

  try {
    if (!pendingConfirmation || pendingConfirmation.id !== id) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ මේක expire වෙලා, ආයෙත් අහන්න." });
      return;
    }

    const pc = pendingConfirmation;
    pendingConfirmation = null;

    if (action === "cancel") {
      await bot.answerCallbackQuery(query.id, { text: "Cancelled" });
      await bot.editMessageText(`❌ Cancelled: ${pc.description}`, {
        chat_id: CHAT_ID,
        message_id: query.message.message_id,
      });
      await logBotMessage("agent", `Cancelled: ${pc.description}`);
      return;
    }

    if (action === "confirm") {
      await bot.answerCallbackQuery(query.id, { text: "කරගෙන යනවා..." });
      let result, statusLine;
      try {
        result = await runToolDirectly(pc.toolName, pc.args);
        const ok = result && (result.error === undefined) && Object.values(result).some((v) => v === true);
        statusLine = ok
          ? "✅ Done."
          : `⚠️ Failed${result?.reason ? `: ${result.reason}` : result?.message ? `: ${result.message}` : "."}`;
        // A bunch of these tools (deploy_website, create_calendar_event,
        // create_drive_folder, create_google_doc/sheet, ...) return a real
        // link/url in the result — this used to be silently dropped, so
        // "Done." was the only thing the user ever saw, with no way to
        // actually reach what was just created.
        const linkOut = result?.url || result?.link;
        if (ok && linkOut) statusLine += `\n🔗 ${linkOut}`;
        if (ok && result?.note) statusLine += `\n${result.note}`;
      } catch (toolErr) {
        console.error("confirm action tool error:", toolErr.message);
        statusLine = `⚠️ Failed: ${toolErr.message}`;
      }
      await bot.editMessageText(`${pc.description}\n${statusLine}`, {
        chat_id: CHAT_ID,
        message_id: query.message.message_id,
      });
      await logBotMessage("agent", `${pc.description} — ${statusLine}`);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error("callback_query error:", e.message);
    // Make sure the person always sees SOMETHING happened instead of the
    // confirm button just sitting there forever with no feedback.
    try {
      await bot.editMessageText(`⚠️ Something went wrong: ${e.message}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch (_) {}
    try { await bot.answerCallbackQuery(query.id, { text: "⚠️ Error occurred." }); } catch (_) {}
  }
});

// ============================================================
// STARTUP
// ============================================================
console.log(`🚀 Night Agent started with ${API_KEYS.length} Gemini keys`);
console.log(`✅ Google OAuth: ${GOOGLE_CONFIGURED ? 'Configured' : 'Not configured'}`);
console.log(`✅ Vercel: ${VERCEL_CONFIGURED ? 'Configured' : 'Not configured'}`);
console.log(`✅ Model: ${GEMINI_TEXT_MODEL}`);
console.log(`✅ Timezone: ${TIMEZONE}`);
