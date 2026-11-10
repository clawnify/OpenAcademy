// The course, its published versions, and who has to take it.
//
// Rules this file keeps, so the routes never have to:
// - Learners only see a published snapshot. A draft edit changes nothing for them.
// - An enrollment names the version it was taken on, and keeps it once started.
// - Everyone in a course's groups has exactly one open enrollment for it, unless
//   they completed it and it is not yet due for renewal.

import { get, query, run } from "./db.js";
import { InputError, addDays, addMonths, linkToken, parseJson, sqlTime, uid } from "./util.js";

// ── Rows ──────────────────────────────────────────────────────────────

export interface CourseRow {
  id: string;
  title: string;
  description: string;
  audience: string;
  language: string;
  pass_mark: number;
  due_days: number;
  renew_months: number | null;
  attestation: string;
  archived: number;
  published_version: number | null;
  draft_rev: number;
  published_rev: number | null;
  created_at: string;
  updated_at: string;
}

export interface ModuleRow {
  id: string;
  course_id: string;
  title: string;
  position: number;
}

export interface LessonRow {
  id: string;
  course_id: string;
  module_id: string;
  title: string;
  kind: "text" | "video" | "quiz";
  body: string;
  position: number;
  presenter_id: string | null;
  video_key: string | null;
  video_source: "upload" | "avatar" | null;
  video_status: "none" | "voicing" | "rendering" | "ready" | "failed";
  video_job_id: string | null;
  video_script: string | null;
  video_error: string;
  video_cost: number | null;
  video_step_booked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: string;
  lesson_id: string;
  prompt: string;
  options: string;
  correct: string;
  explanation: string;
  position: number;
}

export interface EnrollmentRow {
  id: string;
  course_id: string;
  learner_id: string;
  course_version: number;
  token: string;
  status: "assigned" | "in_progress" | "completed" | "cancelled";
  assigned_at: string;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  score: number | null;
  attested_at: string | null;
  attestation: string | null;
  renew_at: string | null;
  renewed: number;
}

export interface Question {
  id: string;
  prompt: string;
  options: string[];
  correct: number[];
  explanation: string;
}

export const presentQuestion = (q: QuestionRow): Question => ({
  id: q.id,
  prompt: q.prompt,
  options: parseJson<string[]>(q.options, []),
  correct: parseJson<number[]>(q.correct, []),
  explanation: q.explanation,
});

// ── Snapshot: what a learner sees ─────────────────────────────────────

export interface SnapshotLesson {
  id: string;
  title: string;
  kind: "text" | "video" | "quiz";
  body: string;
  video_key: string | null;
  /** True when the video is an AI-generated presenter: learners are told so. */
  ai_presenter: boolean;
  presenter_name: string | null;
  questions: Question[];
}

export interface Snapshot {
  version: number;
  course: { id: string; title: string; description: string; language: string; pass_mark: number; attestation: string };
  modules: { id: string; title: string; lessons: SnapshotLesson[] }[];
}

export function snapshotLessons(s: Snapshot): SnapshotLesson[] {
  return s.modules.flatMap((m) => m.lessons);
}

export function questionCount(s: Snapshot): number {
  return snapshotLessons(s).reduce((n, l) => n + (l.kind === "quiz" ? l.questions.length : 0), 0);
}

export async function readCourse(id: string): Promise<CourseRow> {
  const row = await get<CourseRow>("SELECT * FROM courses WHERE id = ?", [id]);
  if (!row) throw new InputError("Course not found", 404);
  return row;
}

export async function touchCourse(courseId: string): Promise<void> {
  await run("UPDATE courses SET draft_rev = draft_rev + 1, updated_at = datetime('now') WHERE id = ?", [courseId]);
}

/** The draft outline: modules in order, each with its lessons in order. */
export async function readOutline(courseId: string) {
  const modules = await query<ModuleRow>("SELECT * FROM modules WHERE course_id = ? ORDER BY position, created_at", [courseId]);
  const lessons = await query<LessonRow>("SELECT * FROM lessons WHERE course_id = ? ORDER BY position, created_at", [courseId]);
  const questions = await query<QuestionRow & { lesson_id: string }>(
    "SELECT q.* FROM questions q JOIN lessons l ON l.id = q.lesson_id WHERE l.course_id = ? ORDER BY q.position",
    [courseId],
  );
  const byLesson = new Map<string, Question[]>();
  for (const q of questions) {
    const list = byLesson.get(q.lesson_id) ?? [];
    list.push(presentQuestion(q));
    byLesson.set(q.lesson_id, list);
  }
  return modules.map((m) => ({
    ...m,
    lessons: lessons.filter((l) => l.module_id === m.id).map((l) => ({ ...l, questions: byLesson.get(l.id) ?? [] })),
  }));
}

