-- JobFlow Supabase schema: three tables linked by job_id.
-- Usage: Supabase dashboard → SQL Editor → paste → Run.
--
--   jobs         = job catalog (written by the crawler)
--   applications = submission log (status updated by Gmail scanner later)
--   documents    = generated resumes / cover letters (wired up later)

-- ── jobs ────────────────────────────────────────────────
create table if not exists jobs (
  id           text primary key,          -- Simplify unique id, or normalized URL (speedyapply)
  company      text not null,
  title        text not null,
  url          text not null,
  locations    text,
  salary       text,
  source       text,                      -- simplify / speedyapply
  ats_type     text,                      -- greenhouse / lever / workday... (derived later)
  category     text,
  sponsorship  text,
  score        int,                       -- AI match score 0-100, null = not scored yet
  score_reason text,
  active       boolean default true,      -- false = posting closed
  posted_at    timestamptz,
  created_at   timestamptz default now()
);

-- Common query: open, high-score, not yet applied
create index if not exists idx_jobs_active_score on jobs (active, score desc);
create index if not exists idx_jobs_url on jobs (url);

-- ── applications ────────────────────────────────────────
create table if not exists applications (
  id                uuid primary key default gen_random_uuid(),
  job_id            text references jobs(id),  -- null allowed: record even without a catalog match
  company           text,
  title             text,
  url               text,
  resume_version    text,
  status            text default 'applied',    -- applied / oa / interview / rejected / offer
  applied_at        timestamptz default now(),
  status_updated_at timestamptz default now()
);

create index if not exists idx_apps_status on applications (status);
create index if not exists idx_apps_url on applications (url);

-- ── documents ───────────────────────────────────────────
create table if not exists documents (
  id         uuid primary key default gen_random_uuid(),
  job_id     text references jobs(id),
  type       text,                        -- resume / cover_letter
  content    text,
  created_at timestamptz default now()
);

-- ── Security: RLS on, no policies ───────────────────────
-- Anon key reads nothing; only the Worker's service_role key (which bypasses
-- RLS) can read/write. Add read policies when the popup queries directly.
alter table jobs         enable row level security;
alter table applications enable row level security;
alter table documents    enable row level security;
