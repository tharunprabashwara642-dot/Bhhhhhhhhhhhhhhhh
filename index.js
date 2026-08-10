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
//   GEMINI_API_KEY             (NEW — same key as the orb app, from AI Studio)

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Confirm this matches a text-capable Gemini model on your AI Studio account.
const GEMINI_TEXT_MODEL = "gemini-2.5-flash";

const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

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
// PART 2 — general text chat with Gemini (NEW)
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are Night Agent, a calm, warm assistant the
user talks to through Telegram (as well as a separate voice app). Reply
naturally and briefly — 2-4 short sentences, no markdown, no lists, no
headers. If the user writes in Sinhala, reply in natural Sinhala; otherwise
reply in the same language they used.

You have three tools available:
- save_memory: call this whenever the user tells you something worth
  remembering (a preference, a recurring task, a fact about their life).
  Keep saved facts short, third person (e.g. "User sleeps around 12:30am").
- get_current_datetime: call this whenever you need today's date or time.
- create_task_list: call this when the user gives you a goal or list of
  things they want tracked. Break it into short ordered steps. After
  calling it, tell the user you'll check in step-by-step right here on
  Telegram — don't say you'll do the steps yourself right now.`;

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

async function saveMemory(content) {
  const { error } = await supabase.from("agent_memories").insert({ content });
  return { saved: !error };
}

async function createTaskList(title, steps) {
  const { data: goal, error: goalErr } = await supabase.from("goals").insert({ title }).select().single();
  if (goalErr) return { created: false, reason: goalErr.message };
  const rows = steps.map((description, i) => ({ goal_id: goal.id, step_number: i + 1, description }));
  const { error: stepsErr } = await supabase.from("goal_steps").insert(rows);
  return { created: !stepsErr, goal_id: goal.id, steps_count: steps.length };
}

async function executeFunctionCall(fc) {
  if (fc.name === "save_memory") return await saveMemory(fc.args?.content || "");
  if (fc.name === "create_task_list") return await createTaskList(fc.args?.title || "Untitled goal", fc.args?.steps || []);
  if (fc.name === "get_current_datetime") {
    const now = new Date();
    return { iso: now.toISOString(), readable: now.toLocaleString() };
  }
  return { error: "unknown tool" };
}

async function callGemini(contents, systemInstruction) {
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
  return res.json();
}

async function handleChatMessage(userText) {
  const memories = await fetchRecentMemories();
  const systemInstruction = buildSystemInstruction(memories);
  let contents = [{ role: "user", parts: [{ text: userText }] }];

  for (let i = 0; i < 5; i++) {
    const data = await callGemini(contents, systemInstruction);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

    if (functionCalls.length === 0) {
      return textReply || "Sorry, I didn't catch that — try again?";
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

// ============================================================
// message router — decides: is this a step reply, or general chat?
// ============================================================
bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  if (!msg.text) return; // voice/files not handled yet
  const text = msg.text.trim();
  const lower = text.toLowerCase();

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

  // not a step reply — treat as general conversation
  bot.sendChatAction(CHAT_ID, "typing");
  const reply = await handleChatMessage(text);
  await bot.sendMessage(CHAT_ID, reply);
});
