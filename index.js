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
//   GITHUB_TOKEN                   (a GitHub Personal Access Token — classic
//                                   PAT with 'repo' scope, or a fine-grained
//                                   PAT with Contents read/write + Admin
//                                   read/write on the repos you want the
//                                   bot to touch. Enables browsing repos,
//                                   reading/creating/editing/deleting files,
//                                   and creating new repos.)
//   GITHUB_USERNAME                (your GitHub username — used as the
//                                   default repo owner when you refer to a
//                                   repo by name only, e.g. "my-repo"
//                                   instead of "yourname/my-repo")
//   RAILWAY_API_TOKEN              (a Railway account or workspace token —
//                                   create one at railway.app/account/tokens.
//                                   Enables deploying a GitHub repo to
//                                   Railway, checking build/deploy status
//                                   and logs, redeploying after a fix, and
//                                   deleting projects. The target repo must
//                                   have Railway's GitHub App installed on
//                                   it first — do that once from the
//                                   Railway dashboard.)
//
// NEW features: voice message transcription (Telegram voice notes),
// document/photo upload with Gemini summary + auto Drive save, memory
// forget_memory/update_memory, morning digest (calendar+Gmail+weather+
// goals sent daily), deployed-website list/delete, and a self-tracked
// Gemini/Vercel usage counter with a proactive warning.


// ============================================================
// NEW in THIS update — SELF-EVOLVING AUTONOMOUS AGENT
// ============================================================
// The bot can now grow and repair itself without you touching code:
//
//  1. CUSTOM RUNTIME TOOLS — it can invent brand new tools for itself
//     (add_custom_tool), stored in Supabase so they survive restarts, and
//     callable immediately. Ask it "මේ tool එක නෑ නේද, හදාගන්න" and it
//     writes, validates, and installs the tool itself.
//  2. CREDENTIAL INBOX — paste a bare token / API key / MCP URL /
//     postgres:// connection string into the Telegram chat and it offers
//     (Yes/No button) to store it as a named secret or connect it as a
//     live MCP connector right away.
//  3. SELF-CODE-EDIT — read_own_code / update_own_code let it read and
//     rewrite its own source (button-confirmed, syntax-checked before
//     writing). With OWN_CODE_REPO set it commits to GitHub so Railway
//     redeploys it with the new code.
//  4. Optional shell access (run_shell_command) — only active when
//     AGENT_ENABLE_SHELL=true.
//
// Run once in the Supabase SQL editor:
//
//   create table if not exists agent_custom_tools (
//     name text primary key,
//     description text not null default '',
//     parameters_json text not null default '{"type":"OBJECT","properties":{}}',
//     code text not null,
//     enabled boolean not null default true,
//     created_at timestamptz not null default now(),
//     updated_at timestamptz not null default now()
//   );
//
//   create table if not exists agent_secrets (
//     key_name text primary key,
//     value text not null,
//     note text,
//     created_at timestamptz not null default now()
//   );
//
// NEW optional env vars:
//   OWN_CODE_REPO       (e.g. "yourname/night-agent-bot" — the GitHub repo
//                        Railway deploys THIS bot from; enables GitHub-based
//                        self-edits that auto-redeploy)
//   OWN_CODE_PATH       (file path of this file in that repo — default index.js)
//   AGENT_ENABLE_SHELL  ("true" enables the run_shell_command tool)

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

function gracefulShutdown(signal) {
  console.log(`⚠️ Received ${signal} signal`);
  if (bot) {
    try { bot.stopPolling(); } catch(e) {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// FIXED: only SIGTERM was handled — a local Ctrl+C (SIGINT) killed the
// process without stopping polling, which could leave Telegram's getUpdates
// lock held briefly and cause "409 Conflict: terminated by other getUpdates
// request" errors on the next start.
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
// LONG MESSAGE SENDER (NEW) — Telegram hard-caps sendMessage at 4096
// chars ("Bad Request: message is too long"). This splits any length
// of text into safe chunks instead of throwing/crashing. Existing
// bot.sendMessage() calls for short, fixed strings are left as-is;
// only the reply paths that can carry long/variable AI output are
// switched to this below.
// ============================================================
const TELEGRAM_SAFE_CHUNK = 4000; // headroom under Telegram's 4096 hard limit
const TELEGRAM_ABSOLUTE_CAP = 12000; // beyond this, truncate instead of spamming many chunks

function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Prefer splitting on a paragraph/line/word break before the limit so
    // we never cut a sentence or a Markdown entity (e.g. **bold**) in half.
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen; // no good break point nearby, hard-cut
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendLongMessage(chatId, text, options = {}) {
  if (!text) return;
  let content = String(text);
  if (content.length > TELEGRAM_ABSOLUTE_CAP) {
    content = content.slice(0, TELEGRAM_ABSOLUTE_CAP) + "\n\n… (response truncated — ask me for more detail on any part)";
  }
  const chunks = splitIntoChunks(content, TELEGRAM_SAFE_CHUNK);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.sendMessage(chatId, chunks[i], options);
    } catch (e) {
      // Markdown/entity parsing can occasionally break mid-split even with
      // the paragraph-aware cut above — fall back to plain text for that
      // chunk instead of losing it entirely.
      console.error(`⚠️ sendLongMessage chunk ${i + 1}/${chunks.length} failed (${e.message}), retrying as plain text`);
      try {
        await bot.sendMessage(chatId, chunks[i]);
      } catch (e2) {
        console.error(`❌ sendLongMessage plain-text retry also failed:`, e2.message);
      }
    }
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

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

// ============================================================
// GITHUB (browse/create/edit repos & files)
// ============================================================
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_DEFAULT_OWNER = process.env.GITHUB_USERNAME || "";

// ============================================================
// MCP (Model Context Protocol) — connects to external MCP servers
// (Postgres, Brave Search, etc.) and merges their tools into the same
// Gemini function-calling loop used for the hardcoded tools above. Each
// server only activates if its required env var(s) are set, same
// pattern as the other *_CONFIGURED flags in this file.
// ============================================================
// Get this from Supabase dashboard → Settings → Database → Connection
// string (URI, "Transaction" pooler mode recommended for a long-running
// process like this). This is DIFFERENT from SUPABASE_URL/SERVICE_ROLE_KEY
// above — those are for the REST client, this is a raw Postgres connection
// string (postgres://...).
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "";
// From https://api-dashboard.search.brave.com/ (free tier available) —
// gives web_search a real fallback if Gemini's grounding quota is hit.
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const GITHUB_CONFIGURED = !!GITHUB_TOKEN;
const GITHUB_API = "https://api.github.com";

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "night-agent-bot",
  };
}

async function githubFetch(path, opts = {}) {
  if (!GITHUB_CONFIGURED) return { error: true, message: "GitHub not connected (GITHUB_TOKEN missing)" };
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: { ...githubHeaders(), ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    return { error: true, status: res.status, message: (data && data.message) || `GitHub API error ${res.status}` };
  }
  return data;
}

function resolveOwnerRepo(repo) {
  // Accepts "repo-name" (uses default owner) or "owner/repo-name"
  if (!repo) return null;
  if (repo.includes("/")) {
    // FIXED: split("/") on an input with extra slashes (e.g. a pasted URL
    // like "github.com/owner/repo" or "owner/repo/extra") silently produced
    // a garbage owner/name and every call failed with a confusing 404.
    // Take the LAST two path segments as owner/repo.
    const parts = repo.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
  }
  if (!GITHUB_DEFAULT_OWNER) return null;
  return { owner: GITHUB_DEFAULT_OWNER, name: repo };
}

async function listGithubRepos(maxResults = 20) {
  const data = await githubFetch(`/user/repos?per_page=${Math.min(maxResults, 100)}&sort=updated`);
  if (data.error) return data;
  return {
    repos: (data || []).map((r) => ({
      name: r.full_name,
      private: r.private,
      description: r.description,
      default_branch: r.default_branch,
      updated_at: r.updated_at,
      url: r.html_url,
    })),
  };
}

async function searchGithubRepos(query, maxResults = 8) {
  const data = await githubFetch(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(maxResults, 20)}`);
  if (data.error) return data;
  return {
    repos: (data.items || []).map((r) => ({
      name: r.full_name,
      private: r.private,
      description: r.description,
      stars: r.stargazers_count,
      language: r.language,
      url: r.html_url,
    })),
  };
}

async function getGithubRepoTree(repo, path = "") {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo' or set GITHUB_USERNAME" };
  const data = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`);
  if (data.error) return data;
  const items = Array.isArray(data) ? data : [data];
  return {
    path: path || "/",
    entries: items.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size })),
  };
}

async function getGithubFileContent(repo, path) {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo' or set GITHUB_USERNAME" };
  const data = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`);
  if (data.error) return data;
  if (Array.isArray(data)) return { error: true, message: "That path is a directory, not a file" };
  const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf-8") : data.content;
  return { path: data.path, sha: data.sha, content, size: data.size };
}

async function createOrUpdateGithubFile(repo, path, content, commitMessage, branch) {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo' or set GITHUB_USERNAME" };
  // FIXED: GitHub's Contents API hard-rejects files over 1 MB with a
  // generic "content too large" error AFTER the whole base64 payload was
  // already built and sent. Fail fast with a clear message instead.
  if (Buffer.byteLength(content || "", "utf-8") > 1000000) {
    return { error: true, message: "File is over GitHub's 1 MB Contents API limit — split it into smaller files or use git directly." };
  }
  // Need the current sha if the file already exists (update) — a create on
  // an existing path without sha is rejected by GitHub's API.
  let sha;
  const existing = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${branch ? `?ref=${branch}` : ""}`);
  if (!existing.error && existing.sha) sha = existing.sha;
  const body = {
    message: commitMessage || `Update ${path} via Night Agent`,
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  const data = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (data.error) return data;
  return { saved: true, path, commit_url: data.commit?.html_url, sha: data.content?.sha };
}

async function deleteGithubFile(repo, path, commitMessage, branch) {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo' or set GITHUB_USERNAME" };
  const existing = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${branch ? `?ref=${branch}` : ""}`);
  if (existing.error) return existing;
  const body = { message: commitMessage || `Delete ${path} via Night Agent`, sha: existing.sha };
  if (branch) body.branch = branch;
  const data = await githubFetch(`/repos/${or.owner}/${or.name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
  if (data.error) return data;
  return { deleted: true, path };
}

async function createGithubRepo(name, description, isPrivate) {
  const data = await githubFetch(`/user/repos`, {
    method: "POST",
    body: JSON.stringify({ name, description: description || "", private: isPrivate !== false, auto_init: true }),
  });
  if (data.error) return data;
  return { created: true, name: data.full_name, url: data.html_url, default_branch: data.default_branch };
}

async function forkGithubRepo(repo, newName) {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo'" };
  const body = {};
  if (newName) body.name = newName;
  const data = await githubFetch(`/repos/${or.owner}/${or.name}/forks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (data.error) return data;
  // GitHub returns 202 immediately and forks asynchronously in the
  // background — the repo object it returns is usually usable right away,
  // but very large repos can take a few seconds to fully populate.
  return { forked: true, name: data.full_name, url: data.html_url, default_branch: data.default_branch, note: "Fork started — large repos can take a few seconds to fully populate." };
}

// ============================================================
// RAILWAY (deploy GitHub repos, get live URL, check status/logs,
// redeploy after a fix, delete projects)
// ============================================================
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || "";
const RAILWAY_CONFIGURED = !!RAILWAY_TOKEN;
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

async function railwayGraphQL(query, variables) {
  if (!RAILWAY_CONFIGURED) return { error: true, message: "Railway not connected (RAILWAY_API_TOKEN missing)" };
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${RAILWAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  let data;
  try { data = await res.json(); } catch (_) { return { error: true, message: `Railway API returned non-JSON (status ${res.status})` }; }
  if (data.errors && data.errors.length > 0) {
    return { error: true, message: data.errors.map((e) => e.message).join("; ") };
  }
  return data.data;
}

async function deployGithubRepoToRailway(repo, projectName) {
  const or = resolveOwnerRepo(repo);
  if (!or) return { error: true, message: "Repo not found — pass as 'owner/repo'" };
  const fullRepo = `${or.owner}/${or.name}`;
  const name = projectName || or.name;

  // Some Railway accounts (newer signups, or ones without an implicit
  // personal workspace) reject projectCreate with "You must specify a
  // workspaceId to create a project" unless one is passed explicitly.
  // Older/legacy accounts don't need this at all — so look it up and only
  // include it if the account actually has a workspace, rather than
  // assuming either way.
  const ws = await railwayGraphQL(`query { me { workspaces { id name } } }`, {});
  const workspaces = ws.error ? [] : (ws.me?.workspaces || []);
  const workspaceId = workspaces[0]?.id || null;

  const proj = await railwayGraphQL(
    `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`,
    { input: workspaceId ? { name, workspaceId } : { name } }
  );
  if (proj.error) {
    if (/workspaceId/i.test(proj.message) && !workspaceId) {
      return {
        ...proj,
        note: "This Railway account has no workspace at all (me.workspaces came back empty), so there's nothing to pass as workspaceId. Go to railway.app and create/select a workspace for this account first, then try again.",
      };
    }
    return proj;
  }
  const projectId = proj.projectCreate.id;

  // A default "production" environment is created automatically with the
  // project — fetch its id so we can attach the service to it.
  const envs = await railwayGraphQL(
    `query Environments($projectId: String!) { environments(projectId: $projectId) { edges { node { id name } } } }`,
    { projectId }
  );
  if (envs.error) return { ...envs, note: `Project "${name}" was created (id: ${projectId}) but fetching its environment failed — check it manually on railway.app.` };
  const environmentId = envs.environments?.edges?.[0]?.node?.id;
  if (!environmentId) return { error: true, message: "Project created but no default environment found", project_id: projectId };

  const svc = await railwayGraphQL(
    `mutation ServiceCreate($name: String, $projectId: String!, $environmentId: String!, $source: ServiceSourceInput, $branch: String) {
      serviceCreate(input: {name: $name, projectId: $projectId, environmentId: $environmentId, source: $source, branch: $branch}) { id name }
    }`,
    { name, projectId, environmentId, source: { repo: fullRepo } }
  );
  if (svc.error) return { ...svc, project_id: projectId, environment_id: environmentId, note: "Project created but the service failed to attach — this usually means Railway's GitHub App isn't installed/authorized on that repo yet (do that once at railway.app/account/connected-accounts)." };
  const serviceId = svc.serviceCreate.id;

  // ------------------------------------------------------------
  // AUTO PORT FIX — most of these repos are background bots/workers with
  // no HTTP server, so Railway has no port to attach a public domain to
  // and serviceDomainCreate always fails with "Problem processing
  // request", no matter how long we wait. Rather than editing the repo's
  // source, override the service's start command so a tiny health-check
  // HTTP server runs alongside the app's real start command. This is
  // Node-specific (these repos all are) and is skipped if the entry file
  // already looks like it opens its own server, to avoid a port clash.
  // ------------------------------------------------------------
  let portFixApplied = false;
  let portFixSkippedReason = null;
  try {
    const pkgFile = await getGithubFileContent(fullRepo, "package.json");
    if (pkgFile.error) {
      portFixSkippedReason = "no package.json found (not a Node project) — auto port-fix skipped";
    } else {
      const pkg = JSON.parse(pkgFile.content);
      const mainFile = pkg.main || "index.js";
      const hasStartScript = !!(pkg.scripts && pkg.scripts.start);
      const realStartCmd = hasStartScript ? "npm start" : `node ${mainFile}`;

      const entryFile = await getGithubFileContent(fullRepo, mainFile);
      const looksLikeItAlreadyServes =
        !entryFile.error &&
        /\.listen\s*\(|createServer\s*\(|express\s*\(/i.test(entryFile.content);

      if (looksLikeItAlreadyServes) {
        portFixSkippedReason = `${mainFile} already looks like it opens a server — left start command as-is`;
      } else {
        const wrapped = `sh -c "node -e 'require(\\"http\\").createServer((q,r)=>r.end(\\"ok\\")).listen(process.env.PORT||3000)' & ${realStartCmd}"`;
        const update = await railwayGraphQL(
          `mutation ServiceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
            serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
          }`,
          { serviceId, environmentId, input: { startCommand: wrapped } }
        );
        if (update.error) {
          portFixSkippedReason = `couldn't set start command (${update.message})`;
        } else {
          portFixApplied = true;
        }
      }
    }
  } catch (e) {
    portFixSkippedReason = `auto port-fix errored (${e.message})`;
  }

  // serviceCreate() only links the repo to the service — it does NOT start
  // a build. Without an explicit deploy trigger the service just sits there
  // with no deployment ever created. Fire it now, AFTER the start-command
  // override above (config changes don't take effect until the next
  // deploy) and BEFORE asking Railway for a domain: serviceDomainCreate
  // needs Railway to already know what port the service listens on, which
  // it only detects once a build/deployment exists.
  const deploy = await railwayGraphQL(
    `mutation Deploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId, environmentId }
  );

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Give Railway a moment to register the deployment and detect the port,
  // then try to generate the public domain. Retry a couple of times with
  // backoff since this can still race the deployment's own startup.
  let domain = { error: true, message: "not attempted" };
  for (const delayMs of [3000, 5000, 8000]) {
    await sleep(delayMs);
    domain = await railwayGraphQL(
      `mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { projectId, environmentId, serviceId } }
    );
    if (!domain.error) break;
  }

  const portFixNote = portFixApplied
    ? "🔌 Added a background health-check listener so Railway can attach a public domain."
    : portFixSkippedReason
    ? `🔌 Port auto-fix: ${portFixSkippedReason}.`
    : "";

  return {
    deployed: !deploy.error,
    project_id: projectId,
    environment_id: environmentId,
    service_id: serviceId,
    url: domain.error ? null : `https://${domain.serviceDomainCreate.domain}`,
    dashboard_url: `https://railway.app/project/${projectId}`,
    note: [
      deploy.error
        ? `⚠️ Service was created but triggering the build failed (${deploy.message}) — open the dashboard link above and click "Deploy" manually.`
        : domain.error
        ? `Building now — takes a minute or two. ⚠️ Couldn't auto-generate a public domain yet (${domain.message}) — the build may still be starting. Ask me to check again shortly, or open the dashboard link above → service → Networking → "Generate Domain" once the build finishes.`
        : "Building now — takes a minute or two. Use get_railway_deployment_status to check progress, and get_railway_deployment_logs if it fails.",
      portFixNote,
    ].filter(Boolean).join("\n"),
  };
}