/** Everything that would stop a course from being published, in words a person can act on. */
export async function publishProblems(courseId: string): Promise<string[]> {
  const outline = await readOutline(courseId);
  const problems: string[] = [];
  const lessons = outline.flatMap((m) => m.lessons);
  if (!lessons.length) problems.push("The course has no lessons yet.");
  for (const m of outline) if (!m.lessons.length) problems.push(`Module "${m.title}" has no lessons.`);
  for (const l of lessons) {
    if (l.kind === "text" && !l.body.trim()) problems.push(`Lesson "${l.title}" has no text.`);
    if (l.kind === "video" && l.video_status !== "ready") {
      problems.push(
        l.video_status === "voicing" || l.video_status === "rendering"
          ? `The video for "${l.title}" is still being made.`
          : `Lesson "${l.title}" has no video yet.`,
      );
    }
    if (l.kind === "video" && l.video_status === "ready" && l.video_source === "avatar" && l.video_script !== null && l.video_script.trim() !== l.body.trim()) {
      problems.push(`The script of "${l.title}" changed after its video was made. Make the video again, or undo the script change.`);
    }
    if (l.kind === "quiz") {
      if (!l.questions.length) problems.push(`Quiz "${l.title}" has no questions.`);
      for (const q of l.questions) {
        if (q.options.length < 2) problems.push(`A question in "${l.title}" needs at least two answers.`);
        if (!q.correct.length) problems.push(`A question in "${l.title}" has no correct answer marked.`);
      }
    }
  }
  return problems;
}

/** Freeze the draft as the next version, then bring assignments up to date. */
export async function publishCourse(courseId: string, opts: { notes?: string; by: string | null; retrain?: boolean }) {
  const course = await readCourse(courseId);
  const problems = await publishProblems(courseId);
  if (problems.length) throw new InputError(problems.join(" "), 422, "not_ready");

  const outline = await readOutline(courseId);
  const presenters = new Map(
    (await query<{ id: string; name: string }>("SELECT id, name FROM presenters")).map((p) => [p.id, p.name]),
  );
  const version = (course.published_version ?? 0) + 1;
  const snapshot: Snapshot = {
    version,
    course: {
      id: course.id, title: course.title, description: course.description, language: course.language,
      pass_mark: course.pass_mark, attestation: course.attestation,
    },
    modules: outline.map((m) => ({
      id: m.id,
      title: m.title,
      lessons: m.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        kind: l.kind,
        body: l.body,
        video_key: l.kind === "video" ? l.video_key : null,
        ai_presenter: l.kind === "video" && l.video_source === "avatar",
        presenter_name: l.kind === "video" && l.presenter_id ? presenters.get(l.presenter_id) ?? null : null,
        questions: l.kind === "quiz" ? l.questions : [],
      })),
    })),
  };
  await run("INSERT INTO course_versions (course_id, version, snapshot, notes, published_by) VALUES (?, ?, ?, ?, ?)", [
    courseId, version, JSON.stringify(snapshot), opts.notes ?? "", opts.by,
  ]);
  await run("UPDATE courses SET published_version = ?, published_rev = ?, updated_at = datetime('now') WHERE id = ?", [version, course.draft_rev, courseId]);

  // Nobody has opened these yet, so they simply move to the new version.
  await run("UPDATE enrollments SET course_version = ? WHERE course_id = ? AND status = 'assigned'", [version, courseId]);

  // "The procedure changed, everyone retakes it": completed people get a fresh assignment now.
  let retrained = 0;
  if (opts.retrain) {
    const done = await query<{ id: string; learner_id: string }>(
      `SELECT e.id, e.learner_id FROM enrollments e
        WHERE e.course_id = ? AND e.status = 'completed' AND e.renewed = 0`,
      [courseId],
    );
    for (const e of done) {
      await run("UPDATE enrollments SET renewed = 1 WHERE id = ?", [e.id]);
      if (await openEnrollment(courseId, e.learner_id)) continue;
      await createEnrollment(courseId, e.learner_id, version, { due_days: (await readCourse(courseId)).due_days, reason: `Version ${version} published` });
      retrained++;
    }
  }
  const assigned = await syncCourse(courseId);
  return { version, assigned: assigned + retrained };
}

