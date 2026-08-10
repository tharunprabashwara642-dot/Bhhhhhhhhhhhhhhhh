// Night Agent Tasks Bot — standalone project
//
// What this bot does:
// 1. Step-by-step goal check-ins — when a goal_step is awaiting_approval,
//    tap the "✅ Done" / "⏭️ Skip" buttons on the message (or reply
//    "ok"/"skip" by typing, which still works too).
// 2. General chat (text, voice, AND photos) — any other message gets a
//    real reply from Gemini, using saved memories, short-term conversation
//    history, and a set of tools (memory, journal, habits, reminders...).
//    Gemini's built-in Google Search grounding is also enabled, so it can
//    answer questions about current events/weather/etc on its own.
// 3. Autonomous behavior — schedules reminders (one-off, daily, or
//    weekly) and fires them on its own; sends a morning digest of active
//    goals + today's reminders without being asked; can search all saved
//    memories and journal entries, not just the recent ones.
// 4. Reliability — background loops and the Gemini call are wrapped so
//    failures get reported to you on Telegram, duplicate reminders are
//    caught before creation, and /status gives you a quick health check.
//
// Required environment variables (set these in Railway, never in code):
//   TELEGRAM_BOT_TOKEN         (from BotFather)
//   SUPABASE_URL               (Project Settings > API)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings > API > service_role key)
//   NIGHT_AGENT_CHAT_ID        (your personal Telegram chat id)
//   GEMINI_API_KEY             (same key as the orb app, from AI Studio)
//
// NOTE on Google Search grounding: the googleSearch tool added below
// requires your Gemini API key/plan to support search grounding. If calls
// start erroring after this change, remove the `{ googleSearch: {} }`
// entry from the `tools` array in callGemini() and everything else keeps
// working as before.
//
// Supabase tables needed — run once in the Supabase SQL editor:
//
//   create table scheduled_tasks (
//     id bigint generated always as identity primary key,
//     description text not null,
//     due_at timestamptz not null,
//     recurrence text not null default 'once',   -- 'once' | 'daily' | 'weekly'
//     status text not null default 'pending',    -- 'pending' | 'sent' | 'cancelled'
//     created_at timestamptz not null default now()
//   );
//   alter table scheduled_tasks add column if not exists recurrence text not null default 'once';
//
//   create table chat_history (
//     id bigint generated always as identity primary key,
//     role text not null,      -- 'user' | 'model'
//     content text not null,
//     created_at timestamptz not null default now()
//   );
//
//   create table journal_entries (
//     id bigint generated always as identity primary key,
//     content text not null,
//     created_at timestamptz not null default now()
//   );
//
//   create table habits (
//     id bigint generated always as identity primary key,
//     name text not null unique,
//     created_at timestamptz not null default now()
//   );
//
//   create table habit_logs (
//     id bigint generated always as identity primary key,
//     habit_id bigint not null references habits(id),
//     logged_date date not null,
//     created_at timestamptz not null default now(),
//     unique (habit_id, logged_date)
//   );
//
// SEMANTIC MEMORY (pgvector) — needed for meaning-based recall instead of
// plain keyword matching. Run once in the Supabase SQL editor:
//
//   create extension if not exists vector;
//   alter table agent_memories add column if not exists embedding vector(768);
//   alter table journal_entries add column if not exists embedding vector(768);
//
//   create or replace function match_memories(query_embedding vector(768), match_count int)
//   returns table(content text, similarity float) as $$
//     select content, 1 - (embedding <=> query_embedding) as similarity
//     from agent_memories
//     where embedding is not null
//     order by embedding <=> query_embedding
//     limit match_count;
//   $$ language sql stable;
//
//   create or replace function match_journal(query_embedding vector(768), match_count int)
//   returns table(content text, similarity float) as $$
//     select content, 1 - (embedding <=> query_embedding) as similarity
//     from journal_entries
//     where embedding is not null
//     order by embedding <=> query_embedding
//     limit match_count;
//   $$ language sql stable;
//
// If embedding fails for any reason (API hiccup, extension not enabled
// yet), recall_memories/recall_journal fall back to plain keyword search
// automatically — nothing breaks either way.

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Confirm these match models available on your AI Studio account.
const GEMINI_TEXT_MODEL = "gemini-3.1-flash-lite";
const EMBEDDING_MODEL = "text-embedding-004";