async function getRailwayDeploymentStatus(environmentId) {
  const data = await railwayGraphQL(
    `query Env($id: String!) {
      environment(id: $id) {
        id name
        serviceInstances { edges { node { id serviceName latestDeployment { id status } } } }
      }
    }`,
    { id: environmentId }
  );
  if (data.error) return data;
  const env = data.environment;
  if (!env) return { error: true, message: "Environment not found" };
  return {
    environment: env.name,
    services: (env.serviceInstances?.edges || []).map((e) => ({
      service: e.node.serviceName,
      service_id: e.node.id,
      deployment_id: e.node.latestDeployment?.id,
      status: e.node.latestDeployment?.status,
    })),
  };
}

async function getRailwayDeploymentLogs(environmentId, filter) {
  const data = await railwayGraphQL(
    `query Logs($environmentId: String!, $filter: String) {
      environmentLogs(environmentId: $environmentId, filter: $filter) { timestamp message severity }
    }`,
    { environmentId, filter: filter || null }
  );
  if (data.error) return data;
  const logs = (data.environmentLogs || []).slice(-60); // most recent ~60 lines is plenty to spot an error
  return { logs: logs.map((l) => `[${l.severity}] ${l.message}`) };
}

// (NEW) Railway deployment states move INITIALIZING → BUILDING → DEPLOYING
// → SUCCESS/FAILED/CRASHED/REMOVED. Poll until a terminal state instead of
// trusting the "redeploy triggered" response — that response fires
// instantly and says nothing about whether the build actually succeeded.
const RAILWAY_TERMINAL_STATES = new Set(["SUCCESS", "FAILED", "CRASHED", "REMOVED"]);

async function waitForRailwayDeploymentReady(environmentId, serviceId, maxAttempts = 15, intervalMs = 6000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const statusData = await getRailwayDeploymentStatus(environmentId);
    if (statusData.error) continue; // transient API hiccup — just try again next loop
    const current = (statusData.services || []).find((s) => s.service_id === serviceId) || statusData.services?.[0];
    if (current && RAILWAY_TERMINAL_STATES.has(current.status)) {
      return { ready: true, status: current.status, deployment_id: current.deployment_id, allServices: statusData.services };
    }
  }
  return { ready: false, status: "TIMEOUT", reason: "Build didn't reach a final state within the expected time — check again shortly with get_railway_deployment_status." };
}

async function redeployRailwayService(serviceId, environmentId) {
  const data = await railwayGraphQL(
    `mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId, environmentId }
  );
  if (data.error) return data;

  // (NEW) Don't return until the build actually finishes — this is the
  // single most important fix for "it said it fixed it but didn't":
  // wait for a terminal status before telling the model (and therefore the
  // user) anything succeeded.
  const result = await waitForRailwayDeploymentReady(environmentId, serviceId);
  if (!result.ready) {
    return { redeployed: true, final_status: "STILL_BUILDING", note: result.reason };
  }
  if (result.status !== "SUCCESS") {
    return {
      redeployed: true,
      final_status: result.status,
      note: `⚠️ The redeploy finished in status "${result.status}", NOT success. Do not tell the user this is fixed. Call get_railway_deployment_logs now, find the real error, apply another fix with create_or_update_github_file, and redeploy again — repeat until final_status is SUCCESS.`,
    };
  }
  return {
    redeployed: true,
    final_status: "SUCCESS",
    note: "Verified: the deployment reached SUCCESS. Safe to tell the user it's fixed now.",
  };
}

async function setRailwayVariables(projectId, environmentId, serviceId, variables) {
  if (!variables || typeof variables !== "object" || Object.keys(variables).length === 0) {
    return { error: true, message: "No variables provided" };
  }
  const data = await railwayGraphQL(
    `mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { projectId, environmentId, serviceId, variables } }
  );
  if (data.error) return data;
  // (NEW) Railway auto-triggers a redeploy when service-scoped variables
  // change — wait for it to actually finish instead of just assuming it
  // worked, same fix as redeployRailwayService.
  const result = await waitForRailwayDeploymentReady(environmentId, serviceId);
  if (!result.ready) {
    return { variables_set: true, names: Object.keys(variables), final_status: "STILL_BUILDING", note: result.reason };
  }
  if (result.status !== "SUCCESS") {
    return {
      variables_set: true,
      names: Object.keys(variables),
      final_status: result.status,
      note: `⚠️ The auto-redeploy after this variable change finished in status "${result.status}", NOT success. Do not tell the user this is fixed — check get_railway_deployment_logs for the real error.`,
    };
  }
  return {
    variables_set: true,
    names: Object.keys(variables),
    final_status: "SUCCESS",
    note: "Verified: the auto-redeploy after this variable change reached SUCCESS.",
  };
}

async function deleteRailwayProject(projectId) {
  const data = await railwayGraphQL(
    `mutation ProjectDelete($id: String!) { projectDelete(id: $id) }`,
    { id: projectId }
  );
  if (data.error) return data;
  return { deleted: true, project_id: projectId };
}

async function listRailwayProjects() {
  const data = await railwayGraphQL(
    `query { projects { edges { node { id name } } } }`,
    {}
  );
  if (data.error) return data;
  return { projects: (data.projects?.edges || []).map((e) => e.node) };
}

async function debugRailwayConnection() {
  // Diagnostic-only, read-only, never touches the token itself — this
  // exists so a broken RAILWAY_API_TOKEN can be diagnosed FROM the token
  // that's actually loaded in this running process right now, instead of
  // guessing blind from the Railway dashboard. Answers two separate
  // questions that "Not Authorized" alone conflates: (1) did the process
  // actually pick up a new token after the last restart, and (2) is
  // whatever token it has valid.
  const masked = RAILWAY_TOKEN
    ? `${RAILWAY_TOKEN.slice(0, 6)}…${RAILWAY_TOKEN.slice(-4)} (length ${RAILWAY_TOKEN.length})`
    : "(empty — RAILWAY_API_TOKEN is not set on this process at all)";
  if (!RAILWAY_CONFIGURED) {
    return { configured: false, token_seen_by_process: masked };
  }
  // "me" is Railway's whoami query — it needs zero project/environment
  // context, so it isolates "is this token valid at all" from any
  // project-scope or permissions question.
  const whoami = await railwayGraphQL(`query { me { id name email } }`, {});
  return {
    configured: true,
    token_seen_by_process: masked,
    railway_api_reachable: !whoami.error,
    whoami: whoami.error ? null : whoami.me,
    raw_error: whoami.error ? whoami.message : null,
  };
}

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

// ============================================================
// MCP CLIENT MANAGER
// ============================================================
// @modelcontextprotocol/sdk is ESM-only — this file is CommonJS
// (require-based), so it's loaded with a dynamic import() instead of
// require(). Add it with: npm install @modelcontextprotocol/sdk
let _McpClient = null;
let _McpStdioTransport = null;
let _McpHttpTransport = null;
async function loadMcpSdk() {
  if (_McpClient) return true;
  try {
    const clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
    const stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
    _McpClient = clientMod.Client;
    _McpStdioTransport = stdioMod.StdioClientTransport;
    // Streamable HTTP transport — used for remote MCP connectors (added by
    // the user from the voice bot's UI, stored in Supabase). Loaded
    // separately/optionally so an older @modelcontextprotocol/sdk that
    // doesn't ship it yet doesn't break the existing stdio servers below.
    try {
      const httpMod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      _McpHttpTransport = httpMod.StreamableHTTPClientTransport;
    } catch (e2) {
      console.error("⚠️ Streamable HTTP MCP transport not available in this SDK version — remote MCP connectors (added via the voice bot UI) will be skipped:", e2.message);
    }
    return true;
  } catch (e) {
    console.error("⚠️ @modelcontextprotocol/sdk not installed — run `npm install @modelcontextprotocol/sdk` to enable MCP servers:", e.message);
    return false;
  }
}

// ------------------------------------------------------------
// DYNAMIC (DB-BACKED) MCP CONNECTORS
// ------------------------------------------------------------
// The voice bot's UI lets the user add/remove/toggle MCP connectors from a
// panel — those are stored in Supabase (table `mcp_connectors`, shared by
// both bots) instead of hardcoded here, so a connector added on one side
// shows up on the other without editing code. Run once in the Supabase SQL
// editor (safe to re-run):
//
//   create table if not exists mcp_connectors (
//     id text primary key,
//     label text not null,
//     type text not null default 'http',   -- 'http' (remote MCP server) or
//                                           -- 'stdio' (local process — e.g.
//                                           -- the Postgres MCP server —
//                                           -- Railway/this bot only, the
//                                           -- browser voice bot can't run
//                                           -- child processes)
//     url text,                            -- 'http' type: the MCP endpoint URL
//     auth_header text,                    -- 'http' type: optional, e.g. "Bearer xxx"
//     command text,                        -- 'stdio' type: e.g. "npx"
//     args text,                           -- 'stdio' type: space-separated args,
//                                           -- e.g. "-y @modelcontextprotocol/server-postgres postgresql://user:pass@host/db"
//     env_json text,                       -- 'stdio' type: optional JSON object of extra env vars
//     enabled boolean not null default true,
//     created_at timestamptz not null default now()
//   );
//   alter table mcp_connectors add column if not exists type text not null default 'http';
//   alter table mcp_connectors add column if not exists command text;
//   alter table mcp_connectors add column if not exists args text;
//   alter table mcp_connectors add column if not exists env_json text;
//   alter table mcp_connectors alter column url drop not null;
//
// 'http' connectors work from both this bot and the browser voice bot.
// 'stdio' connectors (a local command like `npx @modelcontextprotocol/
// server-postgres <connection-string>`) only ever run here — a database
// connection string, for example, is never a fetchable HTTP URL, so it
// belongs in a 'stdio' connector, not the 'http' one.
const dynamicMcpConnectorIds = new Set(); // connector ids currently connected
const dynamicMcpToolNames = {}; // connector id -> [prefixedToolName, ...] (for clean removal on disable/delete)

async function fetchMcpConnectorRows() {
  try {
    const { data, error } = await supabase.from("mcp_connectors").select("*");
    if (error) {
      // Table probably doesn't exist yet — not fatal, just means no
      // connectors have been added from the UI yet.
      return [];
    }
    return data || [];
  } catch (e) {
    return [];
  }
}

function removeDynamicConnectorTools(id) {
  const names = dynamicMcpToolNames[id] || [];
  for (const name of names) {
    delete mcpToolRegistry[name];
    const idx = mcpToolDeclarations.findIndex((d) => d.name === name);
    if (idx !== -1) mcpToolDeclarations.splice(idx, 1);
  }
  delete dynamicMcpToolNames[id];
  dynamicMcpConnectorIds.delete(id);
  const client = mcpClients[id];
  if (client) {
    try { client.close(); } catch (_) {}
    delete mcpClients[id];
  }
}

async function buildDynamicTransport(row) {
  const type = row.type || "http";
  if (type === "stdio") {
    const args = (row.args || "").trim().split(/\s+/).filter(Boolean);
    let extraEnv = {};
    if (row.env_json) {
      try { extraEnv = JSON.parse(row.env_json); } catch (e) { /* ignore bad json, connect with no extra env */ }
    }
    return new _McpStdioTransport({
      command: row.command || "npx",
      args,
      env: { ...process.env, ...extraEnv },
    });
  }
  if (!_McpHttpTransport) return null;
  const headers = {};
  if (row.auth_header) headers["Authorization"] = row.auth_header;
  return new _McpHttpTransport(new URL(row.url), { requestInit: { headers } });
}