export async function readSnapshot(courseId: string, version: number): Promise<Snapshot> {
  const row = await get<{ snapshot: string }>("SELECT snapshot FROM course_versions WHERE course_id = ? AND version = ?", [courseId, version]);
  if (!row) throw new InputError("That version of the course does not exist", 404);
  return JSON.parse(row.snapshot) as Snapshot;
}

// ── Assignments ───────────────────────────────────────────────────────

async function openEnrollment(courseId: string, learnerId: string) {
  return get<EnrollmentRow>(
    "SELECT * FROM enrollments WHERE course_id = ? AND learner_id = ? AND status IN ('assigned', 'in_progress') LIMIT 1",
    [courseId, learnerId],
  );
}

export async function logActivity(enrollmentId: string, kind: string, detail = ""): Promise<void> {
  await run("INSERT INTO activity (enrollment_id, kind, detail) VALUES (?, ?, ?)", [enrollmentId, kind, detail]);
}

export async function createEnrollment(
  courseId: string,
  learnerId: string,
  version: number,
  opts: { due_days: number; due_at?: string | null; reason: string },
): Promise<EnrollmentRow> {
  const id = uid();
  const due = opts.due_at !== undefined ? opts.due_at : opts.due_days > 0 ? sqlTime(addDays(new Date(), opts.due_days)) : null;
  await run(
    "INSERT INTO enrollments (id, course_id, learner_id, course_version, token, due_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, courseId, learnerId, version, linkToken(), due],
  );
  await logActivity(id, "assigned", opts.reason);
  return (await get<EnrollmentRow>("SELECT * FROM enrollments WHERE id = ?", [id]))!;
}

/**
 * Give everyone in the course's groups an assignment they are missing. Returns
 * how many were created. A learner is covered by an open assignment, or by a
 * completion that is not due for renewal.
 */
export async function syncCourse(courseId: string): Promise<number> {
  const course = await readCourse(courseId);
  if (!course.published_version || course.archived) return 0;
  const missing = await query<{ learner_id: string }>(
    `SELECT DISTINCT lg.learner_id FROM course_groups cg
       JOIN learner_groups lg ON lg.group_id = cg.group_id
       JOIN learners l ON l.id = lg.learner_id AND l.active = 1
      WHERE cg.course_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM enrollments e WHERE e.course_id = cg.course_id AND e.learner_id = lg.learner_id
            AND (e.status IN ('assigned', 'in_progress')
                 OR (e.status = 'completed' AND e.renewed = 0 AND (e.renew_at IS NULL OR e.renew_at > datetime('now')))))`,
    [courseId],
  );
  for (const m of missing) {
    await createEnrollment(courseId, m.learner_id, course.published_version, { due_days: course.due_days, reason: "Required for their group" });
  }
  return missing.length;
}

/** Bring every published course up to date: renewals due, and new group members. */
export async function syncAll(): Promise<number> {
  const due = await query<{ id: string }>(
    "SELECT id FROM enrollments WHERE status = 'completed' AND renewed = 0 AND renew_at IS NOT NULL AND renew_at <= datetime('now') LIMIT 500",
  );
  for (const e of due) await run("UPDATE enrollments SET renewed = 1 WHERE id = ?", [e.id]);
  const courses = await query<{ id: string }>("SELECT id FROM courses WHERE published_version IS NOT NULL AND archived = 0");
  let n = 0;
  for (const c of courses) n += await syncCourse(c.id);
  return n;
}

// ── Taking the course ─────────────────────────────────────────────────

export async function enrollmentByToken(token: string): Promise<EnrollmentRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return (await get<EnrollmentRow>("SELECT * FROM enrollments WHERE token = ?", [token])) ?? null;
}

export async function startIfNeeded(e: EnrollmentRow): Promise<void> {
  if (e.status !== "assigned") return;
  await run("UPDATE enrollments SET status = 'in_progress', started_at = datetime('now') WHERE id = ? AND status = 'assigned'", [e.id]);
  await logActivity(e.id, "started", `Version ${e.course_version}`);
  e.status = "in_progress";
}

export async function doneLessons(enrollmentId: string): Promise<Set<string>> {
  const rows = await query<{ lesson_id: string }>("SELECT lesson_id FROM lesson_progress WHERE enrollment_id = ?", [enrollmentId]);
  return new Set(rows.map((r) => r.lesson_id));
}