// Fixed local timezone used whenever a reminder time doesn't specify one.
// Sri Lanka has no DST, so a plain fixed offset is safe.
const BOT_TIMEZONE = "Asia/Colombo";
const BOT_UTC_OFFSET = "+05:30";

const CHAT_HISTORY_LIMIT = 12; // ~6 turns of short-term conversation context
const DIGEST_HOUR = 7; // send the morning digest at 7am Colombo time
const WEEKLY_REVIEW_DAY = 0; // Sunday (0 = Sunday, per Date#getDay)
const WEEKLY_REVIEW_HOUR = 19; // 7pm Colombo time

const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

console.log("Night Agent Tasks Bot started.");

// ============================================================
// error reporting helper — used everywhere so failures reach you on
// Telegram, not just Railway logs you may not be watching.
// ============================================================
async function notifyError(context, err) {
  console.error(`[${context}]`, err);
  try {
    await bot.sendMessage(CHAT_ID, `⚠️ Debug — ${context} failed: ${err?.message || err}`);
  } catch (_) {
    // if even the notification fails, there's nothing more we can do
  }
}

// ============================================================
// PART 1 — step-by-step goal check-ins
// ============================================================
setInterval(checkAndSendNextStep, 30000);
checkAndSendNextStep();

async function checkAndSendNextStep() {
  try {
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
      `🌙 "${nextStep.goals.title}" — step ${nextStep.step_number}:\n${nextStep.description}\n\nTap a button below, or reply "ok"/"skip".`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Done", callback_data: `step_done:${nextStep.id}` },
              { text: "⏭️ Skip", callback_data: `step_skip:${nextStep.id}` },
            ],
          ],
        },
      }
    );
  } catch (err) {
    await notifyError("checkAndSendNextStep", err);
  }
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
// PART 3 — scheduled reminders, checked every 30s.
// Supports one-off reminders and simple daily/weekly recurrence.
// ============================================================
setInterval(checkScheduledTasks, 30000);
checkScheduledTasks();

function normalizeDueAt(due_at) {
  const hasOffset = /Z$|[+-]\d{2}:\d{2}$/.test(due_at || "");
  return hasOffset ? due_at : `${due_at}${BOT_UTC_OFFSET}`;
}

function nextOccurrence(currentDueAt, recurrence) {
  const next = new Date(currentDueAt);
  if (recurrence === "daily") next.setDate(next.getDate() + 1);
  else if (recurrence === "weekly") next.setDate(next.getDate() + 7);
  return next.toISOString();
}

async function checkScheduledTasks() {
  try {
    const { data: dueTasks, error } = await supabase
      .from("scheduled_tasks")
      .select("*")
      .eq("status", "pending")
      .lte("due_at", new Date().toISOString());

    if (error) throw error;
    if (!dueTasks || dueTasks.length === 0) return;

    for (const task of dueTasks) {
      await bot.sendMessage(CHAT_ID, `⏰ ${task.description}`);

      if (task.recurrence === "daily" || task.recurrence === "weekly") {
        await supabase
          .from("scheduled_tasks")
          .update({ due_at: nextOccurrence(task.due_at, task.recurrence) })
          .eq("id", task.id);
      } else {
        await supabase.from("scheduled_tasks").update({ status: "sent" }).eq("id", task.id);
      }
    }
  } catch (err) {
    await notifyError("checkScheduledTasks", err);
  }
}

// ============================================================
// PART 4 — proactive morning digest (active goals + today's reminders)
// ============================================================
let lastDigestDate = null;
setInterval(checkMorningDigest, 5 * 60000);

function checkMorningDigest() {
  const nowColombo = new Date(new Date().toLocaleString("en-US", { timeZone: BOT_TIMEZONE }));
  const todayStr = nowColombo.toDateString();
  if (nowColombo.getHours() === DIGEST_HOUR && lastDigestDate !== todayStr) {
    lastDigestDate = todayStr;
    sendMorningDigest();
  }
}