async function connectDynamicConnector(row) {
  try {
    const transport = await buildDynamicTransport(row);
    if (!transport) return; // e.g. http type but streamable-http transport unavailable in this SDK
    const client = new _McpClient({ name: "night-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();

    mcpClients[row.id] = client;
    const names = [];
    for (const t of tools) {
      const prefixedName = `mcp_${row.id}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 63);
      mcpToolRegistry[prefixedName] = { serverId: row.id, client, originalName: t.name };
      mcpToolDeclarations.push({
        name: prefixedName,
        description: `[${row.label} MCP] ${t.description || t.name}`.slice(0, 1000),
        parameters: convertJsonSchemaToGemini(t.inputSchema),
      });
      names.push(prefixedName);
    }
    dynamicMcpToolNames[row.id] = names;
    dynamicMcpConnectorIds.add(row.id);
    console.log(`🔌 MCP connector connected: ${row.label} [${row.type || "http"}] (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`);
  } catch (e) {
    console.error(`⚠️ MCP connector "${row.label}" failed to connect:`, e.message);
  }
}

// Reconciles connected dynamic connectors against what's currently in
// Supabase — connects newly-added/re-enabled ones, disconnects
// removed/disabled ones. Called once at startup (after the static servers)
// and on a timer, so a connector added from the voice bot's UI comes
// online here without needing a manual Railway restart.
async function syncDynamicMcpConnectors() {
  const rows = await fetchMcpConnectorRows();
  const enabledIds = new Set(rows.filter((r) => r.enabled).map((r) => r.id));

  // Disconnect anything removed or disabled since the last sync.
  for (const id of Array.from(dynamicMcpConnectorIds)) {
    if (!enabledIds.has(id)) removeDynamicConnectorTools(id);
  }

  // Connect anything newly added/re-enabled.
  for (const row of rows) {
    if (row.enabled && !dynamicMcpConnectorIds.has(row.id)) {
      await connectDynamicConnector(row);
    }

  }
}

// Add a new entry here for each MCP server you want to connect — each
// runs as a local child process talking stdio (the standard way official
// MCP reference servers like these work), spawned via npx so no manual
// install step is needed on Railway.
const MCP_SERVER_CONFIGS = [
  {
    id: "postgres",
    label: "Supabase Postgres",
    enabled: !!SUPABASE_DB_URL,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", SUPABASE_DB_URL],
    env: {},
  },
  {
    id: "brave_search",
    label: "Brave Search",
    enabled: !!BRAVE_API_KEY,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY },
  },
];

const mcpClients = {}; // serverId -> connected Client instance
const mcpToolDeclarations = []; // merged into CHAT_TOOLS' functionDeclarations at call time
const mcpToolRegistry = {}; // gemini-safe tool name -> { serverId, client, originalName }

// MCP tools describe their parameters with standard JSON Schema; Gemini
// needs its own dialect (uppercase type names, no $schema/additionalProps
// etc.) — this converts recursively and drops anything Gemini doesn't
// understand instead of erroring the whole tool out.
function convertJsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== "object") return { type: "OBJECT", properties: {} };
  const typeMap = { object: "OBJECT", string: "STRING", number: "NUMBER", integer: "INTEGER", boolean: "BOOLEAN", array: "ARRAY" };
  const out = {};
  out.type = typeMap[schema.type] || "OBJECT";
  if (schema.description) out.description = String(schema.description).slice(0, 1000);
  // (FIX) Gemini requires enum entries to be strings — an MCP server's
  // JSON Schema can legally have enum values of any type (e.g. booleans),
  // which Gemini rejects outright and breaks EVERY tool call, not just
  // this one. Only keep enum on STRING fields, and coerce every value.
  if (Array.isArray(schema.enum) && out.type === "STRING") {
    out.enum = schema.enum.map((v) => String(v));
  }
  if (out.type === "OBJECT") {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties || {})) {
      out.properties[key] = convertJsonSchemaToGemini(val);
    }
    if (schema.required && schema.required.length) out.required = schema.required;
  }
  if (out.type === "ARRAY") {
    out.items = convertJsonSchemaToGemini(schema.items || { type: "string" });
  }
  return out;
}

async function initMcpServers() {
  const sdkReady = await loadMcpSdk();
  if (!sdkReady) return;

  const active = MCP_SERVER_CONFIGS.filter((c) => c.enabled);
  for (const cfg of active) {
    try {
      const transport = new _McpStdioTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...process.env, ...cfg.env },
      });
      const client = new _McpClient({ name: "night-agent", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();

      mcpClients[cfg.id] = client;
      for (const t of tools) {
        // Gemini tool names must be short and simple — prefix so names from
        // different MCP servers (or a hardcoded tool of the same name)
        // never collide.
        const prefixedName = `mcp_${cfg.id}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 63);
        mcpToolRegistry[prefixedName] = { serverId: cfg.id, client, originalName: t.name };
        mcpToolDeclarations.push({
          name: prefixedName,
          description: `[${cfg.label} MCP] ${t.description || t.name}`.slice(0, 1000),
          parameters: convertJsonSchemaToGemini(t.inputSchema),
        });
      }
      console.log(`🔌 MCP connected: ${cfg.label} (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`);
    } catch (e) {
      console.error(`⚠️ MCP server "${cfg.label}" failed to connect:`, e.message);
    }
  }

  // Connectors the user added from the voice bot's UI (Supabase-backed) —
  // connect whatever's there now, then keep re-checking on a timer so
  // newly added/removed/toggled connectors take effect without a manual
  // Railway restart.
  await syncDynamicMcpConnectors();
  setInterval(() => {
    syncDynamicMcpConnectors().catch((e) => console.error("⚠️ MCP connector sync error:", e.message));
  }, 5 * 60 * 1000);
}

async function callMcpTool(prefixedName, args) {
  const entry = mcpToolRegistry[prefixedName];
  if (!entry) return { error: `Unknown MCP tool: ${prefixedName}` };
  try {
    const result = await entry.client.callTool({ name: entry.originalName, arguments: args || {} });
    // MCP tool results come back as a content array of blocks (mostly
    // {type:"text", text:...}) — flatten to plain text for the model.
    const text = (result.content || [])
      .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
      .join("\n");
    if (result.isError) return { error: true, message: text || "MCP tool returned an error." };
    return { result: text || "(empty result)" };
  } catch (e) {
    return { error: true, message: e.message };
  }
}


// ============================================================
// SELF-EVOLUTION ENGINE (NEW)
// Custom tools the agent writes for itself at runtime — stored in
// Supabase (agent_custom_tools) so they survive restarts, registered into
// the same Gemini function-calling loop as every other tool, and
// executable through a small sandboxed runner.
// ============================================================
const customToolDeclarations = []; // Gemini tool declarations, merged at call time
const customToolRegistry = {}; // safeName -> { code }
const customToolNamesLoaded = new Set();

function registerCustomToolInMemory(name, description, parameters, code) {
  const safeName = String(name || "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
  if (!safeName) return null;
  let params;
  try { params = typeof parameters === "string" ? JSON.parse(parameters) : parameters; } catch (_) { params = { type: "object", properties: {} }; }
  const decl = {
    name: safeName,
    description: String(description || safeName).slice(0, 1000),
    parameters: convertJsonSchemaToGemini(params),
  };
  const existingIdx = customToolDeclarations.findIndex((d) => d.name === safeName);
  if (existingIdx !== -1) customToolDeclarations[existingIdx] = decl;
  else customToolDeclarations.push(decl);
  customToolRegistry[safeName] = { code: String(code || "") };
  customToolNamesLoaded.add(safeName);
  return safeName;
}

function unregisterCustomToolInMemory(name) {
  delete customToolRegistry[name];
  const idx = customToolDeclarations.findIndex((d) => d.name === name);
  if (idx !== -1) customToolDeclarations.splice(idx, 1);
  customToolNamesLoaded.delete(name);
}

// Compile-check a tool body before it is ever saved or run — a syntax
// error must never reach the DB or the live registry.
function validateCustomToolCode(code) {
  try {
    new Function("args", "ctx", `"use strict"; return (async () => { ${code} \n})();`);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Syntax error in tool code: ${e.message}` };
  }
}

async function saveCustomTool(name, description, parametersSchema, code) {
  if (!name || !code) return { saved: false, reason: "name and code are required." };
  const check = validateCustomToolCode(code);
  if (!check.ok) return { saved: false, reason: `${check.reason} The tool was NOT saved — fix the code and call add_custom_tool again.` };
  const safeName = String(name).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
  const paramsStr = typeof parametersSchema === "string" ? parametersSchema : JSON.stringify(parametersSchema || { type: "object", properties: {} });
  const { error } = await supabase.from("agent_custom_tools").upsert({
    name: safeName,
    description: description || safeName,
    parameters_json: paramsStr,
    code,
    enabled: true,
    updated_at: new Date().toISOString(),
  });
  if (error) return { saved: false, reason: `${error.message} (has the agent_custom_tools table been created? see setup notes at the top of this file)` };
  registerCustomToolInMemory(safeName, description, paramsStr, code);
  return { saved: true, name: safeName, note: "Tool is live right now — callable immediately, and it will survive restarts. If it throws when used, call add_custom_tool again with the same name and fixed code to overwrite it." };
}

async function deleteCustomTool(name) {
  if (!name) return { deleted: false, reason: "No name given." };
  const { error } = await supabase.from("agent_custom_tools").delete().eq("name", name);
  unregisterCustomToolInMemory(name);
  return { deleted: !error, name, reason: error?.message };
}

async function listCustomTools() {
  try {
    const { data, error } = await supabase.from("agent_custom_tools").select("name, description, enabled, updated_at").order("name");
    if (error) return { tools: [], reason: error.message };
    return { tools: data || [], live_in_this_process: Array.from(customToolNamesLoaded) };
  } catch (e) {
    return { tools: [], reason: e.message };
  }
}

async function loadCustomToolsFromDb() {
  try {
    const { data, error } = await supabase.from("agent_custom_tools").select("*").eq("enabled", true);
    if (error) {
      // Table probably doesn't exist yet — not fatal.
      if (!/does not exist|relation/i.test(error.message || "")) console.error("loadCustomToolsFromDb error:", error.message);
      return;
    }
    for (const row of data || []) {
      if (customToolNamesLoaded.has(row.name)) continue;
      const check = validateCustomToolCode(row.code);
      if (!check.ok) {
        console.error(`⚠️ Custom tool "${row.name}" skipped (${check.reason})`);
        continue;
      }
      registerCustomToolInMemory(row.name, row.description, row.parameters_json, row.code);
    }
    if ((data || []).length > 0) console.log(`🧩 Custom tools loaded: ${Array.from(customToolNamesLoaded).join(", ") || "none valid"}`);
  } catch (e) {
    console.error("loadCustomToolsFromDb error:", e.message);
  }
}

// ---- named secrets store (agent_secrets) ----
// Values are write-only from the model's perspective: it can store and
// list names, but the value is only ever read inside a running custom
// tool via ctx.getSecret() — never echoed back into chat.
async function getSecret(keyName) {
  try {
    const { data } = await supabase.from("agent_secrets").select("value").eq("key_name", keyName).maybeSingle();
    return data?.value || null;
  } catch (_) {
    return null;
  }
}

async function saveSecret(keyName, value, note) {
  const clean = String(keyName || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!clean || !value) return { saved: false, reason: "key_name and value are both required." };
  const { error } = await supabase.from("agent_secrets").upsert({ key_name: clean, value: String(value).trim(), note: note || null });
  return { saved: !error, key_name: clean, reason: error?.message };
}

async function listSecrets() {
  try {
    const { data, error } = await supabase.from("agent_secrets").select("key_name, note, created_at").order("key_name");
    if (error) return { secrets: [], reason: error.message };
    return {
      secrets: (data || []).map((s) => ({ key_name: s.key_name, note: s.note })),
      note: "Values are never shown — read them inside a custom tool with ctx.getSecret(key_name).",
    };
  } catch (e) {
    return { secrets: [], reason: e.message };
  }
}

// ---- custom tool runner ----
async function runCustomTool(name, args) {
  const entry = customToolRegistry[name];
  if (!entry) return { error: true, message: `Unknown custom tool: ${name}` };
  const ctx = {
    fetch: fetchWithTimeout,
    getSecret,
    saveSecret,
    saveMemory,
    supabase,
    nowInTimezone,
    env: process.env,
    log: (...a) => console.log(`[custom:${name}]`, ...a),
  };
  try {
    const fn = new Function("args", "ctx", `"use strict"; return (async () => { ${entry.code} \n})();`);
    const timeoutMs = 45000;
    const result = await Promise.race([
      Promise.resolve(fn(args || {}, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Custom tool "${name}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    if (result === undefined || result === null) {
      return { result: "(tool finished without returning anything — always return an object describing the outcome)" };
    }
    if (typeof result === "string") return { result: result.slice(0, 8000) };
    return JSON.parse(JSON.stringify(result).slice(0, 8000));
  } catch (e) {
    return { error: true, message: `Custom tool "${name}" threw: ${e.message}. You wrote this tool — fix it by calling add_custom_tool again with the same name and corrected code.` };
  }
}

// ============================================================
// AGENT-MANAGED MCP CONNECTORS (NEW)
// Same Supabase `mcp_connectors` table the dynamic-connector sync above
// already reads — these wrappers let the MODEL add/remove/list connectors
// itself (e.g. when the user pastes an MCP URL into chat), and connect
// them immediately instead of waiting for the 5-minute sync.
// ============================================================
async function agentAddMcpConnector(opts) {
  opts = opts || {};
  const id = String(opts.label || "connector").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `conn_${Date.now()}`;
  const type = opts.type || (opts.url ? "http" : "stdio");
  if (type === "http" && !opts.url) return { added: false, reason: "An 'http' connector needs a url." };
  if (type === "stdio" && !opts.command) return { added: false, reason: "A 'stdio' connector needs a command (e.g. 'npx') plus args." };
  const row = {
    id,
    label: opts.label || id,
    type,
    url: opts.url || null,
    auth_header: opts.auth_header || null,
    command: opts.command || null,
    args: opts.args || null,
    env_json: opts.env_json || null,
    enabled: true,
  };
  const { error } = await supabase.from("mcp_connectors").upsert(row);
  if (error) return { added: false, reason: `${error.message} (has the mcp_connectors table been created? see setup notes near the MCP section)` };
  const sdkReady = await loadMcpSdk();
  if (sdkReady) await connectDynamicConnector(row);
  const connected = dynamicMcpConnectorIds.has(id);
  return {
    added: true,
    id,
    connected_now: connected,
    tools_available: connected ? (dynamicMcpToolNames[id] || []) : [],
    note: connected
      ? "Connector is live — its tools are callable right now."
      : "Saved but not connected yet — it will retry on the 5-minute sync (check logs for the connection error).",
  };
}

async function agentRemoveMcpConnector(idOrLabel) {
  if (!idOrLabel) return { removed: false, reason: "No id or label given." };
  const rows = await fetchMcpConnectorRows();
  const match = rows.find((r) => r.id === idOrLabel || String(r.label).toLowerCase() === String(idOrLabel).toLowerCase());
  if (!match) return { removed: false, reason: `No connector matching "${idOrLabel}".` };
  const { error } = await supabase.from("mcp_connectors").delete().eq("id", match.id);
  if (!error) removeDynamicConnectorTools(match.id);
  return { removed: !error, id: match.id, reason: error?.message };
}

async function agentListMcpConnectors() {
  const rows = await fetchMcpConnectorRows();
  return {
    connectors: rows.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type || "http",
      enabled: r.enabled,
      connected_now: dynamicMcpConnectorIds.has(r.id),
      tools: dynamicMcpToolNames[r.id] || [],
    })),
  };
}

// ============================================================
// SELF CODE EDITING (NEW) — the bot reads/rewrites its own source file
// ============================================================
const OWN_CODE_REPO = process.env.OWN_CODE_REPO || ""; // e.g. "yourname/night-agent-bot"
const OWN_CODE_PATH = process.env.OWN_CODE_PATH || "index.js";

async function readOwnCode() {
  if (OWN_CODE_REPO && GITHUB_CONFIGURED) {
    return await getGithubFileContent(OWN_CODE_REPO, OWN_CODE_PATH);
  }
  try {
    const fs = require("fs");
    const content = fs.readFileSync(__filename, "utf-8");
    return { path: __filename, content, size: content.length };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

async function writeOwnCode(newContent, commitMessage) {
  if (!newContent || newContent.length < 5000) {
    return { error: true, message: "Refusing to write — content missing or suspiciously short (a COMPLETE replacement file is expected, not a fragment). Read the current file with read_own_code first, apply your change, and send the full file back." };
  }
  // Parse-check before writing anything — never commit code that can't run.
  try {
    new (require("vm").Script)(newContent);
  } catch (e) {
    return { error: true, message: `Refusing to write — the new code has a syntax error: ${e.message}. Fix it and try again.` };
  }
  if (OWN_CODE_REPO && GITHUB_CONFIGURED) {
    const res = await createOrUpdateGithubFile(OWN_CODE_REPO, OWN_CODE_PATH, newContent, commitMessage || "Self-update by Night Agent");
    if (res.saved) {
      return {
        saved: true,
        where: "github",
        commit_url: res.commit_url,
        note: "Committed to the repo. If Railway auto-deploys on push, the new code goes live shortly — verify with get_railway_deployment_status and use redeploy_railway_service if needed.",
      };
    }
    return res;
  }
  try {
    const fs = require("fs");
    fs.writeFileSync(__filename, newContent, "utf-8");
    return { saved: true, where: "local", note: `Wrote to ${__filename}. The new code runs after the next process restart.` };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// ============================================================
// OPTIONAL SHELL ACCESS (NEW) — only active when AGENT_ENABLE_SHELL=true
// ============================================================
const SHELL_ENABLED = process.env.AGENT_ENABLE_SHELL === "true";

async function runShellCommand(command) {
  if (!SHELL_ENABLED) {
    return { error: true, message: "Shell access is disabled. Set AGENT_ENABLE_SHELL=true in the environment variables and restart the bot to enable it." };
  }
  if (!command) return { error: true, message: "No command given." };
  return await new Promise((resolve) => {
    require("child_process").exec(command, { timeout: 60000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      resolve({
        command,
        ok: !err,
        exit_code: err ? err.code : 0,
        stdout: String(stdout || "").slice(0, 6000),
        stderr: String(stderr || "").slice(0, 4000),
      });
    });
  });
}

// ============================================================
// CREDENTIAL INBOX (NEW)
// Detects tokens / API keys / MCP URLs / connection strings pasted into
// the chat and offers (button-confirmed) to store or connect them.
// ============================================================
const CREDENTIAL_PATTERNS = [
  { kind: "postgres_url", re: /postgres(?:ql)?:\/\/[^\s"'<>]+/i },
  { kind: "mcp_url", re: /https?:\/\/[^\s"'<>]*\b(mcp|sse)\b[^\s"'<>]*/i },
  { kind: "jwt", re: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
  { kind: "api_token", re: /\b(?:sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|[A-Za-z0-9_\-]{32,})\b/ },
];

function detectCredentialsInText(text) {
  if (!text || text.length > 2000) return [];
  const found = [];
  for (const p of CREDENTIAL_PATTERNS) {
    const m = text.match(p.re);
    if (m) found.push({ kind: p.kind, value: m[0] });
  }
  // A message that is basically just a URL is likely an MCP endpoint.
  if (found.length === 0) {
    const bare = text.trim().match(/^https?:\/\/[^\s"'<>]+$/i);
    if (bare) found.push({ kind: "bare_url", value: bare[0] });
  }
  const seen = new Set();
  return found.filter((f) => (seen.has(f.value) ? false : seen.add(f.value)));
}

function guessSecretName(text, kind) {
  const firstSpecial = text.search(/postgres|https?|eyJ|sk-|ghp_|github_pat_|AIza|xox/i);
  const before = firstSpecial > 0 ? text.slice(0, firstSpecial) : text;
  const words = before.match(/[A-Za-z][A-Za-z0-9_ ]{1,30}/g);
  if (words && words.length) {
    const cand = words[words.length - 1].trim().replace(/^(the|a|my|this|here|is|here's|token|key|api|for|use|connect|add|mcp|connector)\s*/gi, "").trim();
    if (cand) return cand.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40) + "_KEY";
  }
  return `${String(kind).toUpperCase()}_${Date.now().toString(36).toUpperCase()}`;
}

async function applyDetectedCredentials(payload) {
  const results = [];
  for (const item of (payload && payload.found) || []) {
    try {
      if (item.kind === "postgres_url") {
        const r = await agentAddMcpConnector({
          label: "Postgres DB",
          type: "stdio",
          command: "npx",
          args: `-y @modelcontextprotocol/server-postgres ${item.value}`,
        });
        results.push(r.connected_now
          ? `🐘 Postgres MCP connector connected — tools live now (${(r.tools_available || []).length} tools).`
          : `🐘 Postgres connector saved (${r.reason || r.note || "will retry on the next sync"}).`);
      } else if (item.kind === "mcp_url" || item.kind === "bare_url") {
        let host = "remote-mcp";
        try { host = new URL(item.value).hostname; } catch (_) {}
        const r = await agentAddMcpConnector({ label: host, type: "http", url: item.value });
        results.push(r.connected_now
          ? `🔌 MCP connector "${r.id}" connected — ${(r.tools_available || []).length} tools live now.`
          : `🔌 MCP connector saved (${r.reason || r.note || "will retry on the next sync"}).`);
      } else {
        const name = guessSecretName((payload && payload.text) || "", item.kind);
        const r = await saveSecret(name, item.value, `Provided via Telegram chat (${item.kind})`);
        if (r.saved) {
          await saveMemory(`A credential named ${r.key_name} was provided via Telegram chat and stored in agent_secrets.`);
          results.push(`🔐 Stored as secret "${r.key_name}" — custom tools can use it via ctx.getSecret("${r.key_name}").`);
        } else {
          results.push(`⚠️ Couldn't store the secret: ${r.reason}`);
        }
      }
    } catch (e) {
      results.push(`⚠️ Failed handling a detected credential: ${e.message}`);
    }
  }
  return results.join("\n") || "Nothing to do.";
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
- deploy_website: write a BRAND NEW single-page website FROM SCRATCH using
  a text description (3D/animated pages included, via three.js) and
  deploy it live to Vercel — returns a real public URL. Only available if
  Vercel is connected. This tool now waits for the build to finish AND
  fetches the link itself to confirm it actually loads (not stuck behind
  Vercel's login wall) before returning — if it returns deployed:false,
  the link is genuinely not working yet, so say so plainly, don't claim
  success anyway. This can take up to ~60-90s; mention that when you
  report the link.
  ⚠️ Do NOT use this for a repo that already exists (forked, cloned, or
  one of the user's own) — it writes fresh AI-generated code from your
  description and ignores whatever is actually in the repo, so the
  result will NOT be the user's actual project. If the user has already
  forked/created/mentioned a specific GitHub repo and says "deploy it" /
  "deploy that", they mean deploy_github_repo_to_railway with THAT repo,
  never deploy_website. Only use deploy_website when they're explicitly
  asking you to build something new that doesn't exist yet.
- deploy_multipage_website: same idea as deploy_website but for a
  genuinely BIGGER site — real separate HTML pages with their own
  filenames/URLs (e.g. /login.html, /dashboard.html) and a real nav bar
  between them, sharing one consistent design. Use this whenever the user
  describes multiple distinct pages/sections, or says something like
  "bigger site", "multiple pages", "login page and dashboard", etc. — not
  deploy_website, which only produces one page. Same build-then-verify
  behavior as deploy_website; returns the home URL plus each page's URL.
  This is plain static HTML per page (no React/build step), so it stays
  reliable — don't promise a full React/Router/framework app through
  this tool, it's multi-page static, not a single-page app.
- list_deployed_sites: list websites you've deployed to Vercel, with URLs.
- delete_deployed_site: permanently take down a deployed website
  (button-confirmed) — get the project name/id from list_deployed_sites.
- forget_memory: delete a specific saved fact that's wrong/outdated
  (button-confirmed) — get its id from recall_memories or search_memories.
- update_memory: correct a specific saved fact in place — get its id from
  recall_memories or search_memories first.
- get_usage_stats: check today's self-tracked Gemini call count and Vercel
  deploy count, to gauge how close to free-tier limits things are.
- list_github_repos / search_github_repos: browse your own GitHub repos, or
  search all of GitHub for a repo matching a description (good template).
- get_github_repo_tree / get_github_file_content: browse a repo's files and
  read a specific file's content.
- create_or_update_github_file: create a new file or overwrite an existing
  one, committing straight to the repo. Runs immediately, no confirmation
  needed — this is the tool you use mid debug-loop to actually apply a fix,
  so use it and move on to the next step, don't just describe the fix.
- delete_github_file (button-confirmed): delete a file, committing the change.
- fork_github_repo (button-confirmed): fork someone else's public repo
  (e.g. "owner/repo") into your own GitHub account.
- create_github_repo (button-confirmed): create a brand new GitHub repo.
- deploy_github_repo_to_railway (button-confirmed): deploy an EXISTING
  GitHub repo (forked, cloned, or the user's own — identified by name,
  e.g. "owner/repo") to Railway and get back a live public URL running
  that repo's actual code. This is the correct tool whenever the user
  refers to a specific repo and asks to deploy/host/run it — not
  deploy_website. Only available if Railway is connected
  (RAILWAY_API_TOKEN set). Requires Railway's GitHub App to already be
  installed/authorized on the target repo (one-time setup the user does
  at railway.app) — if the service creation step fails, that's almost
  always why.
- get_railway_deployment_status / get_railway_deployment_logs: check
  whether a deployment succeeded, and pull the actual error text when it
  didn't. ALWAYS read the logs before guessing what's wrong — don't
  speculate about the bug from the repo alone.
- redeploy_railway_service: trigger a fresh deploy after fixing code.
  (NEW) This now WAITS for the build to actually finish (up to ~90s)
  before returning — it will not give you back control until it has a
  real final_status: "SUCCESS", "FAILED", "CRASHED", or "STILL_BUILDING"
  (rare timeout case). This is deliberate: you cannot claim something is
  fixed based on the commit alone anymore, only based on this field.
- set_railway_variables: set env vars on a Railway service. Runs
  immediately, no separate confirmation — the checkpoint is that you must
  ALWAYS ask the user for the real value first and wait for their reply.
  NEVER invent, guess, or reuse a value for a secret/token/key/password.
  Once they give it, actually call the tool right then — don't just say
  you will. (NEW) This also now waits for the auto-triggered redeploy to
  finish and returns the same final_status field as redeploy_railway_service.
  PROACTIVE DEBUG LOOP — don't wait to be asked, and don't defer this to
  "check back later" — with the wait now built into the tools, you can
  and should finish the whole loop in this same turn:
  If deploy_github_repo_to_railway itself failed at the service-creation
  step (before a build even starts), that's a PERMISSION problem, not a
  code/logs problem — Railway's GitHub App isn't authorized on that repo
  yet. Tell the user plainly: go to railway.app/account/connected-accounts
  and authorize/install the Railway GitHub App for that repo (one-time,
  per repo), then ask them to say "try again" — then retry
  deploy_github_repo_to_railway yourself. Don't try to work around this
  with logs/code fixes, it isn't one.
  Once a build has actually started (via deploy_github_repo_to_railway,
  redeploy_railway_service, or set_railway_variables) and its final_status
  comes back:
    - final_status "SUCCESS" → genuinely fixed, tell the user it's live.
    - final_status "FAILED" / "CRASHED" → NOT fixed, regardless of
      whether you just committed a change. Immediately:
        1. get_railway_deployment_logs → find the actual NEW error (it
           may be a different error than before — don't assume your
           previous fix was even on the right track, read fresh).
        2. If it's a missing/wrong env var → tell the user exactly what's
           missing and ask for the value → set_railway_variables once
           given (this already waits + reports final_status).
        3. If it's a code bug → get_github_file_content on the relevant
           file → create_or_update_github_file with the fix →
           redeploy_railway_service (already waits + reports final_status).
        4. Repeat this whole cycle for as many rounds as it takes within
           this turn. Only stop and hand back to the user if you're
           blocked on something only they can provide (a secret value, a
           permission step) — in which case say exactly what you need,
           don't say "I'll handle it."
    - final_status "STILL_BUILDING" (timeout) → genuinely uncertain, say
      so and call get_railway_deployment_status again shortly — don't
      claim success OR failure here.
  If you genuinely can't tell what's wrong from the logs after a real
  attempt, say so plainly and show the relevant log lines instead of
  guessing.
  If you truly can't finish the whole loop in one turn (multiple rounds
  needed and you're running low on turns, or you're waiting on a value or
  permission step from the user), call create_task_list to register it as
  a goal (e.g. title "Fix tharunprabashwara642-dot/X Railway deployment"),
  so your background tick picks it up and keeps working on it — tell the
  user it'll follow up automatically in a few minutes (the tick runs
  roughly every 7 minutes), not "in a few seconds".
  TRUST YOUR OWN TOOL RESULTS — don't fall back to a templated response
  that contradicts what a tool call you JUST made actually returned. If
  debug_railway_connection (or any diagnostic call) comes back showing
  things are actually fine (e.g. railway_api_reachable: true with a real
  whoami), do not turn around and repeat "go create a new token" anyway —
  that specific fix is already proven unnecessary by your own result.
  Instead reason from what genuinely still fails: read the raw_error /
  actual next failing call and explain THAT, or say plainly you're not
  sure what's still wrong and show the exact data instead of guessing.
  Never re-issue advice your own most recent tool call just disproved.
  Never claim "Success" / "fixed" / "it's live" unless a
  redeploy_railway_service, set_railway_variables, or
  get_railway_deployment_status call you just made — in this turn or a
  prior one — returned final_status/status exactly "SUCCESS".
