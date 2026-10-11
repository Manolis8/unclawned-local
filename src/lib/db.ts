import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const dir = join(homedir(), '.unclawned')
mkdirSync(dir, { recursive: true })

// Cast to any: node:sqlite returns Record<string,SQLOutputValue> from .get()/.all() which
// breaks direct-cast patterns throughout the codebase. better-sqlite3 returned unknown, which
// allowed those casts. This restores equivalent typing without touching every call site.
export const db: any = new DatabaseSync(join(dir, 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// Migrate skills table with new columns (safe — SQLite ignores if column already exists via try/catch)
const skillMigrations = [
  `ALTER TABLE skills ADD COLUMN skill_type TEXT DEFAULT 'browser'`,
  `ALTER TABLE skills ADD COLUMN chat_template TEXT`,
  `ALTER TABLE skills ADD COLUMN hybrid_plan TEXT`,
  `ALTER TABLE skills ADD COLUMN run_count INTEGER DEFAULT 0`,
  `ALTER TABLE skills ADD COLUMN success_count INTEGER DEFAULT 0`,
  `ALTER TABLE skills ADD COLUMN learned_improvements TEXT`,
  `ALTER TABLE skills ADD COLUMN version INTEGER DEFAULT 1`,
  `ALTER TABLE skills ADD COLUMN intent_tags TEXT`,
  `ALTER TABLE skills ADD COLUMN trigger_phrases TEXT`,
  `ALTER TABLE skills ADD COLUMN site_scope TEXT DEFAULT 'any'`,
  `ALTER TABLE skills ADD COLUMN last_indexed_at TEXT`,
  `ALTER TABLE skills ADD COLUMN staleness TEXT`,
  `ALTER TABLE skills ADD COLUMN staleness_reason TEXT`,
  `ALTER TABLE skills ADD COLUMN pinned INTEGER DEFAULT 0`,
  `ALTER TABLE skills ADD COLUMN last_run_at TEXT`,
]

// user_preferences migrations
const prefMigrations = [
  `ALTER TABLE user_preferences ADD COLUMN tavily_api_key TEXT`,
]

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_gap_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stuck_description TEXT,
    stuck_type TEXT,
    current_url TEXT,
    current_page_type TEXT,
    task_description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    execution_plan TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    change_reason TEXT
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_suggestions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    suggested_name TEXT NOT NULL,
    suggested_description TEXT NOT NULL,
    skill_type TEXT NOT NULL DEFAULT 'browser',
    source_task TEXT NOT NULL,
    tool_call_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_improvement_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    summary TEXT,
    issues TEXT,
    suggestions TEXT,
    step_updates TEXT,
    updated_plan TEXT,
    new_learning TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    draft_name TEXT NOT NULL,
    draft_description TEXT NOT NULL,
    skill_type TEXT NOT NULL DEFAULT 'browser',
    execution_plan TEXT,
    source_task TEXT NOT NULL,
    tool_call_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    skill_description TEXT,
    skill_details TEXT,
    execution_plan TEXT,
    status TEXT DEFAULT 'active',
    is_public INTEGER DEFAULT 0,
    plan_approved_at TEXT,
    session_id TEXT,
    summary TEXT,
    variables TEXT,
    step_count INTEGER,
    raw_session_data TEXT,
    element_registry TEXT,
    playwright_metadata TEXT,
    conversion_metadata TEXT,
    verified_by_playwright INTEGER DEFAULT 0,
    needs_semantic_analysis INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skill_input_variables (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    variable_name TEXT NOT NULL,
    variable_type TEXT,
    description TEXT,
    is_required INTEGER DEFAULT 0,
    default_value TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skill_executions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    input_values TEXT,
    status TEXT DEFAULT 'running',
    execution_log TEXT,
    final_url TEXT,
    error_message TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_seconds INTEGER
  );

  CREATE TABLE IF NOT EXISTS skill_steps (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    step_number INTEGER,
    action_type TEXT,
    description TEXT,
    screenshot TEXT,
    identified_variables TEXT,
    is_manual INTEGER DEFAULT 0,
    raw_event_data TEXT,
    element_ref TEXT,
    element_selector TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prompt TEXT,
    output TEXT DEFAULT '',
    status TEXT DEFAULT 'running',
    error_details TEXT,
    is_recurring INTEGER DEFAULT 0,
    schedule TEXT,
    schedule_human TEXT,
    next_run TEXT,
    last_run TEXT,
    running_at TEXT,
    consecutive_errors INTEGER DEFAULT 0,
    requires_extension INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_permissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT,
    details TEXT,
    platform TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_executions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    task_prompt TEXT,
    plan TEXT,
    status TEXT,
    result_summary TEXT,
    steps_log TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    user_id TEXT,
    user_prompt TEXT,
    status TEXT,
    plan TEXT,
    steps TEXT,
    total_time INTEGER,
    iterations_used INTEGER,
    total_steps INTEGER,
    final_confidence REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    source_chat_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, fact)
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY,
    auto_close_tabs INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    content TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    user_id TEXT,
    role TEXT,
    content TEXT,
    skill_id TEXT,
    discussion_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TEXT,
    scope TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
  );

`)

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile (
    user_id TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS writing_samples (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    content         TEXT NOT NULL,
    source_platform TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    task_prompt TEXT NOT NULL,
    task_summary TEXT,
    task_type TEXT,
    outcome TEXT,
    duration_seconds INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS agent_sessions_fts USING fts5(
    session_id UNINDEXED,
    task_prompt,
    task_summary,
    tokenize='unicode61'
  );

  CREATE TABLE IF NOT EXISTS memory_pending (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    section TEXT NOT NULL,
    proposed_entry TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS standing_permissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    platform TEXT,
    scope_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS confirmation_audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    tier INTEGER,
    action_type TEXT,
    target TEXT,
    content_snapshot TEXT,
    decision TEXT,
    edit_rounds INTEGER DEFAULT 0,
    via_standing_permission INTEGER DEFAULT 0,
    decided_at TEXT DEFAULT (datetime('now')),
    decision_time_seconds INTEGER
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS open_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    context TEXT,
    related_person TEXT,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at TEXT,
    follow_up_after_days INTEGER NOT NULL DEFAULT 3,
    last_surfaced_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_open_items_user ON open_items(user_id, status);

  CREATE TABLE IF NOT EXISTS action_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action_category TEXT NOT NULL,
    insight_text TEXT NOT NULL,
    question_text TEXT,
    evidence TEXT,
    value_score REAL NOT NULL DEFAULT 5.0,
    confidence REAL NOT NULL DEFAULT 0.6,
    friction REAL NOT NULL DEFAULT 3.0,
    priority_score REAL,
    status TEXT NOT NULL DEFAULT 'queued',
    sessions_in_queue INTEGER NOT NULL DEFAULT 0,
    last_scored_at TEXT,
    dismissal_count INTEGER NOT NULL DEFAULT 0,
    dismiss_lock_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aq_user ON action_queue(user_id, status);

  CREATE TABLE IF NOT EXISTS action_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    queue_id TEXT,
    action_category TEXT NOT NULL,
    surfaced_at TEXT NOT NULL,
    user_response TEXT,
    session_window TEXT,
    priority_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_am_user ON action_memory(user_id, created_at);

  CREATE TABLE IF NOT EXISTS action_suppression (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'user_command',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, category)
  );
  CREATE INDEX IF NOT EXISTS idx_as_user ON action_suppression(user_id, category);

  CREATE TABLE IF NOT EXISTS autonomous_authorizations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    auth_level INTEGER NOT NULL DEFAULT 2,
    scope_params TEXT,
    authorized_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    last_executed_at TEXT,
    reversal_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE(user_id, category)
  );
  CREATE INDEX IF NOT EXISTS idx_aa_user ON autonomous_authorizations(user_id, status);

  CREATE TABLE IF NOT EXISTS autonomous_executions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    authorization_id TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    surfaced_at TEXT,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ae_user ON autonomous_executions(user_id, status);

  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    commitment_type TEXT NOT NULL,
    description TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_value TEXT,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    fired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, status);

  CREATE TABLE IF NOT EXISTS inprogress_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_description TEXT NOT NULL,
    progress_summary TEXT,
    next_steps TEXT,
    last_session_at TEXT NOT NULL DEFAULT (datetime('now')),
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ipt_user ON inprogress_tasks(user_id, status);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS cli_sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL DEFAULT 'local',
    cwd        TEXT NOT NULL,
    title      TEXT,
    task_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cli_sessions_user_cwd ON cli_sessions(user_id, cwd, started_at DESC);

  CREATE TABLE IF NOT EXISTS session_turns (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    cli_session_id TEXT NOT NULL,
    role           TEXT NOT NULL,
    content        TEXT NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_turns_session ON session_turns(cli_session_id, id);
`)