export async function markLessonDone(e: EnrollmentRow, lesson: SnapshotLesson): Promise<void> {
  const r = await run("INSERT OR IGNORE INTO lesson_progress (enrollment_id, lesson_id) VALUES (?, ?)", [e.id, lesson.id]);
  if (r.changes > 0) await logActivity(e.id, "lesson_done", lesson.title);
}

/** Score a quiz attempt. Only an exact match of the marked answers counts as correct. */
export function scoreQuiz(lesson: SnapshotLesson, answers: Record<string, number[]>) {
  let correct = 0;
  const results = lesson.questions.map((q) => {
    const given = [...new Set(answers[q.id] ?? [])].sort((a, b) => a - b);
    const want = [...q.correct].sort((a, b) => a - b);
    const ok = given.length === want.length && given.every((v, i) => v === want[i]);
    if (ok) correct++;
    return { id: q.id, ok, given };
  });
  return { correct, total: lesson.questions.length, results };
}

/** Best attempt per quiz, as the percent over every question in the course. */
export async function courseScore(e: EnrollmentRow, snapshot: Snapshot): Promise<{ percent: number | null; perQuiz: Map<string, { correct: number; total: number }> }> {
  const rows = await query<{ lesson_id: string; correct: number; total: number }>(
    "SELECT lesson_id, MAX(correct) correct, MAX(total) total FROM quiz_attempts WHERE enrollment_id = ? GROUP BY lesson_id",
    [e.id],
  );
  const perQuiz = new Map(rows.map((r) => [r.lesson_id, { correct: r.correct, total: r.total }]));
  const total = questionCount(snapshot);
  if (!total) return { percent: null, perQuiz };
  let correct = 0;
  for (const l of snapshotLessons(snapshot)) if (l.kind === "quiz") correct += perQuiz.get(l.id)?.correct ?? 0;
  return { percent: Math.round((correct / total) * 100), perQuiz };
}

export function quizPassed(best: { correct: number; total: number } | undefined, passMark: number): boolean {
  if (!best || !best.total) return false;
  return (best.correct / best.total) * 100 >= passMark;
}

/** Every lesson done and every quiz at the pass mark: the person may attest. */
export async function readyToAttest(e: EnrollmentRow, snapshot: Snapshot): Promise<boolean> {
  const done = await doneLessons(e.id);
  const { perQuiz } = await courseScore(e, snapshot);
  return snapshotLessons(snapshot).every((l) =>
    l.kind === "quiz" ? quizPassed(perQuiz.get(l.id), snapshot.course.pass_mark) : done.has(l.id),
  );
}

export async function completeEnrollment(e: EnrollmentRow, snapshot: Snapshot): Promise<void> {
  if (e.status === "completed") return;
  if (!(await readyToAttest(e, snapshot))) throw new InputError("Finish every lesson and pass every quiz first.", 409);
  const course = await readCourse(e.course_id);
  const { percent } = await courseScore(e, snapshot);
  const now = new Date();
  const renewAt = course.renew_months ? sqlTime(addMonths(now, course.renew_months)) : null;
  await run(
    `UPDATE enrollments SET status = 'completed', completed_at = ?, attested_at = ?, attestation = ?, score = ?, renew_at = ?
      WHERE id = ? AND status != 'completed'`,
    [sqlTime(now), sqlTime(now), snapshot.course.attestation, percent, renewAt, e.id],
  );
  await logActivity(e.id, "attested", snapshot.course.attestation);
  await logActivity(e.id, "completed", percent === null ? "No quiz" : `Score ${percent}%`);
}

// ── Reading enrollments ───────────────────────────────────────────────

export const ENROLLMENT_SELECT = `e.*, l.name learner_name, l.email learner_email, l.external_id learner_external_id,
  c.title course_title,
  CASE WHEN e.status IN ('assigned', 'in_progress') AND e.due_at IS NOT NULL AND e.due_at < datetime('now') THEN 1 ELSE 0 END overdue
  FROM enrollments e JOIN learners l ON l.id = e.learner_id JOIN courses c ON c.id = e.course_id`;

export type EnrollmentListRow = EnrollmentRow & {
  learner_name: string;
  learner_email: string;
  learner_external_id: string;
  course_title: string;
  overdue: number;
};

export function presentEnrollment(r: EnrollmentListRow, origin: string) {
  const { token, renewed, overdue, ...rest } = r;
  return { ...rest, overdue: Boolean(overdue), renewed: Boolean(renewed), link: `${origin}/learn/${token}` };
}