- list_railway_projects / delete_railway_project (button-confirmed):
  list your Railway projects, or permanently delete one (all services,
  deployments, and its live URL — irreversible).
  Only available if GitHub is connected (GITHUB_TOKEN set). For your own
  repos you can pass just the repo name; GITHUB_USERNAME is used as the
  default owner. For other people's public repos, pass "owner/repo".
- debug_railway_connection: diagnostic, read-only, use whenever Railway
  auth is failing. See the CREDENTIAL / AUTHORIZATION FAILURES section
  below for exactly when and how to use it.

CREDENTIAL / AUTHORIZATION FAILURES — if a Railway, GitHub, or Google tool
call comes back with an auth-shaped error (e.g. "Not Authorized",
"authorization error", 401/403, "token" mentioned as invalid/expired), that
is YOUR OWN token failing at the platform level (RAILWAY_API_TOKEN,
GITHUB_TOKEN, or Google OAuth credentials) — it is completely different
from a broken deployment's logs and NOT something a code fix or a retry
can solve. You cannot fix this yourself by calling more Railway/GitHub API
tools — if the token itself is what's broken, EVERY call using that same
token fails the same way, including set_railway_variables, so you can
never use your own tools to patch your own broken credential. NEVER say
"I'll fix the connection" or "I'll sort out the authorization and check
again shortly" — that promise is impossible for you to keep and just
repeats the "said I'd fix it, never did" problem. Instead, in the same
turn:
  - Railway: call debug_railway_connection FIRST — it shows the masked
    token this process actually has loaded right now plus a raw
    project-independent whoami result, so the user finds out whether the
    process ever restarted with the new token, versus the token being
    loaded but genuinely invalid, instead of guessing. Then tell the user
    plainly: go to railway.app → Account Settings → Tokens → create a new
    token → update the RAILWAY_API_TOKEN environment variable wherever
    this bot itself is hosted → the bot needs an actual restart/redeploy
    (not just a save) to pick it up — check the Deployments tab for a
    fresh deployment timestamp to confirm the restart really happened.
  - GitHub: the GITHUB_TOKEN (personal access token) has likely expired
    or been revoked → generate a new one at github.com/settings/tokens →
    update it the same way.
  - Google: OAuth credentials need reconnecting — this usually means
    re-running whatever auth/setup flow was used originally.