// Safe migrations
try { db.prepare(`ALTER TABLE action_queue ADD COLUMN insight_format TEXT NOT NULL DEFAULT 'observation'`).run() } catch {}
try { db.prepare(`ALTER TABLE agent_sessions ADD COLUMN cli_session_id TEXT`).run() } catch {}
try { db.prepare(`ALTER TABLE inprogress_tasks ADD COLUMN last_prompted_at TEXT`).run() } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_g_task_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    hour_of_day INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    day_of_month INTEGER NOT NULL,
    month_of_year INTEGER NOT NULL,
    task_category TEXT NOT NULL,
    prompt_word_count INTEGER DEFAULT 0,
    has_urgency INTEGER DEFAULT 0,
    has_frustration INTEGER DEFAULT 0,
    is_late_night INTEGER DEFAULT 0,
    is_completed INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_cg_snap_user ON channel_g_task_snapshots(user_id);
  CREATE INDEX IF NOT EXISTS idx_cg_snap_created ON channel_g_task_snapshots(created_at);
  CREATE INDEX IF NOT EXISTS idx_cg_snap_hour ON channel_g_task_snapshots(user_id, hour_of_day);

  CREATE TABLE IF NOT EXISTS channel_g_stress_cycles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    cycle_start TEXT NOT NULL,
    cycle_end TEXT,
    peak_streak INTEGER DEFAULT 0,
    signals TEXT,
    status TEXT DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_cg_stress_user ON channel_g_stress_cycles(user_id);

  CREATE TABLE IF NOT EXISTS channel_g_profiles (
    user_id TEXT PRIMARY KEY,
    total_tasks_observed INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now')),
    last_task_at TEXT,
    cognitive_rhythm TEXT,
    seasonal_patterns TEXT,
    current_stress_streak INTEGER DEFAULT 0,
    current_stress_start TEXT,
    recovery_pattern TEXT
  );
