// Night Agent Tasks Bot — standalone project
//
// Watches Supabase for goals created by the Night Agent orb app at night,
// and sends you ONE step at a time on Telegram. Only moves to the next
// step after you reply "ok" (or similar) to the current one.
//
// Required environment variables (set these in Railway, never in code):
//   TELEGRAM_BOT_TOKEN         (from BotFather)
//   SUPABASE_URL               (Project Settings > API)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings > API > service_role key)
//   NIGHT_AGENT_CHAT_ID        (your personal Telegram chat id)

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CHAT_ID = process.env.NIGHT_AGENT_CHAT_ID;

const YES_WORDS = ["ok", "okay", "yes", "done", "start", "ඔව්", "හරි", "කලා"];
const SKIP_WORDS = ["skip", "no", "later", "එපා", "පස්සේ"];

console.log("Night Agent Tasks Bot started.");

// Check every 30s whether it's time to send the next step
setInterval(checkAndSendNextStep, 30000);
checkAndSendNextStep();

bot.on("message", async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  const text = (msg.text || "").trim().toLowerCase();

  const { data: waiting } = await supabase
    .from("goal_steps")
    .select("*, goals!inner(title)")
    .eq("status", "awaiting_approval")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!waiting) return;

  if (YES_WORDS.includes(text)) {
    await supabase.from("goal_steps").update({ status: "done" }).eq("id", waiting.id);
    await maybeCompleteGoal(waiting.goal_id, waiting.goals.title);
    await bot.sendMessage(CHAT_ID, `✅ Done: ${waiting.description}`);
    checkAndSendNextStep();
  } else if (SKIP_WORDS.includes(text)) {
    await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", waiting.id);
    await bot.sendMessage(CHAT_ID, `⏭️ Skipped: ${waiting.description}`);
    checkAndSendNextStep();
  }
  // any other reply is ignored — treated as unrelated chat
});

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