Don't retry the same call hoping it resolves itself, and don't move on to
other unrelated tasks as if this one's handled — a dead credential blocks
everything downstream of it, so say so clearly and stop there.

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
that's likely to fix it.

SELF-EVOLUTION — you can extend and repair yourself, and you SHOULD:
- add_custom_tool: whenever the user asks for a capability you don't have
  ("you don't have this tool, make it"), or you keep needing something no
  existing tool does, WRITE the tool yourself — a unique snake_case name,
  a one-line description, a JSON parameters schema (lowercase type names:
  object/string/number/integer/boolean/array), and a JavaScript async body.
  The body runs with 'args' (the call arguments) and 'ctx' in scope:
  ctx.fetch(url, options) — timeout-wrapped fetch; ctx.getSecret(key_name)
  and ctx.saveSecret(key_name, value) — the named secrets store;
  ctx.supabase — the database client; ctx.saveMemory(text); ctx.env;
  ctx.log(...). Always 'return' an object describing the outcome. The tool
  is syntax-checked, saved to the database, and callable immediately —
  including from your own autonomous tick. If it throws when called, fix
  the code and call add_custom_tool again with the same name to overwrite.
- save_secret / list_secrets: store API keys/tokens the user gives you
  under a clear name, and check which secret names already exist (values
  are never shown back to you — tools read them via ctx.getSecret).
- add_mcp_connector / remove_mcp_connector / list_mcp_connectors: when the
  user pastes an MCP server URL (http type) or a local command like a
  database connection string (stdio type, e.g. command "npx", args
  "-y @modelcontextprotocol/server-postgres <postgres-url>"), connect it
  yourself — its tools merge into your tool list immediately.
- read_own_code / update_own_code (button-confirmed): read and rewrite
  your OWN source file when a bug in you needs fixing or a hardcoded
  capability needs changing. Always read_own_code first, make the minimal
  change, keep everything else intact, and send back the COMPLETE file.
  If OWN_CODE_REPO is configured it commits to GitHub and Railway
  redeploys you with the new code; otherwise it writes the local file for
  the next restart.
- run_shell_command (button-confirmed): run a shell command on your own
  host for diagnostics — only works if AGENT_ENABLE_SHELL=true.
When the user pastes a bare token, key, or connector URL with no other
context, the system usually intercepts it and offers to store/connect it
automatically — if you see that happen, just briefly confirm what's being
done with it.`;

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
        description: "Write a BRAND NEW single-page website (HTML/CSS/JS, including 3D or animated pages via three.js if asked) from a text description, and deploy it live to Vercel. Returns a real public URL, verified to actually load before reporting success. Use for a simple one-page site/demo/landing page. For a site with multiple distinct sections the user wants as real separate pages (e.g. a login page, dashboard, settings — each with its own URL), use deploy_multipage_website instead. Do NOT use this for an existing GitHub repo (forked or the user's own) — that ignores the repo's real code. For an existing repo, use deploy_github_repo_to_railway instead.",
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
        name: "deploy_multipage_website",
        description: "Write and deploy a BRAND NEW multi-page static website — genuinely separate HTML pages with their own real filenames/URLs (e.g. /login.html, /dashboard.html) linked by a real nav bar, sharing one consistent design. Use this instead of deploy_website whenever the user describes multiple distinct pages/sections (landing + login + dashboard + settings, etc.) or explicitly asks for 'a bigger site' / 'multiple pages' / real navigation between pages. Not a React/build-step app — plain static HTML/CSS/JS pages, which deploys reliably without needing a build to succeed. Returns a real public URL for the home page plus a list of each other page's URL, verified to actually load before reporting success.",
        parameters: {
          type: "OBJECT",
          properties: {
            description: { type: "STRING", description: "What the overall site should be, look like, and do — as detailed as the user gave it." },
            project_name: { type: "STRING", description: "Short slug-friendly name for the site. Optional — derived from the description if omitted." },
            pages: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Names of the pages to generate, e.g. [\"Home\",\"Login\",\"Dashboard\",\"Settings\"]. First one becomes the homepage (index.html). Optional — defaults to Home/Login/Dashboard/Settings if omitted. Keep to 8 or fewer pages since they're all generated in one pass.",
            },
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
        name: "list_github_repos",
        description: "List your GitHub repositories (most recently updated first).",
        parameters: {
          type: "OBJECT",
          properties: { max_results: { type: "NUMBER", description: "Max repos to return. Defaults to 20." } },
        },
      },
      {
        name: "search_github_repos",
        description: "Search public GitHub repos (any owner) to find a repo matching a description — useful for finding a good template/starting point.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search terms, e.g. 'telegram bot node.js supabase'." },
            max_results: { type: "NUMBER", description: "Max results. Defaults to 8." },
          },
          required: ["query"],
        },
      },
      {
        name: "get_github_repo_tree",
        description: "List files/folders at a path in a GitHub repo (like browsing the repo).",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo as 'owner/name', or just 'name' if it's your own repo." },
            path: { type: "STRING", description: "Folder path. Leave empty for repo root." },
          },
          required: ["repo"],
        },
      },
      {
        name: "get_github_file_content",
        description: "Read the contents of a specific file in a GitHub repo.",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo as 'owner/name', or just 'name' if it's your own repo." },
            path: { type: "STRING", description: "File path, e.g. 'src/index.js'." },
          },
          required: ["repo", "path"],
        },
      },
      {
        name: "create_or_update_github_file",
        description: "Create a new file or overwrite an existing file in a GitHub repo, committing the change directly.",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo as 'owner/name', or just 'name' if it's your own repo." },
            path: { type: "STRING", description: "File path to write, e.g. 'src/index.js'." },
            content: { type: "STRING", description: "Full new content of the file." },
            commit_message: { type: "STRING", description: "Commit message. Optional." },
            branch: { type: "STRING", description: "Branch name. Optional, defaults to the repo's default branch." },
          },
          required: ["repo", "path", "content"],
        },
      },
      {
        name: "delete_github_file",
        description: "Delete a file from a GitHub repo, committing the change.",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo as 'owner/name', or just 'name' if it's your own repo." },
            path: { type: "STRING", description: "File path to delete." },
            commit_message: { type: "STRING", description: "Commit message. Optional." },
            branch: { type: "STRING", description: "Branch name. Optional." },
          },
          required: ["repo", "path"],
        },
      },
      {
        name: "fork_github_repo",
        description: "Fork someone else's public GitHub repo into your own account, so you have your own copy to edit/deploy.",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo to fork, as 'owner/name' (e.g. 'zxcloli666/AI-Worker-Proxy')." },
            new_name: { type: "STRING", description: "Optional new name for the forked copy. Defaults to the original name." },
          },
          required: ["repo"],
        },
      },
      {
        name: "create_github_repo",
        description: "Create a brand new GitHub repository under your account.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Repo name." },
            description: { type: "STRING", description: "Short repo description. Optional." },
            is_private: { type: "BOOLEAN", description: "Whether the repo should be private. Defaults to true." },
          },
          required: ["name"],
        },
      },
      {
        name: "deploy_github_repo_to_railway",
        description: "Deploy an EXISTING GitHub repo (e.g. one you've forked or the user's own) to Railway and get back a live public URL that runs the repo's actual code. Use this — never deploy_website — whenever the user names a specific repo and asks to deploy/host/run it. Only available if Railway is connected (RAILWAY_API_TOKEN set). The repo must already have Railway's GitHub App installed/authorized on it (one-time setup at railway.app).",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Repo as 'owner/name'." },
            project_name: { type: "STRING", description: "Optional Railway project name. Defaults to the repo name." },
          },
          required: ["repo"],
        },
      },
      {
        name: "get_railway_deployment_status",
        description: "Check the build/deploy status of a Railway environment (e.g. Building, Deploying, Success, Failed, Crashed) for every service in it.",
        parameters: {
          type: "OBJECT",
          properties: { environment_id: { type: "STRING", description: "The Railway environment ID (returned by deploy_github_repo_to_railway)." } },
          required: ["environment_id"],
        },
      },
      {
        name: "get_railway_deployment_logs",
        description: "Fetch recent build/runtime logs for a Railway environment — use this to find the actual error when a deployment fails, before editing code.",
        parameters: {
          type: "OBJECT",
          properties: {
            environment_id: { type: "STRING", description: "The Railway environment ID." },
            filter: { type: "STRING", description: "Optional text filter, e.g. 'error' or a service name." },
          },
          required: ["environment_id"],
        },
      },
      {
        name: "redeploy_railway_service",
        description: "Trigger a fresh Railway deployment of a service from its latest commit — use after pushing a fix via create_or_update_github_file. Waits for the build to actually finish (up to ~90s) and returns a real final_status (SUCCESS/FAILED/CRASHED/STILL_BUILDING) — do not report success to the user unless final_status is exactly SUCCESS.",
        parameters: {
          type: "OBJECT",
          properties: {
            service_id: { type: "STRING", description: "The Railway service ID." },
            environment_id: { type: "STRING", description: "The Railway environment ID." },
          },
          required: ["service_id", "environment_id"],
        },
      },
      {
        name: "set_railway_variables",
        description: "Set one or more environment variables on a Railway service (button-confirmed). Use this when deploy logs show a missing or wrong env var — ALWAYS ask the user for the actual value first, never invent or guess a secret/token/key yourself. Setting variables auto-triggers a redeploy; this tool waits for that redeploy to finish and returns a real final_status (SUCCESS/FAILED/CRASHED/STILL_BUILDING) — do not report success unless final_status is exactly SUCCESS.",
        parameters: {
          type: "OBJECT",
          properties: {
            project_id: { type: "STRING", description: "The Railway project ID." },
            service_id: { type: "STRING", description: "The Railway service ID." },
            environment_id: { type: "STRING", description: "The Railway environment ID." },
            variables: {
              type: "OBJECT",
              description: "Key-value map of env var names to values, e.g. {\"TELEGRAM_BOT_TOKEN\": \"123:abc\"}.",
            },
          },
          required: ["project_id", "service_id", "environment_id", "variables"],
        },
      },
      {
        name: "list_railway_projects",
        description: "List your Railway projects with their IDs.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "debug_railway_connection",
        description: "Diagnose a Railway 'Not Authorized' problem. Returns a masked view of the RAILWAY_API_TOKEN this running process actually has loaded right now (or confirms it's empty), plus the raw result of a project-independent whoami call. Use this FIRST whenever Railway auth is failing, instead of guessing — it tells you whether the process ever picked up a token change at all, versus the token being loaded but invalid.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "delete_railway_project",
        description: "Permanently delete a Railway project and everything in it (all services, deployments, the live URL).",
        parameters: {
          type: "OBJECT",
          properties: { project_id: { type: "STRING", description: "The Railway project ID (from list_railway_projects or deploy_github_repo_to_railway)." } },
          required: ["project_id"],
        },
      },
      {
        name: "get_usage_stats",
        description: "Check today's Gemini API call count and Vercel deploy count, so you know how close to free-tier limits things are. These are self-tracked counts, not a live pull from Google/Vercel's dashboards.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "add_custom_tool",
        description: "Create (or overwrite) a brand new tool for yourself at runtime. Use whenever the user asks for a capability you don't have yet ('make this tool'), or you keep needing something no existing tool does. You supply a unique snake_case name, a one-line description, a JSON parameters schema, and a JavaScript async body that runs with `args` and `ctx` (ctx.fetch, ctx.getSecret, ctx.saveSecret, ctx.supabase, ctx.saveMemory, ctx.env, ctx.log) in scope and must return an object. The tool is syntax-checked, persisted, and callable immediately — including from your autonomous tick. Same name overwrites, so use this to FIX a broken custom tool too.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Unique snake_case tool name, e.g. 'get_crypto_price'." },
            description: { type: "STRING", description: "One line on what the tool does and when to use it." },
            parameters_schema: { type: "STRING", description: "JSON string of the parameters schema using lowercase type names, e.g. {\"type\":\"object\",\"properties\":{\"coin\":{\"type\":\"string\"}},\"required\":[\"coin\"]}. Use {\"type\":\"object\",\"properties\":{}} for no arguments." },
            code: { type: "STRING", description: "JavaScript async body with `args` and `ctx` in scope; must return an object. Example: const res = await ctx.fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'); const data = await res.json(); return { price_usd: data.bitcoin.usd };" },
          },
          required: ["name", "description", "code"],
        },
      },
      {
        name: "delete_custom_tool",
        description: "Permanently remove one of your own custom runtime tools by name.",
        parameters: {
          type: "OBJECT",
          properties: { name: { type: "STRING", description: "The custom tool's name." } },
          required: ["name"],
        },
      },
      {
        name: "list_custom_tools",
        description: "List the custom tools you have created for yourself, and which are live in this process right now.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "save_secret",
        description: "Store an API key/token/credential the user gives you under a clear UPPER_SNAKE name (e.g. OPENWEATHER_API_KEY). Custom tools read it later with ctx.getSecret(name). Values are never shown back.",
        parameters: {
          type: "OBJECT",
          properties: {
            key_name: { type: "STRING", description: "UPPER_SNAKE name for the credential." },
            value: { type: "STRING", description: "The secret value." },
            note: { type: "STRING", description: "Optional note on what it's for." },
          },
          required: ["key_name", "value"],
        },
      },
      {
        name: "list_secrets",
        description: "List the names (never the values) of stored credentials, so you know which ctx.getSecret names are available when writing a custom tool.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "add_mcp_connector",
        description: "Connect a new MCP server yourself — use when the user pastes an MCP server URL (type 'http') or a local command such as a database connection string (type 'stdio', e.g. command 'npx', args '-y @modelcontextprotocol/server-postgres <postgres-url>'). Saved to Supabase and connected immediately; its tools join your tool list right away.",
        parameters: {
          type: "OBJECT",
          properties: {
            label: { type: "STRING", description: "Human label, e.g. 'Notion MCP'." },
            type: { type: "STRING", description: "One of: http, stdio. Defaults to http when a url is given." },
            url: { type: "STRING", description: "http type: the MCP endpoint URL." },
            auth_header: { type: "STRING", description: "http type: optional Authorization header value, e.g. 'Bearer xxx'." },
            command: { type: "STRING", description: "stdio type: executable, e.g. 'npx'." },
            args: { type: "STRING", description: "stdio type: space-separated args string." },
            env_json: { type: "STRING", description: "stdio type: optional JSON object string of extra env vars." },
          },
          required: ["label"],
        },
      },
      {
        name: "remove_mcp_connector",
        description: "Disconnect and delete an MCP connector by its id or label.",
        parameters: {
          type: "OBJECT",
          properties: { id_or_label: { type: "STRING", description: "Connector id or label (from list_mcp_connectors)." } },
          required: ["id_or_label"],
        },
      },
      {
        name: "list_mcp_connectors",
        description: "List all MCP connectors (saved and currently-connected) with their tool names.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "read_own_code",
        description: "Read your own complete source file (this bot's code) — always do this before update_own_code so you edit the real current code, not a guess.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "update_own_code",
        description: "Rewrite your own source file with a COMPLETE new version (button-confirmed, syntax-checked before writing). Use to fix a bug in yourself or add/change a hardcoded capability. Always read_own_code first, change only what's needed, keep everything else intact. With OWN_CODE_REPO configured it commits to GitHub so Railway redeploys you; otherwise it writes the local file for the next restart.",
        parameters: {
          type: "OBJECT",
          properties: {
            new_content: { type: "STRING", description: "The COMPLETE new source file content — not a fragment or diff." },
            commit_message: { type: "STRING", description: "Short description of the change." },
          },
          required: ["new_content"],
        },
      },
      {
        name: "run_shell_command",
        description: "Run a shell command on your own host for diagnostics (button-confirmed). Only works if AGENT_ENABLE_SHELL=true; returns stdout/stderr/exit_code.",
        parameters: {
          type: "OBJECT",
          properties: { command: { type: "STRING", description: "The shell command to run." } },
          required: ["command"],
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

// (NEW) Executes exactly ONE goal step for real — calls tools itself
// instead of asking the user to go do it and reply "ok". Runs its own
// short tool-calling loop scoped to just this step's description.
async function runGoalStep(goal, step) {
  const stepInstruction = BASE_SYSTEM_INSTRUCTION + `