`)

// ─── Channel A tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_a_raw_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    message_text TEXT,
    message_length INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    task_type TEXT,
    prior_turn_count INTEGER DEFAULT 0,
    contains_pasted_content INTEGER DEFAULT 0,
    tribe_word_hits TEXT,
    hedging_detected INTEGER DEFAULT 0,
    hedging_phrases TEXT,
    frustration_detected INTEGER DEFAULT 0,
    frustration_phrases TEXT,
    extraction_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ca_signals_user ON channel_a_raw_signals(user_id, created_at);

  CREATE TABLE IF NOT EXISTS channel_a_profiles (
    user_id TEXT PRIMARY KEY,
    last_updated TEXT,
    profile_version INTEGER DEFAULT 1,
    total_samples INTEGER DEFAULT 0,
    vocabulary_tribe TEXT,
    prompt_evolution TEXT,
    negative_space TEXT,
    hedging_profile TEXT,
    frustration_fingerprint TEXT
  );

  CREATE TABLE IF NOT EXISTS channel_a_word_frequency (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    word TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    first_seen TEXT,
    last_seen TEXT,
    UNIQUE(user_id, word)
  );
  CREATE INDEX IF NOT EXISTS idx_ca_wf_user ON channel_a_word_frequency(user_id);
`)

// ─── Channel D tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_d_pending (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    trigger_type TEXT NOT NULL,
    question_text TEXT,
    question_context TEXT,
    entity_name TEXT,
    earliest_ask_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    asked_at TEXT,
    answered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cd_pending_user ON channel_d_pending(user_id, status);

  CREATE TABLE IF NOT EXISTS channel_d_extractions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    pending_id TEXT,
    trigger_type TEXT,
    question_text TEXT,
    answer_text TEXT,
    extracted_fact TEXT,
    entity_name TEXT,
    answer_confidence TEXT,
    sentiment TEXT,
    is_active INTEGER DEFAULT 1,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cd_extractions_user ON channel_d_extractions(user_id, created_at);
