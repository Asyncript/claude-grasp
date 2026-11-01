// Each entry is one schema version. Append new entries; never edit old ones.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    last_head TEXT,
    scanned_at TEXT
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    dir_name TEXT NOT NULL,
    repo_id INTEGER REFERENCES repos(id),
    UNIQUE (root, dir_name)
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    entrypoint TEXT,
    cwd TEXT,
    title TEXT,
    git_branch TEXT,
    version TEXT,
    started_at TEXT,
    ended_at TEXT,
    headless INTEGER NOT NULL DEFAULT 0
  );

  -- One row per transcript file, main or subagent. byte_offset/state let a re-run resume.
  CREATE TABLE transcripts (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    head_hash TEXT,
    state TEXT,
    skipped TEXT,
    bad_lines INTEGER NOT NULL DEFAULT 0,
    parsed_at TEXT
  );

  -- source = transcript path, so a rewritten file's rows can be replaced.
  CREATE TABLE prompts (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    turn_id TEXT,
    ts TEXT,
    kind TEXT NOT NULL,
    words INTEGER NOT NULL,
    pasted_words INTEGER NOT NULL DEFAULT 0,
    is_bare INTEGER NOT NULL,
    is_question INTEGER NOT NULL,
    is_correction INTEGER NOT NULL,
    excerpt TEXT,
    mentions TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE edits (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    turn_id TEXT,
    ts TEXT,
    tool TEXT NOT NULL,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    rel_path TEXT NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    created INTEGER NOT NULL,
    approval TEXT NOT NULL,
    permission_mode TEXT,
    sidechain INTEGER NOT NULL,
    symbols TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE plans (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    turn_id TEXT,
    ts TEXT,
    outcome TEXT NOT NULL,
    plan_edited INTEGER NOT NULL
  );

  CREATE TABLE file_refs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    ts TEXT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    rel_path TEXT NOT NULL,
    kind TEXT NOT NULL
  );

  CREATE TABLE commits (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    sha TEXT NOT NULL,
    ts INTEGER NOT NULL,
    author TEXT,
    email TEXT,
    is_claude INTEGER NOT NULL,
    subject TEXT,
    PRIMARY KEY (repo_id, sha)
  );

  CREATE TABLE commit_files (
    repo_id INTEGER NOT NULL,
    sha TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    added INTEGER,
    removed INTEGER,
    PRIMARY KEY (repo_id, sha, rel_path)
  );

  CREATE INDEX prompts_session ON prompts (session_id, ts);
  CREATE INDEX prompts_source ON prompts (source);
  CREATE INDEX edits_file ON edits (repo_id, rel_path);
  CREATE INDEX edits_source ON edits (source);
  CREATE INDEX edits_turn ON edits (turn_id);
  CREATE INDEX plans_source ON plans (source);
  CREATE INDEX refs_file ON file_refs (repo_id, rel_path);
  CREATE INDEX refs_source ON file_refs (source);
  CREATE INDEX commit_files_path ON commit_files (repo_id, rel_path);
  `,
  `
  -- Headless (claude -p) sessions used to be skipped whole; re-read them so their edits count as unattended.
  ALTER TABLE edits ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0;
  DELETE FROM transcripts WHERE skipped = 'headless';

  -- One explain-back quiz per local day. Each question remembers the Claude config dir whose
  -- account generated it, so grading goes through the same account.
  CREATE TABLE quizzes (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE quiz_questions (
    id INTEGER PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    config_dir TEXT NOT NULL,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    rel_path TEXT NOT NULL,
    question TEXT NOT NULL,
    expected TEXT NOT NULL,
    answer TEXT,
    score REAL,
    feedback TEXT,
    answered_at TEXT
  );

  CREATE INDEX quiz_questions_file ON quiz_questions (repo_id, rel_path);
  CREATE INDEX edits_session ON edits (session_id);
  `,
  `
  -- The diff a question was written from, kept so grading sees exactly what the question saw.
  ALTER TABLE quiz_questions ADD COLUMN diff TEXT NOT NULL DEFAULT '';
  `,
  `
  -- A skipped question counts neither for nor against the file.
  ALTER TABLE quiz_questions ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
  `,
];