You are autonomously executing ONE step of a multi-step goal, unattended —
the user is not watching this turn. Do not ask questions and do not just
describe what you would do — call the tool(s) that actually do it. If the
step is already effectively done or genuinely needs info only the user has,
say so plainly in your final text reply instead of guessing.

Goal: "${goal.title}"
This step (step ${step.step_number}): "${step.description}"`;

  let contents = [{ role: "user", parts: [{ text: `Execute this step now: ${step.description}` }] }];
  const MAX_STEP_ROUNDS = 6;
  const goalContext = { goalId: goal.id, stepId: step.id, title: goal.title };

  for (let i = 0; i < MAX_STEP_ROUNDS; i++) {
    let data;
    try {
      data = await callGemini(contents, stepInstruction);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (data.error) return { ok: false, reason: data.error.message || JSON.stringify(data.error) };

    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();

    if (functionCalls.length === 0) {
      return { ok: true, summary: textReply || "Done." };
    }

    contents.push({ role: "model", parts });
    const responseParts = [];
    let hitConfirmation = false;
    for (const fc of functionCalls) {
      const result = await executeFunctionCall(fc, goalContext);
      if (result && result.status === "pending_confirmation") hitConfirmation = true;
      responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });

    // A sensitive tool got queued behind a Yes/No button — stop this step
    // here rather than looping further. The confirm/cancel callback below
    // resumes the rest of the goal once the user taps a button.
    if (hitConfirmation) return { ok: null, needsConfirmation: true };
  }
  return { ok: true, summary: "Step actions completed." };
}

// (NEW) Walks every pending step of a goal in order, actually doing each
// one and posting a progress message after each — "✅ step N/M done, now
// step N+1" — instead of the old behavior of pinging the user every 30s to
// go do the step themselves and reply "ok"/"skip". Fire-and-forget: call
// this without awaiting so the triggering chat reply returns immediately.
// goalIds currently being driven by an in-flight runGoalAutonomously loop —
// shared by every trigger site (immediate kickoff, confirm/cancel resume,
// and the stalled-goal safety net) so the same goal never gets two loops
// racing each other and double-executing a step.
const trackedActiveGoals = new Set();

function kickOffGoal(goalId, title) {
  if (trackedActiveGoals.has(goalId)) return;
  trackedActiveGoals.add(goalId);
  runGoalAutonomously(goalId, title)
    .catch((e) => console.error("runGoalAutonomously error:", e.message))
    .finally(() => trackedActiveGoals.delete(goalId));
}

async function runGoalAutonomously(goalId, title) {
  try {
    for (let guard = 0; guard < 50; guard++) { // hard cap — a buggy goal can't loop forever
      const { data: nextStep } = await supabase
        .from("goal_steps")
        .select("*")
        .eq("goal_id", goalId)
        .eq("status", "pending")
        .order("step_number", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!nextStep) break;

      const { data: allSteps } = await supabase
        .from("goal_steps")
        .select("step_number")
        .eq("goal_id", goalId);
      const total = allSteps ? allSteps.length : "?";

      const result = await runGoalStep({ id: goalId, title }, nextStep);

      if (result.needsConfirmation) {
        await bot.sendMessage(
          CHAT_ID,
          `⏸️ "${title}" — step ${nextStep.step_number}/${total} needs your confirmation before I continue (button above 👆).`
        );
        await sendConfirmationButtons();
        return; // resumes via the confirm/cancel callback_query handler
      }

      if (result.ok === false) {
        await supabase.from("goal_steps").update({ status: "failed" }).eq("id", nextStep.id);
        await bot.sendMessage(
          CHAT_ID,
          `⚠️ "${title}" — step ${nextStep.step_number}/${total} failed: ${result.reason || "unknown error"}. Stopped here — tell me how you'd like to proceed.`
        );
        return;
      }

      await supabase.from("goal_steps").update({ status: "done" }).eq("id", nextStep.id);
      const msg = `✅ "${title}" — step ${nextStep.step_number}/${total} done: ${nextStep.description}${result.summary ? `\n${result.summary}` : ""}`;
      await bot.sendMessage(CHAT_ID, msg);
      await logBotMessage("agent", msg);
    }

    await maybeCompleteGoal(goalId, title);
  } catch (e) {
    console.error("runGoalAutonomously error:", e.message);
    try {
      await bot.sendMessage(CHAT_ID, `⚠️ "${title}" — something went wrong while working through the steps: ${e.message}`);
    } catch (_) {}
  }
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
// (NEW) Vercel enables "Vercel Authentication" (Deployment Protection) by
// default on every new project — this is exactly why previously deployed
// links showed a Vercel login wall / blank screen instead of the actual
// site. Call this right after creating a deployment so the project (and
// its production URL) becomes genuinely public. Best-effort: logs and
// continues if it fails, since some account types don't need/support it.
async function disableVercelProtection(projectIdOrName) {
  try {
    const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
    const res = await fetchWithTimeout(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectIdOrName)}${teamQuery}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ssoProtection: null }),
      },
      20000
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(`⚠️ disableVercelProtection failed for ${projectIdOrName}: ${data.error?.message || res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`⚠️ disableVercelProtection error for ${projectIdOrName}:`, e.message);
    return false;
  }
}

// (NEW) Deploys report success the instant Vercel *accepts* the files —
// that's not the same as the site actually being live. Poll the real
// build status and then do one real fetch, so we only ever tell the user
// "done" once the link genuinely loads (state READY, HTTP 200, not a
// Vercel login redirect).
async function waitForVercelDeploymentReady(deploymentId, maxAttempts = 12, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchWithTimeout(
        `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}` } },
        15000
      );
      const data = await res.json();
      if (data.readyState === "READY") return { ready: true, state: "READY" };
      if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
        return { ready: false, state: data.readyState, reason: data.errorMessage || `Build ended in state ${data.readyState}` };
      }
      // still BUILDING/QUEUED/INITIALIZING — wait and check again
    } catch (e) {
      console.error("waitForVercelDeploymentReady poll error:", e.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ready: false, state: "TIMEOUT", reason: "Build didn't finish within the expected time — check Vercel dashboard." };
}

async function verifyUrlIsPublic(url) {
  try {
    const res = await fetchWithTimeout(url, { redirect: "follow" }, 20000);
    const finalUrl = res.url || url;
    if (finalUrl.includes("vercel.com/login") || finalUrl.includes("vercel.com/sso-api")) {
      return { ok: false, reason: "Still behind Vercel's login wall — deployment protection wasn't fully disabled." };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `Site returned ${res.status} (protected/blocked).` };
    }
    if (!res.ok) {
      return { ok: false, reason: `Site returned HTTP ${res.status}.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Couldn't verify the URL loads: ${e.message}` };
  }
}

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

    // (NEW) Make the project actually public — Vercel enables Deployment
    // Protection by default on every new project, which is what caused
    // previous "done" links to show a Vercel login wall / blank screen.
    await disableVercelProtection(slug);

    // (NEW) Don't report success until the build genuinely finished.
    const buildStatus = await waitForVercelDeploymentReady(result.id);
    if (!buildStatus.ready) {
      return { deployed: false, reason: `Build didn't complete: ${buildStatus.reason}`, url, note: "The build failed or didn't finish — this link is NOT safe to share yet." };
    }

    // (NEW) One real fetch to confirm the link actually loads publicly —
    // catches leftover protection, DNS propagation delay, or any other
    // reason the site wouldn't really be reachable, instead of just
    // trusting Vercel's "accepted" response.
    const liveCheck = await verifyUrlIsPublic(url);
    if (!liveCheck.ok) {
      return { deployed: false, reason: `Deployed but not publicly reachable yet: ${liveCheck.reason}`, url, note: "Try list_deployed_sites again in a minute, or check Vercel dashboard → Settings → Deployment Protection." };
    }

    // Save this as a real fact — without it, asking "what's the status" in a
    // later message has nothing to go on and the model was re-triggering a
    // whole new deploy instead of just answering with the existing link.
    await saveMemory(`Deployed a website — "${description}" — live at ${url} (Vercel project: ${slug})`);
    incrementUsage("vercel_deploys");
    return { deployed: true, url, project: slug, note: "Verified: build finished and the link loads publicly (not behind Vercel login)." };
  } catch (e) {
    console.error("deployWebsite error:", e.message);
    return { deployed: false, reason: e.name === "AbortError" ? "Vercel deploy request timed out." : e.message };
  }
}