`)

// ─── Channel F tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_f_person_mentions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    person_name TEXT NOT NULL,
    mention_context TEXT,
    context_tone TEXT,
    reference_style TEXT,
    co_mentioned TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cf_mentions_user ON channel_f_person_mentions(user_id, person_name, created_at);

  CREATE TABLE IF NOT EXISTS channel_f_relationship_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    person_name TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    mention_count INTEGER DEFAULT 1,
    trajectory TEXT DEFAULT 'stable',
    recent_tones TEXT,
    reference_style_counts TEXT,
    cluster_tags TEXT DEFAULT '[]',
    is_bridge INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now')),
    communication_register TEXT,
    UNIQUE(user_id, person_name)
  );
  CREATE INDEX IF NOT EXISTS idx_cf_profiles_user ON channel_f_relationship_profiles(user_id);
`)

// ─── Channel I tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_i_decision_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    signal_type TEXT NOT NULL,
    style_label TEXT,
    message_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ci_signals_user ON channel_i_decision_signals(user_id, signal_type, created_at);

  CREATE TABLE IF NOT EXISTS channel_i_profiles (
    user_id TEXT PRIMARY KEY,
    dominant_style TEXT,
    style_counts TEXT,
    research_depth TEXT,
    avg_research_per_session REAL DEFAULT 0,
    reversal_rate REAL DEFAULT 0,
    total_reversals INTEGER DEFAULT 0,
    approval_rate REAL DEFAULT 0,
    total_signals INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );
`)

// ─── Channel J tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_j_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    signal_type TEXT NOT NULL,
    value TEXT,
    message_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cj_signals_user ON channel_j_signals(user_id, signal_type);

  CREATE TABLE IF NOT EXISTS channel_j_profiles (
    user_id TEXT PRIMARY KEY,
    source_counts TEXT,
    dominant_source_type TEXT,
    depth_preference TEXT DEFAULT 'unknown',
    consumption_ratio REAL DEFAULT 0.5,
    info_anxiety_count INTEGER DEFAULT 0,
    total_signals INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );
`)

// ─── Channel K tables ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_k_profiles (
    user_id TEXT PRIMARY KEY,
    total_messages INTEGER DEFAULT 0,
    avg_message_length REAL DEFAULT 0,
    energy_state TEXT,
    confidence_level TEXT DEFAULT 'normal',
    last_updated TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_k_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    signal_type TEXT NOT NULL,
    value TEXT,
    message_length INTEGER,
    message_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ck_signals_user ON channel_k_signals(user_id, signal_type, created_at);
