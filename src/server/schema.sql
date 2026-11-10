-- OpenAcademy: courses built from a company's own documents, assigned by role,
-- with the record of who completed which version.
--
-- Two halves. The editor works on draft rows (courses, modules, lessons,
-- questions). Publishing freezes the whole course into course_versions.snapshot,
-- and learners only ever see a snapshot: editing a draft never changes what a
-- learner is half-way through, and every completion names the exact version
-- the person was shown.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  organization_name TEXT NOT NULL DEFAULT '',
  text_model TEXT NOT NULL DEFAULT '',
  voice_model TEXT NOT NULL DEFAULT 'elevenlabs/eleven-multilingual-v2',
  voice TEXT NOT NULL DEFAULT 'sarah',
  avatar_model TEXT NOT NULL DEFAULT 'heygen/avatar-iv',
  certificate_signer TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The single row (id = 1) is created by the app on first read: schema.sql is structure only.

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'English',
  pass_mark INTEGER NOT NULL DEFAULT 80,          -- percent, over every quiz question in the course
  due_days INTEGER NOT NULL DEFAULT 30,           -- days a learner has once assigned
  renew_months INTEGER,                           -- assign again this long after completion; null = once
  attestation TEXT NOT NULL DEFAULT 'I have completed this course and understood how it applies to my work.',
  archived INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER,                      -- null until first published
  draft_rev INTEGER NOT NULL DEFAULT 0,           -- bumped on every learner-facing edit
  published_rev INTEGER,                          -- draft_rev at the last publish; differs = unpublished changes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'url')),
  url TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_course ON sources(course_id);

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id, position);

CREATE TABLE IF NOT EXISTS presenters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo_key TEXT,
  voice_model TEXT NOT NULL DEFAULT '',          -- empty: the app's default voice model
  voice TEXT NOT NULL DEFAULT '',                -- empty: the app's default voice
  consent_by TEXT,                               -- who recorded the person's consent
  consent_at TEXT,
  consent_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'video', 'quiz')),
  body TEXT NOT NULL DEFAULT '',                 -- markdown for a text lesson; the presenter's script for a video
  position INTEGER NOT NULL DEFAULT 0,
  presenter_id TEXT REFERENCES presenters(id) ON DELETE SET NULL,
  video_key TEXT,                                -- a file in the app's own storage (avatar renders, small local uploads)
  video_media_uid TEXT,                          -- or a video on the managed media service (uploads, any size)
  video_source TEXT CHECK (video_source IN ('upload', 'avatar')),
  video_status TEXT NOT NULL DEFAULT 'none' CHECK (video_status IN ('none', 'voicing', 'rendering', 'ready', 'failed')),
  video_job_id TEXT,
  video_script TEXT,                             -- the script the current video was made from
  video_error TEXT NOT NULL DEFAULT '',
  video_cost REAL,                               -- USD, as the model provider reported it
  video_step_booked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id, position);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_video ON lessons(video_status);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',            -- JSON array of strings
  correct TEXT NOT NULL DEFAULT '[]',            -- JSON array of option indexes
  explanation TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_lesson ON questions(lesson_id, position);

-- A frozen course: what learners see. Never updated once written.
CREATE TABLE IF NOT EXISTS course_versions (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  published_by TEXT,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (course_id, version)
);

-- Roles, departments, sites: whatever a company assigns training by.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  external_id TEXT NOT NULL DEFAULT '',          -- an employee number, for matching an HR export
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learner_groups (
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (learner_id, group_id)
);

-- A course is required for these groups: everyone in them gets it.
CREATE TABLE IF NOT EXISTS course_groups (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, group_id)
);

-- One person's assignment of one course. The token is their personal link.
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  course_version INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'completed', 'cancelled')),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  score INTEGER,                                 -- percent, best attempt per quiz
  attested_at TEXT,
  attestation TEXT,                              -- the exact words the person agreed to
  renew_at TEXT,                                 -- when the next assignment is due to be made
  renewed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_learner ON enrollments(learner_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_renew ON enrollments(renew_at) WHERE renewed = 0;

CREATE TABLE IF NOT EXISTS lesson_progress (
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,                       -- a lesson id inside the enrollment's snapshot
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (enrollment_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,
  answers TEXT NOT NULL,                         -- JSON: { question_id: [option indexes] }
  correct INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_enrollment ON quiz_attempts(enrollment_id, lesson_id);

-- Append-only trail of what happened to each enrollment: the audit evidence.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_enrollment ON activity(enrollment_id, id);

-- Short-lived public links to a stored file, for a model provider to fetch
-- (a presenter photo, a voice track). Never a learner-facing link.
CREATE TABLE IF NOT EXISTS media_links (
  token TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