// (NEW) For "bigger" site requests — genuinely separate pages with real
// filenames/URLs (e.g. /login.html, /dashboard.html), not one HTML file
// with div-toggled sections. Still deploys as a plain static site (no
// build step, same reliable Vercel "files" API as deployWebsite) so it
// stays fast and doesn't depend on a build pipeline succeeding.
async function deployMultiPageWebsite(description, projectName, pageNames) {
  if (!VERCEL_CONFIGURED) return { deployed: false, reason: "Vercel not connected (VERCEL_API_TOKEN missing)" };
  if (!description) return { deployed: false, reason: "No description given for the site." };

  const pages = (Array.isArray(pageNames) && pageNames.length > 0
    ? pageNames
    : ["Home", "Login", "Dashboard", "Settings"]
  ).slice(0, 8); // cap — this is one Gemini call generating all pages at once, keep it realistic

  const fileNameFor = (name, isFirst) => {
    if (isFirst || /^home$/i.test(name)) return "index.html";
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + ".html";
  };
  const pageFiles = pages.map((name, i) => ({ name, file: fileNameFor(name, i === 0) }));

  let filesMap;
  try {
    const codePrompt = `Design and write a genuinely multi-page static website for this request: "${description}"

Pages needed (use exactly these filenames, one real HTML page per page — no build step, no framework):
${pageFiles.map((p) => `- ${p.name} → ${p.file}`).join("\n")}

Requirements:
- Output a SHARED "style.css" file first, then each page's HTML file. Every HTML page must link it with <link rel="stylesheet" href="style.css">.
- Every page needs a real <nav> with working relative links to every OTHER page (e.g. <a href="dashboard.html">) — this must be genuine multi-page navigation, not JS-toggled sections on one page.
- Keep design consistent across all pages: same color palette, typography, header/nav style. Make it genuinely polished — deliberate colors, real spacing, smooth hover states — not a generic template look.
- If 3D/animation is wanted, use three.js from https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js (r128 API only — no OrbitControls, no CapsuleGeometry; use SphereGeometry/CylinderGeometry/custom geometry instead), loaded per-page via inline <script> in that page's HTML.
- Everything must work opened as static files — no server, no build.

Output format — respond with ONLY this, no explanation before/after, no markdown fences:
=== FILE: style.css ===
<the css content>
=== FILE: ${pageFiles[0].file} ===
<the full html for this page, starting at <!DOCTYPE html>>
=== FILE: ${pageFiles[1] ? pageFiles[1].file : "..."} ===
<...continue for every page listed above...>`;

    const data = await fetchGeminiRotating(
      (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: codePrompt }] }] }),
      },
    );
    if (data.error) return { deployed: false, reason: `Code generation failed: ${data.error.message}` };
    const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();

    // Parse the "=== FILE: name ===" blocks into { filename: content }
    filesMap = {};
    const blocks = raw.split(/=== FILE:\s*(.+?)\s*===/g).slice(1); // [name, content, name, content, ...]
    for (let i = 0; i < blocks.length; i += 2) {
      const fname = blocks[i].trim();
      const content = (blocks[i + 1] || "").replace(/^```(html|css)?\s*/i, "").replace(/```\s*$/, "").trim();
      if (fname && content) filesMap[fname] = content;
    }
    const missingPages = pageFiles.filter((p) => !filesMap[p.file]);
    if (Object.keys(filesMap).length === 0 || missingPages.length === pageFiles.length) {
      return { deployed: false, reason: "The model didn't return usable multi-file output — try rephrasing or fewer pages." };
    }
    if (missingPages.length > 0) {
      console.error(`⚠️ deployMultiPageWebsite: missing pages from model output: ${missingPages.map((p) => p.file).join(", ")}`);
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
        files: Object.entries(filesMap).map(([file, data]) => ({ file, data })),
        projectSettings: { framework: null },
        target: "production",
      }),
    }, 60000);
    const result = await res.json();
    if (result.error) return { deployed: false, reason: result.error.message || JSON.stringify(result.error) };
    const url = result.url ? `https://${result.url}` : (result.alias?.[0] ? `https://${result.alias[0]}` : null);
    if (!url) return { deployed: false, reason: "Vercel didn't return a deployment URL." };

    await disableVercelProtection(slug);

    const buildStatus = await waitForVercelDeploymentReady(result.id);
    if (!buildStatus.ready) {
      return { deployed: false, reason: `Build didn't complete: ${buildStatus.reason}`, url, note: "This link is NOT safe to share yet." };
    }

    const liveCheck = await verifyUrlIsPublic(url);
    if (!liveCheck.ok) {
      return { deployed: false, reason: `Deployed but not publicly reachable yet: ${liveCheck.reason}`, url };
    }

    const pageUrls = pageFiles.filter((p) => filesMap[p.file]).map((p) => `${url}/${p.file === "index.html" ? "" : p.file}`);
    await saveMemory(`Deployed a multi-page website — "${description}" — live at ${url} (Vercel project: ${slug}), pages: ${pageFiles.map((p) => p.name).join(", ")}`);
    incrementUsage("vercel_deploys");
    return {
      deployed: true,
      url,
      project: slug,
      pages: pageUrls,
      note: "Verified: build finished and the link loads publicly. This is a real multi-page static site — each page below has its own URL.",
    };
  } catch (e) {
    console.error("deployMultiPageWebsite error:", e.message);
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

// (NEW) Don't spam a Telegram message every single time a search fails —
// only nudge the user once per cooldown window so repeated tool calls in
// one multi-step task don't flood the chat.
let lastSearchFailNotify = 0;
const SEARCH_FAIL_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

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
    if (data.error) throw new Error(data.error.message);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
    return { result: text || "No useful results found." };
  } catch (e) {
    // (NEW) fetchGeminiRotating already tried every key in the pool before
    // throwing here — if grounding is out of quota on all of them, that's
    // very likely a project-level grounding quota (shared across keys on
    // the same Google Cloud project), not a per-key RPM issue. Log it
    // clearly and let the agent keep answering without live search instead
    // of the whole turn failing.
    console.error(`⚠️ webSearch failed after trying all ${API_KEYS.length} keys — likely shared grounding quota, not per-key rate limit: ${e.message}`);
    const now = Date.now();
    if (now - lastSearchFailNotify > SEARCH_FAIL_NOTIFY_COOLDOWN_MS) {
      lastSearchFailNotify = now;
      try {
        await bot.sendMessage(CHAT_ID, `⚠️ Web search දැනට available නෑ (${e.message}) — search නැතුව continue කරනවා.`);
      } catch (_) {}
    }
    return { result: null, reason: `Search unavailable right now (${e.message}). Answer from existing knowledge without live search results, and tell the user you couldn't verify this with a live search.` };
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
  "deploy_multipage_website",
  "forget_memory",
  "delete_deployed_site",
  "delete_github_file",
  "create_github_repo",
  "fork_github_repo",
  "deploy_github_repo_to_railway",
  "delete_railway_project",
  // (NEW) self-evolution actions that change the system itself or run
  // arbitrary code are gated behind a Yes/No tap.
  "delete_custom_tool",
  "add_mcp_connector",
  "remove_mcp_connector",
  "update_own_code",
  "run_shell_command",
  // create_or_update_github_file and set_railway_variables are
  // intentionally NOT button-gated. They're the two actions the deploy
  // debug-loop needs to actually apply a fix, and gating them meant every
  // automated fix silently stalled on an unclicked Yes/No button while the
  // model kept telling the user "fixing it now" — i.e. it looked broken
  // even though the tool calls were correct. The natural checkpoints stay
  // in place instead: set_railway_variables is only ever called after the
  // user has been asked for and supplied the actual value, and
  // create_or_update_github_file only ever fires as part of a debug loop
  // the user explicitly asked for.
]);

let pendingConfirmations = []; // [{ id, toolName, args, description, buttonsSent }]
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
    case "deploy_multipage_website": {
      const shortDesc = (args.description || "").length > 300 ? args.description.slice(0, 300) + "…" : args.description;
      const pageList = (args.pages || ["Home", "Login", "Dashboard", "Settings"]).join(", ");
      return `🌐 Multi-page website එකක් හදලා deploy කරන්නද — "${shortDesc}"? Pages: ${pageList}. (build + verify කරන නිසා ටිකක් වෙලා යනවා)`;
    }
    case "forget_memory": return `🧠 මතකයෙන් අයින් කරන්නද (id: ${args.memory_id})?`;
    case "delete_deployed_site": return `🗑️ Website "${args.project}" delete කරන්නද? (live link එක නවත්තනවා)`;
    case "create_or_update_github_file": return `💻 GitHub — "${args.repo}" repo එකේ "${args.path}" file එක commit කරන්නද?`;
    case "delete_github_file": return `🗑️ GitHub — "${args.repo}" repo එකේ "${args.path}" file එක delete කරන්නද?`;
    case "create_github_repo": return `📦 නව GitHub repo එකක් "${args.name}" හදන්නද?`;
    case "fork_github_repo": return `🍴 "${args.repo}" repo එක ඔයාගේ account එකට fork කරන්නද?`;
    case "deploy_github_repo_to_railway": return `🚂 "${args.repo}" repo එක Railway එකට deploy කරන්නද? (නව project එකක් හදනවා, live URL එකක් ලැබෙනවා)`;
    case "delete_railway_project": return `🗑️ Railway project (id: ${args.project_id}) එක සහ ඒකේ services/deployments/URL එක සම්පූර්ණයෙන්ම delete කරන්නද? මේක undo කරන්න බෑ.`;
    case "set_railway_variables": {
      const names = Object.keys(args.variables || {}).join(", ");
      return `🔧 Railway service එකට මේ env variables set කරන්නද — ${names}?`;
    }
    case "delete_custom_tool": return `🧩 Custom tool "${args.name}" එක delete කරන්නද?`;
    case "add_mcp_connector": return `🔌 MCP connector "${args.label}" connect කරන්නද (${args.type || "http"}${args.url ? ": " + args.url : ""})?`;
    case "remove_mcp_connector": return `🔌 MCP connector "${args.id_or_label}" disconnect කරලා delete කරන්නද?`;
    case "update_own_code": return `🛠️ මගේම source code එක rewrite කරන්නද? (${args.commit_message || "self-update"})`;
    case "run_shell_command": return `💻 මගේ host එකේ මේ command එක run කරන්නද — \`${String(args.command || "").slice(0, 120)}\`?`;
    default: return `මේ action එක කරන්නද?`;
  }
}

async function sendConfirmationButtons() {
  // Send a button for every queued confirmation that hasn't been sent yet.
  // This used to operate on a single global slot, which meant a second
  // sensitive action queued while the first was still in flight (e.g. the
  // autonomous background tick firing mid-conversation) would silently
  // overwrite the first one before its button ever went out. A queue means
  // nothing gets dropped, regardless of what else is running concurrently.
  for (const pc of pendingConfirmations) {
    if (pc.buttonsSent) continue;
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
      // the next call retries the real button.
      try {
        await bot.sendMessage(CHAT_ID, `⚠️ Confirm button එක යවන්න බැරි වුනා (${e.message}). "ok" කියලා reply කරන්න, ආයෙත් try කරන්නම්.`);
      } catch (_) {}
    }
  }
}

async function runToolDirectly(name, args) {
  args = args || {};
  if (name === "save_memory") return await saveMemory(args.content || "");
  if (name === "create_task_list") {
    const result = await createTaskList(args.title || "Untitled goal", args.steps || []);
    if (result.created) {
      // Start working through the steps right away instead of waiting for
      // the next 7-minute autonomousTick. Not awaited on purpose — the
      // current chat turn should reply immediately; progress comes as
      // separate messages from runGoalAutonomously itself.
      kickOffGoal(result.goal_id, args.title || "Untitled goal");
    }
    return result;
  }
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
  if (name === "deploy_multipage_website") return await deployMultiPageWebsite(args.description || "", args.project_name || "", args.pages || []);
  if (name === "get_current_datetime") return nowInTimezone();
  if (name === "list_github_repos") return await listGithubRepos(args.max_results || 20);
  if (name === "search_github_repos") return await searchGithubRepos(args.query || "", args.max_results || 8);
  if (name === "get_github_repo_tree") return await getGithubRepoTree(args.repo, args.path || "");
  if (name === "get_github_file_content") return await getGithubFileContent(args.repo, args.path);
  if (name === "create_or_update_github_file") return await createOrUpdateGithubFile(args.repo, args.path, args.content || "", args.commit_message, args.branch);
  if (name === "delete_github_file") return await deleteGithubFile(args.repo, args.path, args.commit_message, args.branch);
  if (name === "create_github_repo") return await createGithubRepo(args.name, args.description, args.is_private !== false);
  if (name === "fork_github_repo") return await forkGithubRepo(args.repo, args.new_name);
  if (name === "deploy_github_repo_to_railway") return await deployGithubRepoToRailway(args.repo, args.project_name);
  if (name === "get_railway_deployment_status") return await getRailwayDeploymentStatus(args.environment_id);
  if (name === "get_railway_deployment_logs") return await getRailwayDeploymentLogs(args.environment_id, args.filter);
  if (name === "redeploy_railway_service") return await redeployRailwayService(args.service_id, args.environment_id);
  if (name === "list_railway_projects") return await listRailwayProjects();
  if (name === "debug_railway_connection") return await debugRailwayConnection();
  if (name === "delete_railway_project") return await deleteRailwayProject(args.project_id);
  if (name === "set_railway_variables") return await setRailwayVariables(args.project_id, args.environment_id, args.service_id, args.variables || {});
  // (NEW) Anything prefixed mcp_<serverId>_ came from a connected MCP
  // server's tool list — route it there instead of falling through to
  // "unknown tool".
  // (NEW) self-evolution tools
  if (name === "add_custom_tool") return await saveCustomTool(args.name, args.description, args.parameters_schema, args.code);
  if (name === "delete_custom_tool") return await deleteCustomTool(args.name);
  if (name === "list_custom_tools") return await listCustomTools();
  if (name === "save_secret") return await saveSecret(args.key_name, args.value, args.note);
  if (name === "list_secrets") return await listSecrets();
  if (name === "add_mcp_connector") return await agentAddMcpConnector(args);
  if (name === "remove_mcp_connector") return await agentRemoveMcpConnector(args.id_or_label);
  if (name === "list_mcp_connectors") return await agentListMcpConnectors();
  if (name === "read_own_code") return await readOwnCode();
  if (name === "update_own_code") return await writeOwnCode(args.new_content || "", args.commit_message);
  if (name === "run_shell_command") return await runShellCommand(args.command);
  // (NEW) custom tools the agent wrote for itself at runtime
  if (customToolRegistry[name]) return await runCustomTool(name, args);
  if (mcpToolRegistry[name]) return await callMcpTool(name, args);
  return { error: "unknown tool" };
}