`)

export { randomUUID as uuid }

export function j(val: any): string | null {
  return val != null ? JSON.stringify(val) : null
}

export function p(val: string | null | undefined): any {
  if (!val) return null
  try { return JSON.parse(val) } catch { return val }
}

// Tables used by the background signal channels (were missing on fresh installs)
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_a_injection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    injected_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ca_inject_user ON channel_a_injection_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_ca_inject_at ON channel_a_injection_log(injected_at);
  CREATE TABLE IF NOT EXISTS channel_b_raw_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),

    user_message_text TEXT NOT NULL,
    user_message_length INTEGER NOT NULL,

    prior_task_type TEXT,
    prior_response_length INTEGER,

    is_continuation INTEGER DEFAULT 0,
    is_correction INTEGER DEFAULT 0,
    correction_level INTEGER,
    correction_phrases TEXT,

    contains_paste INTEGER DEFAULT 0,
    paste_type TEXT,
    paste_char_count INTEGER,
    paste_tribe_hits TEXT,

    latency_seconds INTEGER,
    latency_bucket TEXT,
    is_rubber_stamp INTEGER DEFAULT 0,

    extraction_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cb_raw_user ON channel_b_raw_signals(user_id);
  CREATE INDEX IF NOT EXISTS idx_cb_raw_created ON channel_b_raw_signals(created_at);
  CREATE INDEX IF NOT EXISTS idx_cb_raw_session ON channel_b_raw_signals(session_id);
  CREATE TABLE IF NOT EXISTS channel_b_profiles (
    user_id TEXT PRIMARY KEY,
    last_updated TEXT DEFAULT (datetime('now')),
    profile_version INTEGER DEFAULT 1,
    total_reactions INTEGER DEFAULT 0,

    correction_profile TEXT,
    paste_profile TEXT,
    latency_profile TEXT,
    approval_profile TEXT
  );
  CREATE TABLE IF NOT EXISTS channel_b_paste_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    paste_type TEXT NOT NULL,
    paste_char_count INTEGER,
    paste_tribe_hits TEXT,
    primary_tribe TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cb_paste_user ON channel_b_paste_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_cb_paste_created ON channel_b_paste_log(created_at);
  CREATE TABLE IF NOT EXISTS channel_c_task_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),

    task_type TEXT,
    task_hour INTEGER,
    task_day_of_week INTEGER,

    domains_visited TEXT,
    domain_categories TEXT,
    primary_domain TEXT,
    domain_count INTEGER DEFAULT 0,
    is_research_task INTEGER DEFAULT 0,

    file_extensions TEXT,
    folder_names TEXT,
    file_count INTEGER DEFAULT 0,

    desktop_scanned INTEGER DEFAULT 0,
    desktop_file_types TEXT,
    desktop_folder_count INTEGER,
    home_top_folders TEXT,
    active_app_categories TEXT,

    extraction_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cc_snap_user ON channel_c_task_snapshots(user_id);
  CREATE INDEX IF NOT EXISTS idx_cc_snap_created ON channel_c_task_snapshots(created_at);
  CREATE INDEX IF NOT EXISTS idx_cc_snap_type ON channel_c_task_snapshots(task_type);
  CREATE TABLE IF NOT EXISTS channel_c_domain_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    domain TEXT NOT NULL,
    domain_category TEXT,
    is_research_artifact INTEGER DEFAULT 0,
    task_count INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_cc_domain_user ON channel_c_domain_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_cc_domain_domain ON channel_c_domain_log(domain);
  CREATE INDEX IF NOT EXISTS idx_cc_domain_created ON channel_c_domain_log(created_at);
  CREATE TABLE IF NOT EXISTS channel_c_profiles (
    user_id TEXT PRIMARY KEY,
    last_updated TEXT DEFAULT (datetime('now')),
    profile_version INTEGER DEFAULT 1,
    total_tasks_observed INTEGER DEFAULT 0,

    tool_stack_profile TEXT,
    domain_profile TEXT,
    file_type_profile TEXT,
    work_time_profile TEXT,
    desktop_profile TEXT
  );
  CREATE TABLE IF NOT EXISTS channel_e_feed_visits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    url TEXT NOT NULL,
    page_type TEXT NOT NULL,
    topic_distribution TEXT,
    accounts_seen TEXT,
    post_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ce_visits_user ON channel_e_feed_visits(user_id);
  CREATE INDEX IF NOT EXISTS idx_ce_visits_created ON channel_e_feed_visits(created_at);
  CREATE TABLE IF NOT EXISTS channel_e_recurring_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    appearance_count INTEGER DEFAULT 1,
    primary_topic TEXT,
    UNIQUE(user_id, account_name)
  );
  CREATE INDEX IF NOT EXISTS idx_ce_accounts_user ON channel_e_recurring_accounts(user_id);
  CREATE TABLE IF NOT EXISTS channel_e_profiles (
    user_id TEXT PRIMARY KEY,
    total_feed_visits INTEGER DEFAULT 0,
    last_visit_at TEXT,
    topic_evolution TEXT,
    dominant_topics TEXT,
    top_recurring_accounts TEXT,
    drift_signal TEXT,
    own_content_topics TEXT,
    last_updated TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS channel_o_achievements (
    id BLOB PRIMARY KEY,
    user_id TEXT NOT NULL,
    achievement_type TEXT NOT NULL,
    achievement_text TEXT NOT NULL,
    detected_from TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_co_achievements_user ON channel_o_achievements(user_id, created_at);
  CREATE TABLE IF NOT EXISTS channel_o_profiles (
    user_id TEXT PRIMARY KEY,
    total_achievements INTEGER DEFAULT 0,
    dominant_achievement_type TEXT,
    most_recent_achievement TEXT,
    most_recent_at TEXT,
    last_updated TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS channel_n_watchlist (
    user_id TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    mentions_count INTEGER DEFAULT 1,
    first_seen TEXT DEFAULT (datetime('now')),
    last_mentioned TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, entity_name)
  );
  CREATE INDEX IF NOT EXISTS idx_cn_watchlist_user ON channel_n_watchlist(user_id, mentions_count);
  CREATE TABLE IF NOT EXISTS channel_n_events (
    id BLOB PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_name TEXT,
    event_type TEXT NOT NULL,
    headline TEXT NOT NULL,
    relevance_score INTEGER DEFAULT 0,
    surfaced INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cn_events_user ON channel_n_events(user_id, surfaced, relevance_score);
  CREATE TABLE IF NOT EXISTS channel_n_profiles (
    user_id TEXT PRIMARY KEY,
    total_events INTEGER DEFAULT 0,
    last_surfaced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS channel_m_word_log (
    id BLOB PRIMARY KEY,
    user_id TEXT NOT NULL,
    word TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cm_word_log_user ON channel_m_word_log(user_id, word, created_at);
  CREATE TABLE IF NOT EXISTS channel_m_vocab_summary (
    user_id TEXT NOT NULL,
    word TEXT NOT NULL,
    total_count INTEGER DEFAULT 0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    is_proper_noun INTEGER DEFAULT 0,
    category TEXT,
    PRIMARY KEY (user_id, word)
  );
  CREATE TABLE IF NOT EXISTS channel_m_profiles (
    user_id TEXT PRIMARY KEY,
    drift_direction TEXT,
    total_distinct_words INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS channel_l_signals (
    id BLOB PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    signal_type TEXT NOT NULL,
    subtype TEXT,
    domain TEXT,
    message_preview TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cl_signals_user ON channel_l_signals(user_id);
  CREATE INDEX IF NOT EXISTS idx_cl_signals_type ON channel_l_signals(user_id, signal_type);
  CREATE TABLE IF NOT EXISTS channel_l_profiles (
    user_id TEXT PRIMARY KEY,
    total_signals INTEGER DEFAULT 0,
    factual_resistance_count INTEGER DEFAULT 0,
    framing_resistance_count INTEGER DEFAULT 0,
    scope_resistance_count INTEGER DEFAULT 0,
    strategic_resistance_count INTEGER DEFAULT 0,
    dominant_resistance TEXT,
    blind_spot_domains TEXT DEFAULT '[]',
    capability_avoidance_count INTEGER DEFAULT 0,
    skill_avoidance_count INTEGER DEFAULT 0,
    priority_avoidance_count INTEGER DEFAULT 0,
    emotional_avoidance_count INTEGER DEFAULT 0,
    identity_avoidance_count INTEGER DEFAULT 0,
    kept_work_categories TEXT DEFAULT '[]',
    kept_work_offer_made TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS channel_h_corpus_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    content_type TEXT NOT NULL,
    content_preview TEXT,
    task_prompt_preview TEXT,
    task_summary TEXT,
    word_count INTEGER DEFAULT 0,
    topics TEXT,
    quality_signal TEXT DEFAULT 'unknown',
    outcome_sentiment TEXT,
    outcome_context TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ch_corpus_user ON channel_h_corpus_items(user_id);
  CREATE INDEX IF NOT EXISTS idx_ch_corpus_created ON channel_h_corpus_items(created_at);
  CREATE INDEX IF NOT EXISTS idx_ch_corpus_type ON channel_h_corpus_items(user_id, content_type);
  CREATE TABLE IF NOT EXISTS channel_h_profiles (
    user_id TEXT PRIMARY KEY,
    total_indexed INTEGER DEFAULT 0,
    last_indexed_at TEXT,
    evergreen_topics TEXT,
    vocabulary_evolution TEXT,
    hit_rate_by_type TEXT,
    last_updated TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS synthesis_state (
    user_id TEXT NOT NULL,
    synthesis_type TEXT NOT NULL,
    last_surfaced_at TEXT,
    last_value TEXT,
    PRIMARY KEY (user_id, synthesis_type)
  );
  CREATE TABLE IF NOT EXISTS behavioral_contract (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    directive_type TEXT NOT NULL,
    directive_key TEXT NOT NULL,
    directive_value TEXT NOT NULL,
    stated_at TEXT NOT NULL,
    stated_in_context TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS live_state (
    user_id TEXT PRIMARY KEY,
    urgency_level TEXT NOT NULL DEFAULT 'low',
    cognitive_load TEXT NOT NULL DEFAULT 'clear',
    emotional_temperature TEXT NOT NULL DEFAULT 'neutral',
    current_focus_topic TEXT,
    relationship_context TEXT,
    session_intent TEXT NOT NULL DEFAULT 'execution',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// Run after CREATE TABLE skills, otherwise new columns are missing on fresh installs
for (const sql of skillMigrations) {
  try { db.prepare(sql).run() } catch {}
}
for (const sql of prefMigrations) {
  try { db.prepare(sql).run() } catch {}
}
