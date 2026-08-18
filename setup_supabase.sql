-- ============================================================
-- Night Agent Tasks Bot — Complete Supabase Setup SQL
-- ============================================================
-- Run this ENTIRE file once in the Supabase SQL editor.
-- It is idempotent (safe to re-run at any time).
--
-- Note: if you prefer the RLS/security defaults, keep the default
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` OFF — this bot uses the
-- service_role key (bypasses RLS). These tables hold bot data, not
-- public user data, so RLS is left disabled here.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Usage tracking (Gemini calls / Vercel deploys per day)
-- ------------------------------------------------------------
create table if not exists api_usage (
  date date primary key,
  gemini_calls integer not null default 0,
  vercel_deploys integer not null default 0
);


-- ------------------------------------------------------------
-- 2. Agent memory (facts about the user + semantic search)
--    Requires the pgvector extension (enabled by default on Supabase).
-- ------------------------------------------------------------
create extension if not exists vector;

create table if not exists agent_memories (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index if not exists agent_memories_created_at_idx
  on agent_memories (created_at desc);

create index if not exists agent_memories_embedding_idx
  on agent_memories using hnsw (embedding vector_cosine_ops);

-- Semantic memory search (called from the bot's search_memories tool).
create or replace function match_memories(
  query_embedding vector(768),
  match_count int default 10
)
returns table (id uuid, content text, similarity float)
language sql
stable
as $$
  select
    m.id,
    m.content,
    1 - (m.embedding <=> query_embedding) as similarity
  from agent_memories m
  order by m.embedding <=> query_embedding
  limit match_count;
$$;


-- ------------------------------------------------------------
-- 3. User profile (single-row summary)
-- ------------------------------------------------------------
create table if not exists user_profile (
  id integer primary key,
  summary text,
  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 4. Goals and goal steps
-- ------------------------------------------------------------
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'active',  -- active | done | cancelled
  created_at timestamptz not null default now()
);

create table if not exists goal_steps (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  step_number integer not null,
  description text not null,
  status text not null default 'pending',  -- pending | in_progress | done | failed | skipped
  created_at timestamptz not null default now()
);

create index if not exists goal_steps_goal_status_idx
  on goal_steps (goal_id, status);


-- ------------------------------------------------------------
-- 5. Scheduled tasks (reminders, research, morning digest)
-- ------------------------------------------------------------
create table if not exists scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                        -- research | reminder | digest
  topic text,                                -- research topics
  message text,                              -- reminder/digest messages
  run_at timestamptz not null,
  status text not null default 'pending',    -- pending | running | done | failed
  recurrence text not null default 'once',   -- once | daily | weekly
  result text,
  created_at timestamptz not null default now()
);

create index if not exists scheduled_tasks_run_status_idx
  on scheduled_tasks (status, run_at);

-- The morning digest needs kind='digest' allowed. If this table already
-- exists with a CHECK constraint that only allows ('research','reminder'),
-- the digest insert will fail — drop/widen the constraint here:
alter table scheduled_tasks drop constraint if exists scheduled_tasks_kind_check;


-- ------------------------------------------------------------
-- 6. Self-evolution: custom runtime tools
-- ------------------------------------------------------------
create table if not exists agent_custom_tools (
  name text primary key,
  description text not null default '',
  parameters_json text not null default '{"type":"OBJECT","properties":{}}',
  code text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 7. Self-evolution: secrets/credentials store
-- ------------------------------------------------------------
create table if not exists agent_secrets (
  key_name text primary key,
  value text not null,
  note text,
  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 8. MCP connectors (remote 'http' and local 'stdio' servers)
-- ------------------------------------------------------------
create table if not exists mcp_connectors (
  id text primary key,
  label text not null,
  type text not null default 'http',   -- 'http' (remote MCP server) or
                                       -- 'stdio' (local process, e.g. the
                                       -- Postgres MCP server)
  url text,                            -- 'http' type: MCP endpoint URL
  auth_header text,                    -- 'http' type: optional, e.g. "Bearer xxx"
  command text,                        -- 'stdio' type: e.g. "npx"
  args text,                           -- 'stdio' type: space-separated args
  env_json text,                       -- 'stdio' type: optional JSON env vars
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Migrations for older installs that created mcp_connectors before the
-- 'type'/'command'/'args'/'env_json' columns existed:
alter table mcp_connectors add column if not exists type text not null default 'http';
alter table mcp_connectors add column if not exists command text;
alter table mcp_connectors add column if not exists args text;
alter table mcp_connectors add column if not exists env_json text;
alter table mcp_connectors alter column url drop not null;


-- ------------------------------------------------------------
-- 9. Persistent self-task queue (true autonomy)
--    The bot files its own background tasks here and the autonomous
--    tick executes them with the full tool set — no user command needed.
-- ------------------------------------------------------------
create table if not exists agent_self_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  status text not null default 'pending',  -- pending | in_progress | done | failed | cancelled
  priority int not null default 5,          -- 1 (low) .. 10 (high)
  not_before timestamptz not null default now(),
  recurrence text,                          -- null | daily | weekly
  attempts int not null default 0,
  max_attempts int not null default 3,
  last_error text,
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_self_tasks_due_idx
  on agent_self_tasks (status, not_before);


-- ------------------------------------------------------------
-- 10. Message log (chat history + passive memory extraction)
-- ------------------------------------------------------------
create table if not exists bot_messages (
  id bigint generated always as identity primary key,
  role text not null,                      -- user | agent | system
  content text,
  channel text not null default 'telegram',
  extracted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists bot_messages_created_at_idx
  on bot_messages (created_at desc);

create index if not exists bot_messages_extracted_idx
  on bot_messages (extracted) where extracted = false;