async function executeFunctionCall(fc, goalContext) {
  try {
    if (SENSITIVE_TOOLS.has(fc.name)) {
      confirmationCounter++;
      const id = String(confirmationCounter);
      const description = describeAction(fc.name, fc.args);
      // goalContext (goalId/stepId/title) is only set when this call came
      // from runGoalStep, i.e. mid-autonomous-goal-execution. Carrying it on
      // the pending confirmation lets the confirm/cancel callback resume the
      // rest of the goal's steps afterwards instead of the goal silently
      // stalling until the next 7-minute autonomousTick.
      pendingConfirmations.push({
        id, toolName: fc.name, args: fc.args || {}, description, buttonsSent: false,
        goalId: goalContext?.goalId || null,
        stepId: goalContext?.stepId || null,
        goalTitle: goalContext?.title || null,
      });
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
  // (NEW) MCP-discovered tools (if any servers connected) ride alongside
  // the hardcoded CHAT_TOOLS on every call — built fresh each time in case
  // a server reconnects with a different tool set during a restart.
  const combinedTools = (mcpToolDeclarations.length > 0 || customToolDeclarations.length > 0)
    ? [{ functionDeclarations: [...CHAT_TOOLS[0].functionDeclarations, ...mcpToolDeclarations, ...customToolDeclarations] }]
    : CHAT_TOOLS;

  const data = await fetchGeminiRotating(
    (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: combinedTools,
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

    // Tracks whether create_task_list was actually called (and actually
    // succeeded) somewhere in this turn's loop — the old code just printed
    // "I'll register it as a goal" as a hardcoded string with NO check that
    // a goal was ever created, so the autonomous tick had nothing to pick
    // up and the promised follow-up silently never happened.
    let goalRegistered = false;

    // (NEW) Proactive progress check-ins — if a task needs multiple tool
    // rounds, ping Telegram periodically with what's currently happening
    // instead of staying completely silent until the whole loop finishes.
    // Timer only starts once the loop is confirmed to need a 2nd round, and
    // is always cleared in the `finally` below regardless of which return
    // path is taken.
    const CHECKIN_INTERVAL_MS = parseInt(process.env.AGENT_CHECKIN_INTERVAL_MS || "35000", 10);
    let checkinTimer = null;
    let currentStepLabel = "starting";

    // (NEW) Action-intent guard — catches the failure mode where the model
    // describes what it WOULD do (or dumps links/a plan) instead of actually
    // calling a tool. Cheap/fast models especially like to "answer" a
    // build/deploy/send request in prose rather than invoking the tool that
    // does the real work. We only force ONE retry, only on the very first
    // round, and only when the user's own wording clearly asked for an
    // action — this avoids nagging the model on genuine Q&A turns.
    const ACTION_INTENT_RE = /\b(deploy|build|create|make|host|send|schedule|save|delete|update|add|fork|redeploy|generate)\b/i;
    let forcedActionRetry = false;

    const MAX_TOOL_ROUNDS = 10; // was 6 — too easy to exhaust on a multi-step deploy-debug loop
    try {
      for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
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
          if (i === 0 && !forcedActionRetry && ACTION_INTENT_RE.test(userText)) {
            forcedActionRetry = true;
            contents.push({ role: "model", parts: [{ text: textReply }] });
            contents.push({
              role: "user",
              parts: [{
                text: "You replied with text instead of calling a tool, but this request needs a real action. If one of your tools actually does this (deploy_website, deploy_multipage_website, create_or_update_github_file, send_gmail, create_calendar_event, schedule_reminder, create_task_list, etc.), call it now instead of describing it. If genuinely no tool applies, explain specifically why not.",
              }],
            });
            continue; // one extra round, does not count against forced-retry budget
          }
          return textReply || "I processed your request but have no response.";
        }

        if (!checkinTimer) {
          checkinTimer = setInterval(() => {
            bot.sendMessage(CHAT_ID, `🔄 Still working on this — now doing: ${currentStepLabel}`)
              .catch((e) => console.error("progress check-in send failed:", e.message));
          }, CHECKIN_INTERVAL_MS);
        }
        currentStepLabel = functionCalls.map((fc) => fc.name).join(", ");

        contents.push({ role: "model", parts });
        const responseParts = [];
        for (const fc of functionCalls) {
          const result = await executeFunctionCall(fc);
          if (fc.name === "create_task_list" && result && result.created) goalRegistered = true;
          responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
        }
        contents.push({ role: "user", parts: responseParts });
      }

      // We hit the round limit without a final text reply. Don't just claim a
      // goal was registered — actually register one now if it wasn't already,
      // so the 7-min autonomous tick genuinely has something to continue.
      if (goalRegistered) {
        return "Still working through this — I've registered it as a goal and will follow up automatically in a few minutes.";
      }

      const fallbackTitle = `Continue: ${userText}`.slice(0, 120);
      const goalResult = await createTaskList(fallbackTitle, [
        "Pick up where the last chat turn left off and finish the task.",
      ]);
      if (goalResult.created) {
        return "Still working through this — I've registered it as a goal and will follow up automatically in a few minutes.";
      }
      console.error("Fallback createTaskList failed:", goalResult.reason);
      return `⚠️ Still working through this, and I wasn't able to register it as a goal either (${goalResult.reason || "unknown error"}). Please ask me to continue and I'll try again.`;
    } finally {
      if (checkinTimer) clearInterval(checkinTimer);
    }
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

// (CHANGED) This used to ping the user every 30s asking them to go do the
// next goal step themselves and reply "ok"/"skip" — the opposite of
// autonomous. Steps are now actually executed by runGoalAutonomously,
// triggered immediately when a goal is created. What's left here is just a
// safety net: runGoalAutonomously is an in-memory fire-and-forget loop, so
// if Railway restarts/redeploys mid-goal, a goal can be left with pending
// steps and nothing driving it forward until this notices and resumes it —
// still with zero manual "ok" replies required from the user.
setInterval(async () => {
  try {
    const { data: stalledSteps } = await supabase
      .from("goal_steps")
      .select("goal_id, goals!inner(id, title, status)")
      .eq("status", "pending")
      .eq("goals.status", "active")
      .order("goal_id", { ascending: true });

    if (!stalledSteps || stalledSteps.length === 0) return;

    const seen = new Set();
    for (const row of stalledSteps) {
      if (seen.has(row.goal_id)) continue;
      seen.add(row.goal_id);
      kickOffGoal(row.goal_id, row.goals.title); // no-op if already in flight
    }
  } catch (e) {
    console.error("stalled-goal resumer error:", e.message);
  }
}, 60000);

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

// FIXED: two related bugs lived here.
// 1) A research/digest task can take longer than the 60s tick interval —
//    without a guard, a second tick would start while the first was still
//    running and could pick up the same tasks again (they're only marked
//    "running" per-task inside the loop, so the race window was real),
//    sending the user duplicate messages.
// 2) If the process crashed or restarted while a task was mid-flight in
//    "running" status, that task was stuck forever — never picked up
//    again. On startup, anything left in "running" is reset to "pending".
let scheduledTasksRunning = false;

setInterval(checkScheduledTasks, 60000);
checkScheduledTasks();

(async function recoverStuckScheduledTasks() {
  try {
    await supabase.from("scheduled_tasks").update({ status: "pending" }).eq("status", "running");
  } catch (e) {
    console.error("recoverStuckScheduledTasks error:", e.message);
  }
})();

async function checkScheduledTasks() {
  if (scheduledTasksRunning) return; // previous tick still working — skip this one
  scheduledTasksRunning = true;
  try {
    await checkScheduledTasksInner();
  } finally {
    scheduledTasksRunning = false;
  }
}

async function checkScheduledTasksInner() {
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
      await sendLongMessage(CHAT_ID, isDigest ? result : `${icon} ${result}`); // was bot.sendMessage — could hit Telegram's 4096-char cap
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
    // FIXED: if the Gemini call itself failed (data.error set — e.g. all
    // keys rate-limited), `raw` fell back to "[]" and the messages were
    // still marked extracted=true below, permanently throwing away
    // un-analysed conversation. Bail out WITHOUT marking them so the next
    // 5-min tick retries the same batch.
    if (data.error) {
      console.error("extractMemoriesFromRecent Gemini error:", data.error.message);
      return;
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let facts = [];
    try { facts = JSON.parse(cleaned); } catch (e) { facts = []; }
    for (const fact of facts) await saveMemory(fact);
    if (facts.length > 0) console.log(`📚 Extracted ${facts.length} memories from background scan.`);
  } catch (e) {
    console.error("extractMemoriesFromRecent error:", e.message);
    return; // same fix — don't mark messages as processed when we failed
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
- A goal title starting with "Fix" and mentioning a repo/Railway/deploy is
  an in-progress deployment debug loop you registered yourself because you
  couldn't finish it in one chat turn. Actively continue it:
  get_railway_deployment_logs → diagnose → get_github_file_content →
  create_or_update_github_file with the fix → redeploy_railway_service
  (this now waits and returns a real final_status itself — no separate
  status check needed after it). These two (create_or_update_github_file,
  set_railway_variables) are NOT button-gated, so just call them — don't
  queue a confirmation for them. If the fix needs a value only the user
  has (a token/secret), message the user asking for it and leave the goal
  active (don't guess, don't mark it done). Once redeploy_railway_service
  (or set_railway_variables) genuinely returns final_status "SUCCESS",
  mark the goal done with update_goal_status AND message the user that
  it's live — that's a "want to message the user right now" case below,
  so don't reply NOTHING that tick. If final_status comes back
  FAILED/CRASHED, that's a NEW error to diagnose — loop the cycle again
  within this same tick rather than stopping.
- (NEW) It's been roughly 20+ hours since the last message either of you
  sent (see the number given above), and the local hour is a reasonable
  one (say 8-22) — genuinely reach out. "Autonomous" means you actually
  check in sometimes, not that you only ever react to a pending goal.
  This doesn't need a dramatic reason: a short, warm, specific note is
  enough — something from known facts/profile you're curious about,
  a goal that's been quiet, an upcoming calendar event, or just a genuine
  "how's it going" if nothing else stands out. Only do this once per
  rough 20-hour silence window — if you already sent a check-in message
  recently (visible in the recent conversation above), don't send another
  one just because this tick also qualifies.

NEVER call send_gmail during this autonomous review — sending email only
happens in direct response to the user explicitly asking, in the moment.

Be conservative — most ticks, there is nothing worth doing. Don't repeat a
nudge about the same thing recently (check recent conversation first). When
completely done acting this tick (including doing nothing), your FINAL
reply must be exactly: NOTHING — unless you want to message the user right
now, in which case your final reply is that short warm message instead.

You may also improve yourself during a tick: if a recurring need has no
tool, create it with add_custom_tool; if the user recently provided a
credential or connector, verify it with list_secrets / list_mcp_connectors.`;

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

    // (NEW) The model was told to "be conservative, most ticks do nothing" —
    // which meant if no concrete trigger (goal/calendar/gmail) ever fired,
    // it went silent for days even while "running" every 7 minutes. Surface
    // how long it's actually been since anyone last spoke, so a genuine
    // proactive check-in is a real option, not just reacting to triggers.
    const lastMsgAt = recentMsgs && recentMsgs[0] ? new Date(recentMsgs[0].created_at) : null;
    const hoursSinceLastMessage = lastMsgAt ? (Date.now() - lastMsgAt.getTime()) / 3600000 : null;
    // FIXED: this used to be `new Date(nowInTimezone().iso).getHours()`,
    // which returns the hour in the SERVER's local timezone (UTC on
    // Railway), not Colombo time — so the "reasonable hour (8-22)" check
    // was off by 5.5 hours and proactive check-ins could fire in the
    // middle of the night. Parse the hour straight out of the Colombo
    // ISO string instead.
    const localHour = parseInt(nowInTimezone().iso.slice(11, 13), 10);

    const contextText = `Current time: ${nowInTimezone().readable} (${TIMEZONE})

User profile: ${profile || "none yet"}

Known facts:
${memories.length ? memories.map((m) => `- ${m}`).join("\n") : "none"}

Active goals (each has an id you can pass to update_goal_status):
${goals.length ? JSON.stringify(goals) : "none"}

Calendar events in the next 3 days:
${calendarEvents.length ? JSON.stringify(calendarEvents) : "none / not connected"}

Hours since the last message either of you sent: ${hoursSinceLastMessage !== null ? hoursSinceLastMessage.toFixed(1) : "unknown (no messages yet)"}. Local hour right now: ${localHour}:00.

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
      await sendLongMessage(CHAT_ID, reply); // was bot.sendMessage — could hit Telegram's 4096-char cap
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
      await sendLongMessage(CHAT_ID, replyText); // was bot.sendMessage — could hit Telegram's 4096-char cap
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

  // (NEW) Credential inbox — if this message carries a token / API key /
  // MCP URL / postgres connection string, don't treat it as ordinary chat:
  // offer (Yes/No button) to store it as a named secret or connect it as a
  // live MCP connector right away.
  const detectedCreds = detectCredentialsInText(text);
  if (detectedCreds.length > 0) {
    confirmationCounter++;
    const credId = String(confirmationCounter);
    const kindList = detectedCreds.map((d) => d.kind).join(", ");
    pendingConfirmations.push({
      id: credId,
      toolName: "__credential__",
      kind: "credential",
      args: {},
      payload: { found: detectedCreds, text },
      description: `🔑 මේ message එකේ credential/connector එකක් (${kindList}) පේනවා — save කරලා system එකට connect කරන්නද?`,
      buttonsSent: false,
    });
    await sendConfirmationButtons();
    return;
  }

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
    await sendLongMessage(CHAT_ID, reply); // was bot.sendMessage — could hit Telegram's 4096-char cap
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
    const idx = pendingConfirmations.findIndex((pc) => pc.id === id);
    if (idx === -1) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ මේක expire වෙලා, ආයෙත් අහන්න." });
      return;
    }

    const pc = pendingConfirmations[idx];
    pendingConfirmations.splice(idx, 1);

    if (action === "cancel") {
      await bot.answerCallbackQuery(query.id, { text: "Cancelled" });
      await bot.editMessageText(`❌ Cancelled: ${pc.description}`, {
        chat_id: CHAT_ID,
        message_id: query.message.message_id,
      });
      await logBotMessage("agent", `Cancelled: ${pc.description}`);
      // If this confirmation belonged to a goal step, mark that step
      // skipped and keep working through the remaining steps instead of
      // the whole goal silently stalling — one declined action shouldn't
      // block unrelated later steps.
      if (pc.stepId && pc.goalId) {
        await supabase.from("goal_steps").update({ status: "skipped" }).eq("id", pc.stepId);
        kickOffGoal(pc.goalId, pc.goalTitle);
      }
      return;
    }

    if (action === "confirm") {
      await bot.answerCallbackQuery(query.id, { text: "කරගෙන යනවා..." });
      // (NEW) Credential-inbox confirmations don't run a normal tool — they
      // store secrets / connect MCP connectors from the pasted content.
      if (pc.kind === "credential") {
        let credOutcome;
        try {
          credOutcome = await applyDetectedCredentials(pc.payload || {});
        } catch (e) {
          credOutcome = `⚠️ Failed: ${e.message}`;
        }
        await bot.editMessageText(`${pc.description}\n${credOutcome}`, {
          chat_id: CHAT_ID,
          message_id: query.message.message_id,
        });
        await logBotMessage("agent", `${pc.description} — ${credOutcome}`);
        return;
      }
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
        // IDs like Railway's project_id/environment_id/service_id are only
        // useful if the user (and the model, via chat history) can actually
        // see them afterwards — this used to be silently dropped from the
        // reply, so a later "check the status" / "redeploy" request had no
        // id to act on and the model would just guess or fail with an
        // opaque auth-looking error instead.
        const idFields = ["project_id", "environment_id", "service_id"].filter((k) => ok && result?.[k]);
        if (idFields.length > 0) {
          statusLine += `\n🆔 ${idFields.map((k) => `${k}: ${result[k]}`).join(", ")}`;
        }
        if (ok && result?.dashboard_url) statusLine += `\n📊 ${result.dashboard_url}`;
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
      // If this confirmation was blocking a goal step, record the outcome
      // and pick the goal back up right away — this is what makes
      // "step needed approval" a brief pause instead of a dead end that
      // silently waits for the next 7-minute autonomousTick.
      if (pc.stepId && pc.goalId) {
        const stepOk = statusLine.startsWith("✅");
        await supabase.from("goal_steps").update({ status: stepOk ? "done" : "failed" }).eq("id", pc.stepId);
        if (stepOk) {
          kickOffGoal(pc.goalId, pc.goalTitle);
        } else {
          await bot.sendMessage(CHAT_ID, `⚠️ "${pc.goalTitle}" — stopped here since that step failed. Tell me how you'd like to proceed.`);
        }
      }
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

// (NEW) Connect any configured MCP servers (Postgres, Brave Search, etc.)
// — async, doesn't block the bot from starting; if a server is slow/down,
// the bot still runs fine with just its hardcoded tools.
console.log(`✅ MCP servers configured: ${MCP_SERVER_CONFIGS.filter((c) => c.enabled).map((c) => c.label).join(", ") || "none"}`);
initMcpServers();
// (NEW) Load the agent's self-written custom tools from Supabase.
loadCustomToolsFromDb();