async function sendMorningDigest() {
  try {
    const { data: goals } = await supabase.from("goals").select("title").eq("status", "active");
    const { data: reminders } = await supabase
      .from("scheduled_tasks")
      .select("description, due_at")
      .eq("status", "pending")
      .lte("due_at", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
      .order("due_at", { ascending: true });

    const lines = ["☀️ Good morning! Here's today's overview:"];
    lines.push(
      goals && goals.length > 0
        ? `\nActive goals: ${goals.map((g) => g.title).join(", ")}`
        : "\nNo active goals right now."
    );
    if (reminders && reminders.length > 0) {
      const list = reminders
        .map((r) => `• ${r.description} (${new Date(r.due_at).toLocaleTimeString("en-US", { timeZone: BOT_TIMEZONE, hour: "2-digit", minute: "2-digit" })})`)
        .join("\n");
      lines.push(`\nToday's reminders:\n${list}`);
    }
    await bot.sendMessage(CHAT_ID, lines.join("\n"));
  } catch (err) {
    await notifyError("sendMorningDigest", err);
  }
}

// ============================================================
// PART 4b — weekly self-reflection (Sunday evenings)
// Looks back over the week's memories, journal entries, and habit logs
// and asks Gemini to turn that into a short, warm written reflection —
// not just a stats dump.
// ============================================================
let lastWeeklyReviewDate = null;
setInterval(checkWeeklyReview, 15 * 60000);

function checkWeeklyReview() {
  const nowColombo = new Date(new Date().toLocaleString("en-US", { timeZone: BOT_TIMEZONE }));
  const todayStr = nowColombo.toDateString();
  if (
    nowColombo.getDay() === WEEKLY_REVIEW_DAY &&
    nowColombo.getHours() === WEEKLY_REVIEW_HOUR &&
    lastWeeklyReviewDate !== todayStr
  ) {
    lastWeeklyReviewDate = todayStr;
    sendWeeklyReview();
  }
}

async function sendWeeklyReview() {
  try {
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekAgoDate = colomboDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

    const [{ data: memories }, { data: journal }, { data: habits }] = await Promise.all([
      supabase.from("agent_memories").select("content").gte("created_at", weekAgoIso),
      supabase.from("journal_entries").select("content").gte("created_at", weekAgoIso),
      supabase.from("habits").select("id, name"),
    ]);

    const habitLines = [];
    for (const h of habits || []) {
      const { count } = await supabase
        .from("habit_logs")
        .select("id", { count: "exact", head: true })
        .eq("habit_id", h.id)
        .gte("logged_date", weekAgoDate);
      habitLines.push(`${h.name}: ${count ?? 0}/7 days logged`);
    }

    const summaryPrompt = `Here is raw data about the user from the past week. Write a short
(4-6 sentence), warm, non-judgmental weekly reflection, calling out one or
two real patterns worth their attention if any stand out. No markdown, no
lists, no headers — just a few natural sentences.

Memories learned this week: ${(memories || []).map((m) => m.content).join("; ") || "none"}
Journal entries this week: ${(journal || []).map((j) => j.content).join("; ") || "none"}
Habit tracking this week: ${habitLines.join(", ") || "no habits tracked yet"}`;

    const data = await callGemini([{ role: "user", parts: [{ text: summaryPrompt }] }], BASE_SYSTEM_INSTRUCTION);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const reviewText =
      parts.filter((p) => p.text).map((p) => p.text).join(" ").trim() ||
      "Couldn't put together this week's reflection — take a look at your habits and goals yourself this week!";

    await bot.sendMessage(CHAT_ID, `🗓️ Weekly reflection:\n\n${reviewText}`);
  } catch (err) {
    await notifyError("sendWeeklyReview", err);
  }
}

// ============================================================
// PART 5 — /status command
// ============================================================
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function sendStatusReport() {
  try {
    const [pendingSteps, activeGoals, pendingReminders, journalEntries] = await Promise.all([
      supabase.from("goal_steps").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("goals").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabase.from("scheduled_tasks").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("journal_entries").select("id", { count: "exact", head: true }),
    ]);
    const lines = [
      "📊 Status:",
      `Active goals: ${activeGoals.count ?? 0}`,
      `Pending goal steps: ${pendingSteps.count ?? 0}`,
      `Pending reminders: ${pendingReminders.count ?? 0}`,
      `Journal entries: ${journalEntries.count ?? 0}`,
      `Uptime: ${formatUptime(process.uptime())}`,
    ];
    await bot.sendMessage(CHAT_ID, lines.join("\n"));
  } catch (err) {
    await notifyError("sendStatusReport", err);
  }
}

// ============================================================
// PART 2 — general chat (text + voice + photo) with Gemini
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, a calm, warm assistant the
user talks to through Telegram (as well as a separate voice app). Reply
naturally and briefly — 2-4 short sentences, no markdown, no lists, no
headers. If the user writes in Sinhala, reply in natural Sinhala; otherwise
reply in the same language they used. Sometimes the user sends a voice
message or a photo instead of typing — respond to what they said or showed
you exactly as you would to text. The user's local timezone is ${BOT_TIMEZONE}
(UTC${BOT_UTC_OFFSET}). You also have live Google Search access — use it
automatically for anything current (news, weather, prices, real-time facts)
rather than guessing from memory. For requests that naturally need several
steps (e.g. save a memory AND schedule a reminder AND log a habit in one
message), go ahead and make all the necessary tool calls yourself in one
turn rather than doing one and stopping to check in — only pause to ask
first when something is genuinely ambiguous or hard to undo, like
cancelling a reminder you're not sure about.

You have eleven tools available:
- save_memory / recall_memories: save_memory stores a short third-person
  fact worth remembering long-term (e.g. "User sleeps around 12:30am").
  recall_memories searches ALL saved memories by meaning, not just exact
  keywords, so it can find relevant things even if the user phrases it
  differently than when it was saved.
- save_journal_entry / recall_journal: for longer free-form notes or
  reflections the user wants written down (not short facts) — use
  save_journal_entry when they're thinking out loud or want something
  logged, and recall_journal to search past entries by meaning.
- log_habit / get_habit_streak: log_habit records that the user did a
  named habit today (or a given date); get_habit_streak reports their
  current streak and history for a habit. Use these for recurring things
  the user wants to track doing (exercise, reading, etc), not one-off
  goals.
- get_current_datetime: get today's date/time in the user's timezone,
  including to figure out a due_at value for schedule_reminder.
- create_task_list: break a stated goal into short ordered steps, tracked
  and checked in step-by-step right here on Telegram.
- schedule_reminder / list_reminders / cancel_reminder: schedule_reminder
  sets a reminder for a specific future time (once, daily, or weekly) that
  fires automatically with no further input from you. list_reminders shows
  what's pending. cancel_reminder cancels one by task_id — if it's
  ambiguous which one, ask the user to clarify first.`;

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
        name: "recall_memories",
        description: "Search through ALL saved memories about the user (not just the most recent ones).",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "Keyword or phrase to search for." } },
          required: ["query"],
        },
      },
      {
        name: "save_journal_entry",
        description: "Save a longer free-form journal or note entry, separate from short factual memories.",
        parameters: {
          type: "OBJECT",
          properties: { content: { type: "STRING", description: "The journal entry text." } },
          required: ["content"],
        },
      },
      {
        name: "recall_journal",
        description: "Search past journal entries by keyword.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "Keyword or phrase to search for." } },
          required: ["query"],
        },
      },
      {
        name: "log_habit",
        description: "Log that the user did a habit today (or a specific date). Creates the habit if new.",
        parameters: {
          type: "OBJECT",
          properties: {
            habit_name: { type: "STRING", description: "Name of the habit, e.g. 'exercise'." },
            date: { type: "STRING", description: "YYYY-MM-DD; defaults to today if omitted." },
          },
          required: ["habit_name"],
        },
      },
      {
        name: "get_habit_streak",
        description: "Get the current streak and recent history for a habit.",
        parameters: {
          type: "OBJECT",
          properties: { habit_name: { type: "STRING", description: "Name of the habit to check." } },
          required: ["habit_name"],
        },
      },
      {
        name: "get_current_datetime",
        description: "Get the current date, day of week, and time in the user's local timezone.",
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
        name: "schedule_reminder",
        description: "Schedule a reminder to fire automatically at a future date/time. Can repeat daily or weekly.",
        parameters: {
          type: "OBJECT",
          properties: {
            description: { type: "STRING", description: "What to remind the user about." },
            due_at: {
              type: "STRING",
              description:
                "ISO 8601 date-time, e.g. 2026-08-12T09:00:00+05:30. If you omit the UTC offset, Asia/Colombo (+05:30) is assumed.",
            },
            recurrence: { type: "STRING", description: "One of: once, daily, weekly. Defaults to once." },
          },
          required: ["description", "due_at"],
        },
      },
      {
        name: "list_reminders",
        description: "List the user's currently pending scheduled reminders/tasks.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "cancel_reminder",
        description: "Cancel a pending scheduled reminder by its task_id.",
        parameters: {
          type: "OBJECT",
          properties: { task_id: { type: "STRING", description: "The id of the task, from list_reminders." } },
          required: ["task_id"],
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

function buildSystemInstruction(memories) {
  if (memories.length === 0) return BASE_SYSTEM_INSTRUCTION;
  return BASE_SYSTEM_INSTRUCTION + `\n\nThings you already know about the user:\n- ` + memories.join("\n- ");
}

async function fetchChatHistory() {
  const { data } = await supabase
    .from("chat_history")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(CHAT_HISTORY_LIMIT);
  return (data || []).reverse();
}

async function saveChatTurn(role, content) {
  if (!content) return;
  await supabase.from("chat_history").insert({ role, content });
}

// Turns text into a vector via Gemini's embedding model, for semantic
// (meaning-based) recall. Returns null on any failure so callers can fall
// back to plain keyword search instead of breaking.
async function embedText(text) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      }
    );
    const data = await res.json();
    return data?.embedding?.values || null;
  } catch (err) {
    console.error("embedText failed:", err);
    return null;
  }
}

async function saveMemory(content) {
  const embedding = await embedText(content);
  const { error } = await supabase.from("agent_memories").insert({ content, embedding });
  return { saved: !error };
}

async function recallMemories(query) {
  const embedding = await embedText(query);
  if (embedding) {
    const { data, error } = await supabase.rpc("match_memories", { query_embedding: embedding, match_count: 15 });
    if (!error && data) return { found: data.length > 0, memories: data.map((r) => r.content) };
  }
  // fallback: plain keyword search (also covers the case pgvector isn't set up yet)
  const { data, error } = await supabase
    .from("agent_memories")
    .select("content")
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return { found: false };
  return { found: true, memories: (data || []).map((r) => r.content) };
}

async function saveJournalEntry(content) {
  const embedding = await embedText(content);
  const { error } = await supabase.from("journal_entries").insert({ content, embedding });
  return { saved: !error };
}

async function recallJournal(query) {
  const embedding = await embedText(query);
  if (embedding) {
    const { data, error } = await supabase.rpc("match_journal", { query_embedding: embedding, match_count: 10 });
    if (!error && data) return { found: data.length > 0, entries: data.map((r) => r.content) };
  }
  const { data, error } = await supabase
    .from("journal_entries")
    .select("content")
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return { found: false };
  return { found: true, entries: (data || []).map((r) => r.content) };
}

function colomboDateString(date = new Date()) {
  // en-CA locale gives YYYY-MM-DD directly
  return date.toLocaleDateString("en-CA", { timeZone: BOT_TIMEZONE });
}

async function logHabit(habitName, date) {
  const logDate = date || colomboDateString();
  let { data: habit } = await supabase.from("habits").select("id").ilike("name", habitName).maybeSingle();
  if (!habit) {
    const { data: newHabit, error } = await supabase.from("habits").insert({ name: habitName }).select().single();
    if (error) return { logged: false, reason: error.message };
    habit = newHabit;
  }
  const { error: logErr } = await supabase
    .from("habit_logs")
    .upsert({ habit_id: habit.id, logged_date: logDate }, { onConflict: "habit_id,logged_date" });
  return { logged: !logErr, habit: habitName, date: logDate };
}

async function getHabitStreak(habitName) {
  const { data: habit } = await supabase.from("habits").select("id").ilike("name", habitName).maybeSingle();
  if (!habit) return { found: false };

  const { data: logs } = await supabase
    .from("habit_logs")
    .select("logged_date")
    .eq("habit_id", habit.id)
    .order("logged_date", { ascending: false })
    .limit(90);
  const loggedDates = new Set((logs || []).map((l) => l.logged_date));

  let streak = 0;
  let cursor = new Date(new Date().toLocaleString("en-US", { timeZone: BOT_TIMEZONE }));
  while (loggedDates.has(colomboDateString(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { found: true, habit: habitName, current_streak: streak, total_logged_days: loggedDates.size };
}

async function createTaskList(title, steps) {
  const { data: goal, error: goalErr } = await supabase.from("goals").insert({ title }).select().single();
  if (goalErr) return { created: false, reason: goalErr.message };
  const rows = steps.map((description, i) => ({ goal_id: goal.id, step_number: i + 1, description }));
  const { error: stepsErr } = await supabase.from("goal_steps").insert(rows);
  return { created: !stepsErr, goal_id: goal.id, steps_count: steps.length };
}

async function scheduleReminder(description, due_at, recurrence) {
  const normalizedDueAt = normalizeDueAt(due_at);
  const rec = ["daily", "weekly"].includes(recurrence) ? recurrence : "once";

  const windowStart = new Date(new Date(normalizedDueAt).getTime() - 60000).toISOString();
  const windowEnd = new Date(new Date(normalizedDueAt).getTime() + 60000).toISOString();
  const { data: existing } = await supabase
    .from("scheduled_tasks")
    .select("id")
    .eq("status", "pending")
    .ilike("description", description)
    .gte("due_at", windowStart)
    .lte("due_at", windowEnd)
    .maybeSingle();

  if (existing) {
    return { scheduled: false, reason: "duplicate", existing_task_id: existing.id };
  }

  const { data, error } = await supabase
    .from("scheduled_tasks")
    .insert({ description, due_at: normalizedDueAt, recurrence: rec, status: "pending" })
    .select()
    .single();
  return { scheduled: !error, task_id: data?.id, due_at: normalizedDueAt, recurrence: rec };
}

async function listReminders() {
  const { data, error } = await supabase
    .from("scheduled_tasks")
    .select("id, description, due_at, recurrence")
    .eq("status", "pending")
    .order("due_at", { ascending: true });
  if (error) return { found: false };
  return { found: true, reminders: data || [] };
}

async function cancelReminder(taskId) {
  const { error } = await supabase
    .from("scheduled_tasks")
    .update({ status: "cancelled" })
    .eq("id", taskId)
    .eq("status", "pending");
  return { cancelled: !error };
}

async function executeFunctionCall(fc) {
  if (fc.name === "save_memory") return await saveMemory(fc.args?.content || "");
  if (fc.name === "recall_memories") return await recallMemories(fc.args?.query || "");
  if (fc.name === "save_journal_entry") return await saveJournalEntry(fc.args?.content || "");
  if (fc.name === "recall_journal") return await recallJournal(fc.args?.query || "");
  if (fc.name === "log_habit") return await logHabit(fc.args?.habit_name || "", fc.args?.date);
  if (fc.name === "get_habit_streak") return await getHabitStreak(fc.args?.habit_name || "");
  if (fc.name === "create_task_list") return await createTaskList(fc.args?.title || "Untitled goal", fc.args?.steps || []);
  if (fc.name === "schedule_reminder") return await scheduleReminder(fc.args?.description || "", fc.args?.due_at, fc.args?.recurrence);
  if (fc.name === "list_reminders") return await listReminders();
  if (fc.name === "cancel_reminder") return await cancelReminder(fc.args?.task_id);
  if (fc.name === "get_current_datetime") {
    const now = new Date();
    return {
      iso: now.toISOString(),
      readable: now.toLocaleString("en-US", { timeZone: BOT_TIMEZONE, dateStyle: "full", timeStyle: "short" }),
      timezone: `${BOT_TIMEZONE} (UTC${BOT_UTC_OFFSET})`,
    };
  }
  return { error: "unknown tool" };
}

async function callGemini(contents, systemInstruction) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
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
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error("Gemini API error:", JSON.stringify(data));
    }
    return data;
  } catch (err) {
    await notifyError("callGemini", err);
    return { error: { message: err.message } };
  }
}

// userParts: array of Gemini "parts" (text and/or inlineData for audio/image).
// historyLabel: plain-text version of what the user said, saved to
// chat_history for short-term conversational continuity.
async function handleChatMessage(userParts, historyLabel) {
  if (!GEMINI_API_KEY) {
    return "⚠️ Debug: GEMINI_API_KEY is not set in Railway variables.";
  }
  const [memories, history] = await Promise.all([fetchRecentMemories(), fetchChatHistory()]);
  const systemInstruction = buildSystemInstruction(memories);

  let contents = history.map((h) => ({ role: h.role, parts: [{ text: h.content }] }));
  contents.push({ role: "user", parts: userParts });

  for (let i = 0; i < 8; i++) {
    const data = await callGemini(contents, systemInstruction);

    if (data.error) {
      return `⚠️ Debug — Gemini error: ${data.error.message || JSON.stringify(data.error)}`;
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

    if (functionCalls.length === 0) {
      if (textReply) {
        await saveChatTurn("user", historyLabel);
        await saveChatTurn("model", textReply);
        return textReply;
      }
      return `⚠️ Debug — no text or function call in response: ${JSON.stringify(data).slice(0, 500)}`;
    }

    contents.push({ role: "model", parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      const result = await executeFunctionCall(fc);
      responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return "Sorry, something went wrong on my end.";
}

async function downloadTelegramFileAsBase64(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

async function handleVoiceMessage(fileId) {
  const base64Audio = await downloadTelegramFileAsBase64(fileId);
  return await handleChatMessage(
    [{ inlineData: { mimeType: "audio/ogg", data: base64Audio } }],
    "[voice message]"
  );
}

async function handlePhotoMessage(fileId, caption) {
  const base64Image = await downloadTelegramFileAsBase64(fileId);
  const parts = [{ inlineData: { mimeType: "image/jpeg", data: base64Image } }];
  if (caption) parts.push({ text: caption });
  return await handleChatMessage(parts, caption ? `[photo] ${caption}` : "[photo]");
}

// ============================================================
// message router
// ============================================================
bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  if (msg.voice) {
    bot.sendChatAction(CHAT_ID, "typing");
    try {
      const reply = await handleVoiceMessage(msg.voice.file_id);
      await bot.sendMessage(CHAT_ID, reply);
    } catch (err) {
      await notifyError("voice message handling", err);
    }
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    bot.sendChatAction(CHAT_ID, "typing");
    try {
      const largest = msg.photo[msg.photo.length - 1];
      const reply = await handlePhotoMessage(largest.file_id, msg.caption || "");
      await bot.sendMessage(CHAT_ID, reply);
    } catch (err) {
      await notifyError("photo message handling", err);
    }
    return;
  }

  if (!msg.text) return; // other file types not handled yet
  const text = msg.text.trim();
  const lower = text.toLowerCase();

  if (lower === "/status") {
    await sendStatusReport();
    return;
  }

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
    checkAndSendNextStep();
    return;
  }
  if (waiting && SKIP_WORDS.includes(lower)) {
    await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", waiting.id);
    await bot.sendMessage(CHAT_ID, `⏭️ Skipped: ${waiting.description}`);
    checkAndSendNextStep();
    return;
  }

  // not a step reply or command — treat as general conversation
  bot.sendChatAction(CHAT_ID, "typing");
  const reply = await handleChatMessage([{ text }], text);
  await bot.sendMessage(CHAT_ID, reply);
});

// ============================================================
// inline button taps for goal step check-ins ("✅ Done" / "⏭️ Skip")
// ============================================================
bot.on("callback_query", async (query) => {
  if (String(query.message?.chat?.id) !== String(CHAT_ID)) return;

  const [action, stepIdStr] = (query.data || "").split(":");
  const stepId = Number(stepIdStr);

  try {
    if (action !== "step_done" && action !== "step_skip") {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const { data: step } = await supabase
      .from("goal_steps")
      .select("*, goals!inner(title)")
      .eq("id", stepId)
      .maybeSingle();

    if (!step || step.status !== "awaiting_approval") {
      await bot.answerCallbackQuery(query.id, { text: "This step isn't waiting anymore." });
      return;
    }

    // clear the buttons so this message can't be tapped twice
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    } catch (_) {
      // non-fatal — message may already be edited/gone
    }

    if (action === "step_done") {
      await supabase.from("goal_steps").update({ status: "done" }).eq("id", step.id);
      await maybeCompleteGoal(step.goal_id, step.goals.title);
      await bot.answerCallbackQuery(query.id, { text: "Marked done ✅" });
      await bot.sendMessage(CHAT_ID, `✅ Done: ${step.description}`);
    } else {
      await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", step.id);
      await bot.answerCallbackQuery(query.id, { text: "Skipped ⏭️" });
      await bot.sendMessage(CHAT_ID, `⏭️ Skipped: ${step.description}`);
    }

    checkAndSendNextStep();
  } catch (err) {
    await notifyError("callback_query handling", err);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Something went wrong." });
    } catch (_) {}
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
