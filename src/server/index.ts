import { caller, createApp, createRoute, hasRole, pagedResponse, pageParams, PageQuery, user, widgets, z } from "@clawnify/app";
import { verifyDelivery } from "@clawnify/queue";
import { renderMarkdown as pageAsMarkdown, ClawnifyServicesError } from "@clawnify/services";
import type { Context } from "hono";
import { get, initDB, query, run } from "./db.js";
import { cleanDraft, draftCourse, listModels, pickTextModel, SOURCE_BUDGET, type DraftCourse } from "./ai.js";
import {
  ENROLLMENT_SELECT, createEnrollment, presentEnrollment, presentQuestion, publishCourse, publishProblems, readCourse,
  readOutline, readSnapshot, syncAll, syncCourse, touchCourse, type CourseRow, type EnrollmentListRow, type LessonRow, type QuestionRow,
} from "./course.js";
import { attemptsFor, registerLearn } from "./learn.js";
import { deleteUpload, hasUploads, initUploads, putUpload, serveUpload } from "./uploads.js";
import { InputError, parseJson, uid } from "./util.js";
import { readSettings } from "./settings.js";
import { importPeople } from "./people.js";
import { SCRIPT_MAX, advanceVideo, mediaKeyForLink, rebookStalled, startAvatarVideo } from "./video.js";

type Bindings = {
  DB?: D1Database;
  STORAGE?: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  UPLOADS?: R2Bucket;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  CLAWNIFY_TOKEN?: string;
  CLAWNIFY_QUEUE_URL?: string;
  SERVICES_URL?: string;
};
type Env = { Bindings: Bindings };
type C = Context<Env>;

const app = createApp<Env>({
  title: "OpenAcademy",
  version: "1.0.0",
  description:
    "Training courses built from an organisation's own documents: modules of text, presenter-video and quiz lessons, published as versions, " +
    "assigned to groups of people who take them from a personal link, with the record of who completed which version and when.",
});

app.use("*", async (c, next) => {
  initDB(c.env as never);
  initUploads(c.env.UPLOADS);
  await next();
});

app.onError((err, c) => {
  if (err instanceof InputError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  if (err instanceof ClawnifyServicesError) return c.json({ error: err.message, code: err.code }, 502);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

const origin = (c: C) => new URL(c.req.url).origin;

/** A person at the keyboard (or their own access token), never an agent or another app. Local dev counts as a person. */
function person(c: C): { name: string } | null {
  const who = caller(c);
  const u = user(c);
  if ((who === "user" || who === "api") && u) return { name: u.name || u.email || "A teammate" };
  if (who === "public" && !c.env.CLAWNIFY_TOKEN) return { name: "Local" };
  return null;
}

function requirePerson(c: C, what: string): { name: string } {
  const p = person(c);
  if (!p) throw new InputError(`Only a person can ${what}. Ask them to do it in the app.`, 403, "needs_person");
  return p;
}

/** Admin-only tasks; on plans without roles every person passes. Local dev passes. */
function requireAdmin(c: C, what: string): void {
  if (caller(c) === "public" && !c.env.CLAWNIFY_TOKEN) return;
  if (!hasRole(c, "admin")) throw new InputError(`Only an admin can ${what}.`, 403, "needs_admin");
}

// ── Schemas and route helpers ─────────────────────────────────────────

const Err = z.object({ error: z.string(), code: z.string().optional() }).openapi("Error");
const errors = {
  400: { description: "Invalid input", content: { "application/json": { schema: Err } } },
  403: { description: "Not allowed for this caller", content: { "application/json": { schema: Err } } },
  404: { description: "Not found", content: { "application/json": { schema: Err } } },
  409: { description: "Conflict", content: { "application/json": { schema: Err } } },
  422: { description: "Not ready", content: { "application/json": { schema: Err } } },
};
const Loose = z.object({}).passthrough();

type Method = "get" | "post" | "patch" | "put" | "delete";

/** One route: path params are read from `{name}` in the path. */
function def(
  method: Method,
  path: string,
  summary: string,
  opts: { body?: z.ZodTypeAny; query?: z.AnyZodObject; res?: z.ZodTypeAny; status?: 200 | 201 | 202; description?: string; paged?: [string, z.ZodTypeAny] } = {},
) {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const params = names.length
    ? z.object(Object.fromEntries(names.map((n) => [n, z.string().min(1).max(100).openapi({ param: { name: n, in: "path" } })])))
    : undefined;
  const status = opts.status ?? (method === "post" ? 201 : 200);
  return createRoute({
    method,
    path,
    summary,
    ...(opts.description ? { description: opts.description } : {}),
    request: {
      ...(params ? { params } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.body ? { body: { content: { "application/json": { schema: opts.body } }, required: true } } : {}),
    },
    responses: {
      [status]: opts.paged
        ? pagedResponse(opts.paged[0], opts.paged[1])
        : { description: "OK", content: { "application/json": { schema: opts.res ?? Loose } } },
      ...errors,
    },
  });
}

const ok = (c: C, body: unknown, status: 200 | 201 | 202 = 200) => c.json(body as never, status);

type DefOpts<B, Q> = { body?: B; query?: Q; res?: z.ZodTypeAny; status?: 200 | 201 | 202; description?: string; paged?: [string, z.ZodTypeAny] };

/**
 * Register a documented route. The body and query types come from their own
 * schemas, which @hono/zod-openapi has already validated by the time the
 * handler runs.
 */
type Handler<B extends z.ZodTypeAny, Q extends z.AnyZodObject> = (c: C, input: { json: z.infer<B>; query: z.infer<Q> }) => Promise<Response>;

function api(method: Method, path: string, summary: string, handler: Handler<z.ZodUndefined, z.ZodObject<{}>>): void;
function api<B extends z.ZodTypeAny = z.ZodUndefined, Q extends z.AnyZodObject = z.ZodObject<{}>>(
  method: Method, path: string, summary: string, opts: DefOpts<B, Q>, handler: Handler<B, Q>,
): void;
function api(method: Method, path: string, summary: string, a: unknown, b?: unknown): void {
  const opts = (typeof a === "function" ? {} : a) as DefOpts<z.ZodTypeAny, z.AnyZodObject>;
  const handler = (typeof a === "function" ? a : b) as Handler<z.ZodTypeAny, z.AnyZodObject>;
  app.openapi(def(method, path, summary, opts) as never, (async (c: C) =>
    handler(c, { json: c.req.valid("json" as never), query: c.req.valid("query" as never) } as never)) as never);
}
const param = (c: C, name: string) => c.req.param(name)!;

const Kind = z.enum(["text", "video", "quiz"]);

const CourseFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().openapi({ description: "Markdown shown to learners before they start" }),
  audience: z.string().max(1000).optional().openapi({ description: "Who takes it; guides the AI draft" }),
  language: z.string().trim().min(2).max(40).optional().openapi({ description: "Language the course is written in, e.g. English, Deutsch" }),
  pass_mark: z.number().int().min(0).max(100).optional().openapi({ description: "Percent each quiz needs to pass" }),
  due_days: z.number().int().min(0).max(365).optional().openapi({ description: "Days a person has once assigned; 0 = no due date" }),
  renew_months: z.number().int().min(1).max(60).nullable().optional().openapi({ description: "Assign again this many months after completion; null = once" }),
  attestation: z.string().trim().min(1).max(600).optional().openapi({ description: "What the learner confirms when finishing" }),
  archived: z.boolean().optional(),
});

const Course = z.object({
  id: z.string(), title: z.string(), description: z.string(), audience: z.string(), language: z.string(), pass_mark: z.number(),
  due_days: z.number(), renew_months: z.number().nullable(), attestation: z.string(), archived: z.boolean(),
  published_version: z.number().nullable(), unpublished_changes: z.boolean(), created_at: z.string(), updated_at: z.string(),
  counts: z.object({ modules: z.number(), lessons: z.number(), open: z.number(), overdue: z.number(), completed: z.number(), groups: z.number() }),
}).openapi("Course");

const Question = z.object({
  id: z.string(), prompt: z.string(), options: z.array(z.string()), correct: z.array(z.number()), explanation: z.string(),
}).openapi("Question");

const Lesson = z.object({
  id: z.string(), course_id: z.string(), module_id: z.string(), title: z.string(), kind: Kind,
  body: z.string().openapi({ description: "Markdown for a text lesson; the presenter's script for a video lesson" }),
  position: z.number(), presenter_id: z.string().nullable(),
  video: z.object({
    status: z.enum(["none", "voicing", "rendering", "ready", "failed"]), source: z.enum(["upload", "avatar"]).nullable(),
    error: z.string(), cost: z.number().nullable(), script_changed: z.boolean(), url: z.string().nullable(),
  }),
  questions: z.array(Question),
}).openapi("Lesson");

const Enrollment = z.object({
  id: z.string(), course_id: z.string(), course_title: z.string(), learner_id: z.string(), learner_name: z.string(), learner_email: z.string(),
  learner_external_id: z.string(), course_version: z.number(), status: z.enum(["assigned", "in_progress", "completed", "cancelled"]),
  overdue: z.boolean(), assigned_at: z.string(), due_at: z.string().nullable(), started_at: z.string().nullable(),
  completed_at: z.string().nullable(), score: z.number().nullable(), attested_at: z.string().nullable(), attestation: z.string().nullable(),
  renew_at: z.string().nullable(), renewed: z.boolean(), link: z.string().openapi({ description: "The person's own link to take the course. Treat it like a password." }),
}).openapi("Enrollment");

// ── Presenters (shared shapes) ────────────────────────────────────────

function presentLesson(l: LessonRow & { questions?: unknown[] }, base: string) {
  return {
    id: l.id, course_id: l.course_id, module_id: l.module_id, title: l.title, kind: l.kind, body: l.body, position: l.position,
    presenter_id: l.presenter_id,
    video: {
      status: l.video_status, source: l.video_source, error: l.video_error, cost: l.video_cost,
      script_changed: l.video_source === "avatar" && l.video_status === "ready" && (l.video_script ?? "").trim() !== l.body.trim(),
      url: l.video_key ? `${base}/api/lessons/${l.id}/video/file?v=${encodeURIComponent(l.video_key.split("/").pop()!)}` : null,
    },
    questions: (l.questions ?? []) as never[],
  };
}

async function courseCounts(id: string) {
  const r = await get<{ modules: number; lessons: number; open: number; overdue: number; completed: number; groups: number }>(
    `SELECT (SELECT COUNT(*) FROM modules WHERE course_id = ?1) modules,
            (SELECT COUNT(*) FROM lessons WHERE course_id = ?1) lessons,
            (SELECT COUNT(*) FROM enrollments WHERE course_id = ?1 AND status IN ('assigned', 'in_progress')) open,
            (SELECT COUNT(*) FROM enrollments WHERE course_id = ?1 AND status IN ('assigned', 'in_progress') AND due_at < datetime('now')) overdue,
            (SELECT COUNT(DISTINCT learner_id) FROM enrollments WHERE course_id = ?1 AND status = 'completed') completed,
            (SELECT COUNT(*) FROM course_groups WHERE course_id = ?1) groups`,
    [id],
  );
  return r!;
}

async function presentCourse(row: CourseRow) {
  const { draft_rev: _d, published_rev: _p, ...rest } = row;
  return {
    ...rest,
    archived: Boolean(row.archived),
    unpublished_changes: !row.published_version || row.draft_rev !== row.published_rev,
    counts: await courseCounts(row.id),
  };
}

async function courseOfLesson(lessonId: string): Promise<LessonRow> {
  const l = await get<LessonRow>("SELECT * FROM lessons WHERE id = ?", [lessonId]);
  if (!l) throw new InputError("Lesson not found", 404);
  return l;
}

async function lessonView(id: string, base: string) {
  const l = await courseOfLesson(id);
  const qs = await query<QuestionRow>("SELECT * FROM questions WHERE lesson_id = ? ORDER BY position", [id]);
  return presentLesson({ ...l, questions: qs.map(presentQuestion) }, base);
}

async function nextPosition(table: "modules" | "lessons" | "questions", column: string, id: string): Promise<number> {
  return ((await get<{ n: number | null }>(`SELECT MAX(position) n FROM ${table} WHERE ${column} = ?`, [id]))?.n ?? -1) + 1;
}

// ── Courses ───────────────────────────────────────────────────────────

api("get", "/api/courses", "List courses", {
    query: PageQuery.extend({ archived: z.enum(["true", "false"]).optional() }),
    paged: ["courses", Course],
  },
  async (c, input) => {
    const q = input.query;
    const { page, limit, offset, search } = pageParams(q);
    const where = ["archived = ?"];
    const args: unknown[] = [q.archived === "true" ? 1 : 0];
    if (search) { where.push("title LIKE ?"); args.push(`%${search}%`); }
    const rows = await query<CourseRow>(`SELECT * FROM courses WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM courses WHERE ${where.join(" AND ")}`, args))?.n ?? 0;
    return ok(c, { courses: await Promise.all(rows.map(presentCourse)), total, page, limit });
  },
);

api("post", "/api/courses", "Create a course", { body: CourseFields.extend({ id: z.string().uuid().optional() }), res: Course },
  async (c, input) => {
    const b = input.json;
    const id = b.id ?? uid();
    const exists = await get("SELECT id FROM courses WHERE id = ?", [id]);
    if (exists) return ok(c, await presentCourse(await readCourse(id)), 201); // a retried create
    await run(
      `INSERT INTO courses (id, title, description, audience, language, pass_mark, due_days, renew_months
       ${b.attestation ? ", attestation" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${b.attestation ? ", ?" : ""})`,
      [id, b.title, b.description ?? "", b.audience ?? "", b.language ?? "English", b.pass_mark ?? 80, b.due_days ?? 30, b.renew_months ?? null,
        ...(b.attestation ? [b.attestation] : [])],
    );
    return ok(c, await presentCourse(await readCourse(id)), 201);
  },
);

api("get", "/api/courses/{id}", "A course with its full draft outline, required groups, versions and what blocks publishing", {
    description: "The outline is modules → lessons → questions, in order. `problems` lists what must be fixed before Publish works.",
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const base = origin(c);
    const outline = (await readOutline(course.id)).map((m) => ({ ...m, lessons: m.lessons.map((l) => presentLesson(l, base)) }));
    const groups = await query<{ id: string; name: string }>(
      "SELECT g.id, g.name FROM course_groups cg JOIN groups g ON g.id = cg.group_id WHERE cg.course_id = ? ORDER BY g.name",
      [course.id],
    );
    const versions = await query<{ version: number; notes: string; published_by: string | null; published_at: string }>(
      "SELECT version, notes, published_by, published_at FROM course_versions WHERE course_id = ? ORDER BY version DESC LIMIT 10",
      [course.id],
    );
    const sources = (await get<{ n: number }>("SELECT COUNT(*) n FROM sources WHERE course_id = ?", [course.id]))?.n ?? 0;
    return ok(c, { ...(await presentCourse(course)), modules: outline, groups, versions, sources, problems: await publishProblems(course.id) });
  },
);

api("patch", "/api/courses/{id}", "Change a course's settings (only the fields sent)", { body: CourseFields.partial(), res: Course },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const b = input.json;
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(k === "archived" ? (v ? 1 : 0) : v);
    }
    if (sets.length) {
      const learnerFacing = Object.keys(b).some((k) => ["title", "description", "language", "pass_mark", "attestation"].includes(k));
      await run(`UPDATE courses SET ${sets.join(", ")}, updated_at = datetime('now')${learnerFacing ? ", draft_rev = draft_rev + 1" : ""} WHERE id = ?`, [...args, course.id]);
    }
    return ok(c, await presentCourse(await readCourse(course.id)));
  },
);

api("delete", "/api/courses/{id}", "Delete a course that was never published (archive a published one instead)",
  async (c, input) => {
    requireAdmin(c, "delete a course");
    const course = await readCourse(param(c, "id"));
    if (course.published_version) throw new InputError("This course has been published, so its records must be kept. Archive it instead.", 409, "published");
    await run("DELETE FROM courses WHERE id = ?", [course.id]);
    return ok(c, { ok: true });
  },
);

api("post", "/api/courses/{id}/publish", "Publish the draft as a new version and assign it", {
    body: z.object({
      notes: z.string().max(1000).optional().openapi({ description: "What changed, kept with the version" }),
      retrain: z.boolean().optional().openapi({ description: "Everyone who completed an earlier version takes the new one" }),
    }),
    status: 200,
    description: "A person must publish: it sends the course to everyone in its groups. Agents get 403.",
  },
  async (c, input) => {
    const who = requirePerson(c, "publish a course");
    const b = input.json;
    const out = await publishCourse(param(c, "id"), { notes: b.notes, retrain: b.retrain, by: who.name });
    return ok(c, out);
  },
);

api("get", "/api/courses/{id}/versions/{version}", "A published version exactly as learners see it",
  async (c, input) => {
    const version = Number(param(c, "version"));
    if (!Number.isInteger(version)) throw new InputError("version must be a number");
    return ok(c, await readSnapshot(param(c, "id"), version));
  },
);

api("put", "/api/courses/{id}/groups", "Set which groups must take the course", {
    body: z.object({ group_ids: z.array(z.string()).max(200) }),
    status: 200,
    description: "Everyone in these groups gets an assignment once the course is published. Removing a group cancels nothing already assigned.",
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const { group_ids } = input.json;
    await run("DELETE FROM course_groups WHERE course_id = ?", [course.id]);
    for (const g of [...new Set(group_ids)]) {
      if (!(await get("SELECT id FROM groups WHERE id = ?", [g]))) throw new InputError(`Group ${g} not found`, 404);
      await run("INSERT INTO course_groups (course_id, group_id) VALUES (?, ?)", [course.id, g]);
    }
    const assigned = await syncCourse(course.id);
    return ok(c, { group_ids, assigned });
  },
);

// ── Sources and the AI draft ──────────────────────────────────────────

const Source = z.object({
  id: z.string(), course_id: z.string(), title: z.string(), kind: z.enum(["text", "url"]), url: z.string(),
  chars: z.number(), excerpt: z.string(), created_at: z.string(),
}).openapi("Source");

api("get", "/api/courses/{id}/sources", "The documents a course is drafted from (text excerpt only)", { query: PageQuery, paged: ["sources", Source] },
  async (c, input) => {
    const { page, limit, offset } = pageParams(input.query);
    const id = param(c, "id");
    const rows = await query<{ id: string; course_id: string; title: string; kind: "text" | "url"; url: string; chars: number; excerpt: string; created_at: string }>(
      "SELECT id, course_id, title, kind, url, LENGTH(body) chars, SUBSTR(body, 1, 280) excerpt, created_at FROM sources WHERE course_id = ? ORDER BY created_at LIMIT ? OFFSET ?",
      [id, limit, offset],
    );
    const total = (await get<{ n: number }>("SELECT COUNT(*) n FROM sources WHERE course_id = ?", [id]))?.n ?? 0;
    return ok(c, { sources: rows, total, page, limit });
  },
);

api("post", "/api/courses/{id}/sources", "Add a source document: its text, or a web page to read", {
    body: z.object({
      title: z.string().trim().max(200).optional(),
      body: z.string().max(400_000).optional().openapi({ description: "The document's text (Markdown or plain). Extract PDFs and Word files to text first." }),
      url: z.string().url().max(2000).optional().openapi({ description: "A public web page to read instead of body (one services call)" }),
    }),
    res: Source,
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const b = input.json;
    let body = b.body?.trim() ?? "";
    let title = b.title?.trim() ?? "";
    if (!body && b.url) {
      if (!c.env.CLAWNIFY_TOKEN) throw new InputError("Reading a web page needs the app deployed on Clawnify. Paste the text instead.", 503, "no_services");
      const page = await pageAsMarkdown(c.env as never, { url: b.url });
      body = page.markdown.trim();
      title ||= body.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(b.url).hostname;
    }
    if (!body) throw new InputError("Send the document's text in body, or a url to read.");
    const id = uid();
    await run("INSERT INTO sources (id, course_id, title, kind, url, body) VALUES (?, ?, ?, ?, ?, ?)", [
      id, course.id, title || body.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 120) || "Document", b.url && !b.body ? "url" : "text", b.url ?? "", body,
    ]);
    const row = await get("SELECT id, course_id, title, kind, url, LENGTH(body) chars, SUBSTR(body, 1, 280) excerpt, created_at FROM sources WHERE id = ?", [id]);
    return ok(c, row, 201);
  },
);

api("get", "/api/sources/{id}", "A source document in full", async (c, input) => {
  const row = await get("SELECT * FROM sources WHERE id = ?", [param(c, "id")]);
  if (!row) throw new InputError("Source not found", 404);
  return ok(c, row);
});

api("delete", "/api/sources/{id}", "Remove a source document", async (c, input) => {
  await run("DELETE FROM sources WHERE id = ?", [param(c, "id")]);
  return ok(c, { ok: true });
});

async function writeDraft(courseId: string, draft: DraftCourse): Promise<void> {
  let mpos = await nextPosition("modules", "course_id", courseId);
  for (const m of draft.modules) {
    const mid = uid();
    await run("INSERT INTO modules (id, course_id, title, position) VALUES (?, ?, ?, ?)", [mid, courseId, m.title, mpos++]);
    let lpos = 0;
    for (const l of m.lessons) {
      const lid = uid();
      await run("INSERT INTO lessons (id, course_id, module_id, title, kind, body, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        lid, courseId, mid, l.title, l.kind, l.body, lpos++,
      ]);
      let qpos = 0;
      for (const q of l.questions) {
        await run("INSERT INTO questions (id, lesson_id, prompt, options, correct, explanation, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          uid(), lid, q.prompt, JSON.stringify(q.options), JSON.stringify(q.correct), q.explanation, qpos++,
        ]);
      }
    }
  }
  await touchCourse(courseId);
}

const DraftShape = z.object({
  modules: z.array(z.object({
    title: z.string(),
    lessons: z.array(z.object({
      title: z.string(), kind: Kind, body: z.string().default(""),
      questions: z.array(z.object({ prompt: z.string(), options: z.array(z.string()), correct: z.array(z.number().int()), explanation: z.string().default("") })).default([]),
    })),
  })).min(1).max(30),
});

api("post", "/api/courses/{id}/draft", "Draft the course outline from its sources with AI (spends AI credits)", {
    body: z.object({
      instructions: z.string().max(4000).optional().openapi({ description: "What to focus on, what to leave out, the tone" }),
      video_lessons: z.boolean().optional().openapi({ description: "Start each module with a presenter-video script. Default true" }),
      replace: z.boolean().optional().openapi({ description: "Delete the current outline first. Without it, a course that has modules is refused" }),
    }),
    status: 200,
    description: "One model call over every source (up to about 150,000 characters). Writes modules, lessons and quizzes into the draft; nothing is published.",
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const b = input.json;
    const has = (await get<{ n: number }>("SELECT COUNT(*) n FROM modules WHERE course_id = ?", [course.id]))?.n ?? 0;
    if (has && !b.replace) throw new InputError("The course already has an outline. Send replace: true to draft a new one in its place.", 409, "has_outline");
    const sources = await query<{ title: string; body: string }>("SELECT title, body FROM sources WHERE course_id = ? ORDER BY created_at", [course.id]);
    if (!sources.length) throw new InputError("Add at least one source document first: the course is drafted from them.", 422, "no_sources");
    const settings = await readSettings();
    const model = await pickTextModel(c.env, settings.text_model);
    const draft = await draftCourse(c.env, model, {
      title: course.title, audience: course.audience, language: course.language, instructions: b.instructions ?? "",
      sources, videoLessons: b.video_lessons ?? true,
    });
    if (has) await run("DELETE FROM modules WHERE course_id = ?", [course.id]);
    await writeDraft(course.id, draft);
    const chars = sources.reduce((n, s) => n + s.body.length, 0);
    return ok(c, {
      model,
      modules: draft.modules.length,
      lessons: draft.modules.reduce((n, m) => n + m.lessons.length, 0),
      truncated: chars > SOURCE_BUDGET ? `Only the first ${SOURCE_BUDGET.toLocaleString("en")} of ${chars.toLocaleString("en")} characters of source were read.` : null,
    });
  },
);

api("post", "/api/courses/{id}/outline", "Add a whole outline written by you (no AI call)", {
    body: DraftShape,
    description: "The same shape the AI draft writes: modules → lessons (text | video | quiz) → questions. Appended after any existing modules.",
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const draft = cleanDraft(input.json as DraftCourse);
    await writeDraft(course.id, draft);
    return ok(c, { modules: draft.modules.length }, 201);
  },
);

// ── Outline: modules, lessons, order ──────────────────────────────────

api("post", "/api/courses/{id}/modules", "Add a module", { body: z.object({ title: z.string().trim().min(1).max(200) }) },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const id = uid();
    await run("INSERT INTO modules (id, course_id, title, position) VALUES (?, ?, ?, ?)", [id, course.id, input.json.title, await nextPosition("modules", "course_id", course.id)]);
    await touchCourse(course.id);
    return ok(c, await get("SELECT * FROM modules WHERE id = ?", [id]), 201);
  },
);

api("patch", "/api/modules/{id}", "Rename a module", { body: z.object({ title: z.string().trim().min(1).max(200) }) },
  async (c, input) => {
    const m = await get<{ course_id: string }>("SELECT course_id FROM modules WHERE id = ?", [param(c, "id")]);
    if (!m) throw new InputError("Module not found", 404);
    await run("UPDATE modules SET title = ? WHERE id = ?", [input.json.title, param(c, "id")]);
    await touchCourse(m.course_id);
    return ok(c, await get("SELECT * FROM modules WHERE id = ?", [param(c, "id")]));
  },
);

api("delete", "/api/modules/{id}", "Delete a module and its lessons from the draft", async (c, input) => {
  const m = await get<{ course_id: string }>("SELECT course_id FROM modules WHERE id = ?", [param(c, "id")]);
  if (!m) throw new InputError("Module not found", 404);
  await run("DELETE FROM modules WHERE id = ?", [param(c, "id")]);
  await touchCourse(m.course_id);
  return ok(c, { ok: true });
});

api("put", "/api/courses/{id}/order", "Set the order of modules and lessons", {
    body: z.object({ modules: z.array(z.object({ id: z.string(), lessons: z.array(z.string()).max(200) })).max(100) }),
    status: 200,
    description: "Send every module in order with its lesson ids in order. A lesson listed under another module moves there.",
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    const { modules } = input.json;
    const own = new Set((await query<{ id: string }>("SELECT id FROM modules WHERE course_id = ?", [course.id])).map((m) => m.id));
    const lessons = new Set((await query<{ id: string }>("SELECT id FROM lessons WHERE course_id = ?", [course.id])).map((l) => l.id));
    for (const [mi, m] of modules.entries()) {
      if (!own.has(m.id)) throw new InputError(`Module ${m.id} is not in this course`, 400);
      await run("UPDATE modules SET position = ? WHERE id = ?", [mi, m.id]);
      for (const [li, l] of m.lessons.entries()) {
        if (!lessons.has(l)) throw new InputError(`Lesson ${l} is not in this course`, 400);
        await run("UPDATE lessons SET module_id = ?, position = ? WHERE id = ?", [m.id, li, l]);
      }
    }
    await touchCourse(course.id);
    return ok(c, { ok: true });
  },
);

api("post", "/api/modules/{id}/lessons", "Add a lesson to a module", {
    body: z.object({ title: z.string().trim().min(1).max(200), kind: Kind, body: z.string().max(60_000).optional() }),
    res: Lesson,
  },
  async (c, input) => {
    const m = await get<{ id: string; course_id: string }>("SELECT id, course_id FROM modules WHERE id = ?", [param(c, "id")]);
    if (!m) throw new InputError("Module not found", 404);
    const b = input.json;
    const id = uid();
    await run("INSERT INTO lessons (id, course_id, module_id, title, kind, body, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id, m.course_id, m.id, b.title, b.kind, b.body ?? "", await nextPosition("lessons", "module_id", m.id),
    ]);
    await touchCourse(m.course_id);
    return ok(c, await lessonView(id, origin(c)), 201);
  },
);

api("get", "/api/lessons/{id}", "A lesson with its questions and video state", { res: Lesson }, async (c, input) =>
  ok(c, await lessonView(param(c, "id"), origin(c))),
);

api("patch", "/api/lessons/{id}", "Change a lesson (only the fields sent)", {
    body: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(60_000).optional().openapi({ description: "Markdown, or the presenter's script. Edit part of it rather than resending it all" }),
      kind: Kind.optional(),
      presenter_id: z.string().nullable().optional(),
    }),
    res: Lesson,
  },
  async (c, input) => {
    const l = await courseOfLesson(param(c, "id"));
    const b = input.json;
    if (b.presenter_id && !(await get("SELECT id FROM presenters WHERE id = ?", [b.presenter_id]))) throw new InputError("Presenter not found", 404);
    await run(
      "UPDATE lessons SET title = ?, body = ?, kind = ?, presenter_id = ?, updated_at = datetime('now') WHERE id = ?",
      [b.title ?? l.title, b.body ?? l.body, b.kind ?? l.kind, b.presenter_id !== undefined ? b.presenter_id : l.presenter_id, l.id],
    );
    await touchCourse(l.course_id);
    return ok(c, await lessonView(l.id, origin(c)));
  },
);

api("delete", "/api/lessons/{id}", "Delete a lesson from the draft", async (c, input) => {
  const l = await courseOfLesson(param(c, "id"));
  await run("DELETE FROM lessons WHERE id = ?", [l.id]);
  await touchCourse(l.course_id);
  return ok(c, { ok: true });
});

// ── Quiz questions ────────────────────────────────────────────────────

const QuestionFields = z.object({
  prompt: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(500)).min(2).max(8),
  correct: z.array(z.number().int().min(0)).min(1).openapi({ description: "Indexes into options; several make it a choose-all-that-apply question" }),
  explanation: z.string().max(1500).optional(),
});

function checkCorrect(options: string[], correct: number[]) {
  if (correct.some((i) => i >= options.length)) throw new InputError("A correct answer points past the last option.");
}

api("post", "/api/lessons/{id}/questions", "Add a question to a quiz lesson", { body: QuestionFields, res: Question }, async (c, input) => {
  const l = await courseOfLesson(param(c, "id"));
  if (l.kind !== "quiz") throw new InputError("Questions belong to a quiz lesson.");
  const b = input.json;
  checkCorrect(b.options, b.correct);
  const id = uid();
  await run("INSERT INTO questions (id, lesson_id, prompt, options, correct, explanation, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id, l.id, b.prompt, JSON.stringify(b.options), JSON.stringify([...new Set(b.correct)]), b.explanation ?? "", await nextPosition("questions", "lesson_id", l.id),
  ]);
  await touchCourse(l.course_id);
  return ok(c, presentQuestion((await get<QuestionRow>("SELECT * FROM questions WHERE id = ?", [id]))!), 201);
});

api("patch", "/api/questions/{id}", "Change a question (only the fields sent)", { body: QuestionFields.partial(), res: Question }, async (c, input) => {
  const q = await get<QuestionRow>("SELECT * FROM questions WHERE id = ?", [param(c, "id")]);
  if (!q) throw new InputError("Question not found", 404);
  const b = input.json;
  const options = b.options ?? parseJson<string[]>(q.options, []);
  const correct = b.correct ? [...new Set(b.correct)] : parseJson<number[]>(q.correct, []).filter((i) => i < options.length);
  checkCorrect(options, correct);
  await run("UPDATE questions SET prompt = ?, options = ?, correct = ?, explanation = ? WHERE id = ?", [
    b.prompt ?? q.prompt, JSON.stringify(options), JSON.stringify(correct), b.explanation ?? q.explanation, q.id,
  ]);
  const l = await courseOfLesson(q.lesson_id);
  await touchCourse(l.course_id);
  return ok(c, presentQuestion((await get<QuestionRow>("SELECT * FROM questions WHERE id = ?", [q.id]))!));
});

api("delete", "/api/questions/{id}", "Delete a question", async (c, input) => {
  const q = await get<QuestionRow>("SELECT * FROM questions WHERE id = ?", [param(c, "id")]);
  if (!q) throw new InputError("Question not found", 404);
  await run("DELETE FROM questions WHERE id = ?", [q.id]);
  await touchCourse((await courseOfLesson(q.lesson_id)).course_id);
  return ok(c, { ok: true });
});

// ── Lesson video ──────────────────────────────────────────────────────

api("post", "/api/lessons/{id}/video/avatar", "Make the presenter video from the lesson's script (spends AI credits)", {
    body: z.object({ presenter_id: z.string().optional().openapi({ description: "Defaults to the lesson's presenter" }) }),
    status: 202,
    res: Lesson,
    description: `Reads the script aloud with the presenter's voice, then animates their photo to it. Takes a minute or more: poll GET /api/lessons/{id}/video. The presenter needs a photo and recorded consent. Script up to ${SCRIPT_MAX} characters.`,
  },
  async (c, input) => {
    const l = await startAvatarVideo(c.env, origin(c), param(c, "id"), input.json.presenter_id ?? null);
    return ok(c, await lessonView(l.id, origin(c)), 202);
  },
);

api("get", "/api/lessons/{id}/video", "The lesson's video state; also moves a render in progress along", { res: Lesson }, async (c, input) => {
  await advanceVideo(c.env, origin(c), param(c, "id"), { book: false });
  return ok(c, await lessonView(param(c, "id"), origin(c)));
});

api("delete", "/api/lessons/{id}/video", "Remove the video from the draft lesson (published versions keep theirs)", { res: Lesson }, async (c, input) => {
  const l = await courseOfLesson(param(c, "id"));
  await run("UPDATE lessons SET video_key = NULL, video_source = NULL, video_status = 'none', video_job_id = NULL, video_script = NULL, video_error = '', video_cost = NULL WHERE id = ?", [l.id]);
  await touchCourse(l.course_id);
  return ok(c, await lessonView(l.id, origin(c)));
});

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

// Raw upload: the file is the request body. Off the OpenAPI surface (a binary body).
app.put("/api/lessons/:id/video/file", async (c) => {
  const l = await courseOfLesson(c.req.param("id"));
  if (l.kind !== "video") throw new InputError("Only a video lesson takes a video.");
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
  if (!/^video\/(mp4|webm|quicktime)$/.test(type)) throw new InputError("Upload an MP4, WebM or MOV video.");
  const size = Number(c.req.header("content-length"));
  if (!Number.isFinite(size) || size <= 0) throw new InputError("The upload has no length.");
  if (size > MAX_VIDEO_BYTES) throw new InputError("Videos up to 300 MB. Shorter lessons work better for learners anyway.");
  if (!c.req.raw.body) throw new InputError("The upload is empty.");
  const key = `lessons/${l.id}/upload-${Date.now()}.${type === "video/webm" ? "webm" : type === "video/quicktime" ? "mov" : "mp4"}`;
  const fixed = new FixedLengthStream(size);
  const pipe = c.req.raw.body.pipeTo(fixed.writable);
  await putUpload(key, fixed.readable, type);
  await pipe;
  await run(
    "UPDATE lessons SET video_key = ?, video_source = 'upload', video_status = 'ready', video_job_id = NULL, video_script = NULL, video_error = '', video_cost = NULL, updated_at = datetime('now') WHERE id = ?",
    [key, l.id],
  );
  await touchCourse(l.course_id);
  return c.json(await lessonView(l.id, origin(c)));
});

app.get("/api/lessons/:id/video/file", async (c) => {
  const l = await courseOfLesson(c.req.param("id"));
  if (!l.video_key) return c.json({ error: "No video" }, 404);
  const res = await serveUpload(l.video_key, c.req.header("Range"), { "Cache-Control": "private, max-age=3600" });
  return res ?? c.json({ error: "No video" }, 404);
});

// ── Presenters ────────────────────────────────────────────────────────

const Presenter = z.object({
  id: z.string(), name: z.string(), has_photo: z.boolean(), photo_url: z.string().nullable(), voice_model: z.string(), voice: z.string(),
  consent: z.object({ by: z.string(), at: z.string(), note: z.string() }).nullable(), lessons: z.number(), created_at: z.string(),
}).openapi("Presenter");

type PresenterRow = { id: string; name: string; photo_key: string | null; voice_model: string; voice: string; consent_by: string | null; consent_at: string | null; consent_note: string; created_at: string };

async function presentPresenter(p: PresenterRow, base: string) {
  const lessons = (await get<{ n: number }>("SELECT COUNT(*) n FROM lessons WHERE presenter_id = ?", [p.id]))?.n ?? 0;
  return {
    id: p.id, name: p.name, has_photo: !!p.photo_key,
    photo_url: p.photo_key ? `${base}/api/presenters/${p.id}/photo?v=${encodeURIComponent(p.photo_key.split("/").pop()!)}` : null,
    voice_model: p.voice_model, voice: p.voice,
    consent: p.consent_at ? { by: p.consent_by ?? "", at: p.consent_at, note: p.consent_note } : null,
    lessons, created_at: p.created_at,
  };
}

async function readPresenter(id: string): Promise<PresenterRow> {
  const p = await get<PresenterRow>("SELECT * FROM presenters WHERE id = ?", [id]);
  if (!p) throw new InputError("Presenter not found", 404);
  return p;
}

api("get", "/api/presenters", "List presenters", { query: PageQuery, paged: ["presenters", Presenter] }, async (c, input) => {
  const { page, limit, offset, search } = pageParams(input.query);
  const where = search ? "WHERE name LIKE ?" : "";
  const args = search ? [`%${search}%`] : [];
  const rows = await query<PresenterRow>(`SELECT * FROM presenters ${where} ORDER BY name LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM presenters ${where}`, args))?.n ?? 0;
  return ok(c, { presenters: await Promise.all(rows.map((p) => presentPresenter(p, origin(c)))), total, page, limit });
});

const PresenterFields = z.object({
  name: z.string().trim().min(1).max(120),
  voice_model: z.string().max(120).optional().openapi({ description: "Text-to-speech model; empty = the app's default" }),
  voice: z.string().max(120).optional().openapi({ description: "A voice of that model; empty = the app's default" }),
});

api("post", "/api/presenters", "Add a presenter", { body: PresenterFields, res: Presenter }, async (c, input) => {
  const b = input.json;
  const id = uid();
  await run("INSERT INTO presenters (id, name, voice_model, voice) VALUES (?, ?, ?, ?)", [id, b.name, b.voice_model ?? "", b.voice ?? ""]);
  return ok(c, await presentPresenter(await readPresenter(id), origin(c)), 201);
});

api("patch", "/api/presenters/{id}", "Change a presenter; recording consent needs a person", {
    body: PresenterFields.partial().extend({
      consent: z.boolean().optional().openapi({ description: "true records that the person agreed to an AI presenter made from their photo and voice; false withdraws it" }),
      consent_note: z.string().max(1000).optional().openapi({ description: "How consent was given, e.g. 'Signed form, 3 Nov'" }),
    }),
    res: Presenter,
  },
  async (c, input) => {
    const p = await readPresenter(param(c, "id"));
    const b = input.json;
    await run("UPDATE presenters SET name = ?, voice_model = ?, voice = ? WHERE id = ?", [b.name ?? p.name, b.voice_model ?? p.voice_model, b.voice ?? p.voice, p.id]);
    if (b.consent !== undefined) {
      const who = requirePerson(c, "record a presenter's consent");
      if (b.consent) {
        await run("UPDATE presenters SET consent_by = ?, consent_at = datetime('now'), consent_note = ? WHERE id = ?", [who.name, b.consent_note ?? "", p.id]);
      } else {
        await run("UPDATE presenters SET consent_by = NULL, consent_at = NULL, consent_note = '' WHERE id = ?", [p.id]);
      }
    } else if (b.consent_note !== undefined && p.consent_at) {
      await run("UPDATE presenters SET consent_note = ? WHERE id = ?", [b.consent_note, p.id]);
    }
    return ok(c, await presentPresenter(await readPresenter(p.id), origin(c)));
  },
);

api("delete", "/api/presenters/{id}", "Delete a presenter (videos already made stay)", async (c, input) => {
  const p = await readPresenter(param(c, "id"));
  await run("DELETE FROM presenters WHERE id = ?", [p.id]);
  return ok(c, { ok: true });
});

app.put("/api/presenters/:id/photo", async (c) => {
  const p = await readPresenter(c.req.param("id"));
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new InputError("Upload a JPEG, PNG or WebP photo.");
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) throw new InputError("The upload is empty.");
  if (bytes.byteLength > 10 * 1024 * 1024) throw new InputError("Photos up to 10 MB.");
  const key = `presenters/${p.id}/photo-${Date.now()}.${type.split("/")[1]}`;
  await putUpload(key, bytes, type);
  await run("UPDATE presenters SET photo_key = ? WHERE id = ?", [key, p.id]);
  if (p.photo_key) await deleteUpload(p.photo_key);
  return c.json(await presentPresenter(await readPresenter(p.id), origin(c)));
});

app.get("/api/presenters/:id/photo", async (c) => {
  const p = await readPresenter(c.req.param("id"));
  if (!p.photo_key) return c.json({ error: "No photo" }, 404);
  return (await serveUpload(p.photo_key, undefined, { "Cache-Control": "private, max-age=86400" })) ?? c.json({ error: "No photo" }, 404);
});

// ── People: groups and learners ───────────────────────────────────────

const Group = z.object({ id: z.string(), name: z.string(), description: z.string(), members: z.number(), courses: z.number(), created_at: z.string() }).openapi("Group");

const GROUP_SELECT = `g.*, (SELECT COUNT(*) FROM learner_groups lg JOIN learners l ON l.id = lg.learner_id AND l.active = 1 WHERE lg.group_id = g.id) members,
  (SELECT COUNT(*) FROM course_groups cg WHERE cg.group_id = g.id) courses FROM groups g`;

api("get", "/api/groups", "List groups (roles, departments, sites)", { query: PageQuery, paged: ["groups", Group] }, async (c, input) => {
  const { page, limit, offset, search } = pageParams(input.query);
  const where = search ? "WHERE g.name LIKE ?" : "";
  const args = search ? [`%${search}%`] : [];
  const rows = await query(`SELECT ${GROUP_SELECT} ${where} ORDER BY g.name LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM groups g ${where}`, args))?.n ?? 0;
  return ok(c, { groups: rows, total, page, limit });
});

const GroupFields = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional() });

async function groupByName(name: string): Promise<string> {
  const found = await get<{ id: string }>("SELECT id FROM groups WHERE name = ? COLLATE NOCASE", [name]);
  if (found) return found.id;
  const id = uid();
  await run("INSERT INTO groups (id, name) VALUES (?, ?)", [id, name]);
  return id;
}

api("post", "/api/groups", "Add a group", { body: GroupFields, res: Group }, async (c, input) => {
  const b = input.json;
  if (await get("SELECT id FROM groups WHERE name = ? COLLATE NOCASE", [b.name])) throw new InputError(`A group called ${b.name} already exists.`, 409);
  const id = uid();
  await run("INSERT INTO groups (id, name, description) VALUES (?, ?, ?)", [id, b.name, b.description ?? ""]);
  return ok(c, await get(`SELECT ${GROUP_SELECT} WHERE g.id = ?`, [id]), 201);
});

api("patch", "/api/groups/{id}", "Rename or describe a group", { body: GroupFields.partial(), res: Group }, async (c, input) => {
  const g = await get<{ id: string; name: string; description: string }>("SELECT * FROM groups WHERE id = ?", [param(c, "id")]);
  if (!g) throw new InputError("Group not found", 404);
  const b = input.json;
  await run("UPDATE groups SET name = ?, description = ? WHERE id = ?", [b.name ?? g.name, b.description ?? g.description, g.id]);
  return ok(c, await get(`SELECT ${GROUP_SELECT} WHERE g.id = ?`, [g.id]));
});

api("delete", "/api/groups/{id}", "Delete a group (assignments already made stay)", async (c, input) => {
  await run("DELETE FROM groups WHERE id = ?", [param(c, "id")]);
  return ok(c, { ok: true });
});

const Learner = z.object({
  id: z.string(), name: z.string(), email: z.string(), external_id: z.string(), active: z.boolean(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })), open: z.number(), overdue: z.number(), completed: z.number(), created_at: z.string(),
}).openapi("Learner");

type LearnerRow = { id: string; name: string; email: string; external_id: string; active: number; created_at: string };

async function presentLearners(rows: LearnerRow[]) {
  return Promise.all(rows.map(async (l) => {
    const groups = await query<{ id: string; name: string }>("SELECT g.id, g.name FROM learner_groups lg JOIN groups g ON g.id = lg.group_id WHERE lg.learner_id = ? ORDER BY g.name", [l.id]);
    const n = (await get<{ open: number; overdue: number; completed: number }>(
      `SELECT SUM(status IN ('assigned', 'in_progress')) open,
              SUM(status IN ('assigned', 'in_progress') AND due_at < datetime('now')) overdue,
              SUM(status = 'completed') completed FROM enrollments WHERE learner_id = ?`,
      [l.id],
    ))!;
    return { ...l, active: Boolean(l.active), groups, open: n.open ?? 0, overdue: n.overdue ?? 0, completed: n.completed ?? 0 };
  }));
}

api("get", "/api/learners", "List people", {
    query: PageQuery.extend({ group_id: z.string().optional(), active: z.enum(["true", "false"]).optional() }),
    paged: ["learners", Learner],
  },
  async (c, input) => {
    const q = input.query;
    const { page, limit, offset, search } = pageParams(q);
    const where: string[] = [];
    const args: unknown[] = [];
    if (search) { where.push("(l.name LIKE ? OR l.email LIKE ? OR l.external_id = ?)"); args.push(`%${search}%`, `%${search}%`, search); }
    if (q.group_id) { where.push("EXISTS (SELECT 1 FROM learner_groups lg WHERE lg.learner_id = l.id AND lg.group_id = ?)"); args.push(q.group_id); }
    where.push("l.active = ?");
    args.push(q.active === "false" ? 0 : 1);
    const w = `WHERE ${where.join(" AND ")}`;
    const rows = await query<LearnerRow>(`SELECT l.* FROM learners l ${w} ORDER BY l.name LIMIT ? OFFSET ?`, [...args, limit, offset]);
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM learners l ${w}`, args))?.n ?? 0;
    return ok(c, { learners: await presentLearners(rows), total, page, limit });
  },
);

const LearnerFields = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254),
  external_id: z.string().trim().max(80).optional().openapi({ description: "Employee number, to match an HR export" }),
  groups: z.array(z.string().trim().min(1).max(120)).max(20).optional().openapi({ description: "Group names; missing groups are created" }),
});

/** Create or update by email. Returns the learner id and whether it was new. */
async function upsertLearner(b: z.infer<typeof LearnerFields>, replaceGroups: boolean): Promise<{ id: string; created: boolean }> {
  const found = await get<LearnerRow>("SELECT * FROM learners WHERE email = ?", [b.email]);
  const id = found?.id ?? uid();
  if (found) {
    await run("UPDATE learners SET name = ?, external_id = ?, active = 1 WHERE id = ?", [b.name, b.external_id ?? found.external_id, id]);
  } else {
    await run("INSERT INTO learners (id, name, email, external_id) VALUES (?, ?, ?, ?)", [id, b.name, b.email, b.external_id ?? ""]);
  }
  if (b.groups) {
    if (replaceGroups) await run("DELETE FROM learner_groups WHERE learner_id = ?", [id]);
    for (const name of b.groups) await run("INSERT OR IGNORE INTO learner_groups (learner_id, group_id) VALUES (?, ?)", [id, await groupByName(name)]);
  }
  return { id, created: !found };
}

api("post", "/api/learners", "Add a person (or update them, matched by email)", { body: LearnerFields, res: Learner }, async (c, input) => {
  const { id } = await upsertLearner(input.json, false);
  await syncAll();
  return ok(c, (await presentLearners([(await get<LearnerRow>("SELECT * FROM learners WHERE id = ?", [id]))!]))[0], 201);
});

api("post", "/api/learners/import", "Add or update many people at once, matched by email", {
    body: z.object({
      people: z.array(LearnerFields).min(1).max(500),
      replace_groups: z.boolean().optional().openapi({ description: "Set each person's groups to exactly those sent, instead of adding to them" }),
    }),
    status: 200,
    description: "For an HR export: one row per person with name, email, optional employee number and group names. New people in a course's groups are assigned at once.",
  },
  async (c, input) => {
    const b = input.json;
    const { created, updated } = await importPeople(b.people, !!b.replace_groups);
    const assigned = await syncAll();
    return ok(c, { created, updated, assigned });
  },
);

api("patch", "/api/learners/{id}", "Change a person; deactivating cancels their open assignments", {
    body: LearnerFields.partial().extend({
      active: z.boolean().optional(),
      group_ids: z.array(z.string()).max(50).optional().openapi({ description: "Exactly these groups" }),
    }),
    res: Learner,
  },
  async (c, input) => {
    const l = await get<LearnerRow>("SELECT * FROM learners WHERE id = ?", [param(c, "id")]);
    if (!l) throw new InputError("Person not found", 404);
    const b = input.json;
    if (b.email && b.email.toLowerCase() !== l.email.toLowerCase() && (await get("SELECT id FROM learners WHERE email = ?", [b.email]))) {
      throw new InputError(`Someone else already has ${b.email}.`, 409);
    }
    const active = b.active ?? Boolean(l.active);
    await run("UPDATE learners SET name = ?, email = ?, external_id = ?, active = ? WHERE id = ?", [b.name ?? l.name, b.email ?? l.email, b.external_id ?? l.external_id, active ? 1 : 0, l.id]);
    if (b.group_ids) {
      await run("DELETE FROM learner_groups WHERE learner_id = ?", [l.id]);
      for (const g of b.group_ids) await run("INSERT OR IGNORE INTO learner_groups (learner_id, group_id) SELECT ?, id FROM groups WHERE id = ?", [l.id, g]);
    }
    if (b.groups) for (const name of b.groups) await run("INSERT OR IGNORE INTO learner_groups (learner_id, group_id) VALUES (?, ?)", [l.id, await groupByName(name)]);
    if (!active && l.active) {
      await run(
        `INSERT INTO activity (enrollment_id, kind, detail)
         SELECT id, 'cancelled', 'Person deactivated' FROM enrollments WHERE learner_id = ? AND status IN ('assigned', 'in_progress')`,
        [l.id],
      );
      await run("UPDATE enrollments SET status = 'cancelled' WHERE learner_id = ? AND status IN ('assigned', 'in_progress')", [l.id]);
    }
    await syncAll();
    return ok(c, (await presentLearners([(await get<LearnerRow>("SELECT * FROM learners WHERE id = ?", [l.id]))!]))[0]);
  },
);

api("delete", "/api/learners/{id}", "Delete a person and their records (deactivate them instead to keep the records)", async (c, input) => {
  requireAdmin(c, "delete a person's training records");
  await run("DELETE FROM learners WHERE id = ?", [param(c, "id")]);
  return ok(c, { ok: true });
});

// ── Assignments and records ───────────────────────────────────────────

const Status = z.enum(["assigned", "in_progress", "completed", "cancelled", "overdue", "open"]);

function enrollmentWhere(q: { course_id?: string; learner_id?: string; status?: z.infer<typeof Status>; search?: string; group_id?: string }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.course_id) { where.push("e.course_id = ?"); args.push(q.course_id); }
  if (q.learner_id) { where.push("e.learner_id = ?"); args.push(q.learner_id); }
  if (q.group_id) { where.push("EXISTS (SELECT 1 FROM learner_groups lg WHERE lg.learner_id = e.learner_id AND lg.group_id = ?)"); args.push(q.group_id); }
  if (q.status === "overdue") where.push("e.status IN ('assigned', 'in_progress') AND e.due_at < datetime('now')");
  else if (q.status === "open") where.push("e.status IN ('assigned', 'in_progress')");
  else if (q.status) { where.push("e.status = ?"); args.push(q.status); }
  if (q.search) { where.push("(l.name LIKE ? OR l.email LIKE ?)"); args.push(`%${q.search}%`, `%${q.search}%`); }
  return { w: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

api("get", "/api/enrollments", "Assignments and completions: the training record", {
    query: PageQuery.extend({ course_id: z.string().optional(), learner_id: z.string().optional(), group_id: z.string().optional(), status: Status.optional() }),
    paged: ["enrollments", Enrollment],
    description: "status=overdue for who is late, status=open for everyone still to finish. Each row carries the person's link.",
  },
  async (c, input) => {
    const q = input.query;
    const { page, limit, offset, search } = pageParams(q);
    const { w, args } = enrollmentWhere({ ...q, search });
    const rows = await query<EnrollmentListRow>(`SELECT ${ENROLLMENT_SELECT} ${w} ORDER BY e.assigned_at DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM enrollments e JOIN learners l ON l.id = e.learner_id ${w}`, args))?.n ?? 0;
    return ok(c, { enrollments: rows.map((r) => presentEnrollment(r, origin(c))), total, page, limit });
  },
);

api("post", "/api/courses/{id}/enrollments", "Assign a published course to particular people", {
    body: z.object({
      learner_ids: z.array(z.string()).min(1).max(80),
      due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "YYYY-MM-DD; default: the course's due days from today" }),
    }),
    status: 200,
  },
  async (c, input) => {
    const course = await readCourse(param(c, "id"));
    if (!course.published_version) throw new InputError("Publish the course before assigning it.", 409, "not_published");
    const b = input.json;
    let assigned = 0;
    for (const lid of [...new Set(b.learner_ids)]) {
      if (!(await get("SELECT id FROM learners WHERE id = ? AND active = 1", [lid]))) continue;
      if (await get("SELECT id FROM enrollments WHERE course_id = ? AND learner_id = ? AND status IN ('assigned', 'in_progress')", [course.id, lid])) continue;
      await createEnrollment(course.id, lid, course.published_version, {
        due_days: course.due_days, ...(b.due_at ? { due_at: `${b.due_at} 23:59:59` } : {}), reason: "Assigned by hand",
      });
      assigned++;
    }
    return ok(c, { assigned });
  },
);

api("get", "/api/enrollments/{id}", "One person's record for one course: every step, attempt and the attestation", async (c, input) => {
  const row = await get<EnrollmentListRow>(`SELECT ${ENROLLMENT_SELECT} WHERE e.id = ?`, [param(c, "id")]);
  if (!row) throw new InputError("Assignment not found", 404);
  const activity = await query("SELECT kind, detail, at FROM activity WHERE enrollment_id = ? ORDER BY id LIMIT 200", [row.id]);
  return ok(c, { ...presentEnrollment(row, origin(c)), activity, attempts: await attemptsFor(row.id) });
});

api("post", "/api/enrollments/{id}/cancel", "Withdraw an assignment that is not completed", { body: z.object({ reason: z.string().max(300).optional() }), status: 200 },
  async (c, input) => {
    const e = await get<{ id: string; status: string }>("SELECT id, status FROM enrollments WHERE id = ?", [param(c, "id")]);
    if (!e) throw new InputError("Assignment not found", 404);
    if (e.status === "completed") throw new InputError("A completed assignment is part of the record and can't be withdrawn.", 409);
    await run("UPDATE enrollments SET status = 'cancelled' WHERE id = ?", [e.id]);
    await run("INSERT INTO activity (enrollment_id, kind, detail) VALUES (?, 'cancelled', ?)", [e.id, input.json.reason ?? ""]);
    return ok(c, { ok: true });
  },
);

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // never a formula in a spreadsheet
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// The export for an auditor or HR. A file, so off the OpenAPI surface; paged in chunks to stay bounded per query.
app.get("/api/records.csv", async (c) => {
  const status = c.req.query("status");
  const { w, args } = enrollmentWhere({
    course_id: c.req.query("course_id") || undefined, group_id: c.req.query("group_id") || undefined,
    status: Status.safeParse(status).success ? (status as z.infer<typeof Status>) : undefined,
  });
  const header = ["Person", "Email", "Employee ID", "Course", "Version", "Status", "Overdue", "Assigned", "Due", "Started", "Completed", "Score %", "Attested", "Attestation", "Renew from", "Record ID"];
  const lines = [header.join(",")];
  for (let offset = 0; offset < 50_000; offset += 500) {
    const rows = await query<EnrollmentListRow>(`SELECT ${ENROLLMENT_SELECT} ${w} ORDER BY c.title, l.name, e.assigned_at LIMIT 500 OFFSET ?`, [...args, offset]);
    for (const r of rows) {
      lines.push([r.learner_name, r.learner_email, r.learner_external_id, r.course_title, r.course_version, r.status, r.overdue ? "yes" : "",
        r.assigned_at, r.due_at, r.started_at, r.completed_at, r.score, r.attested_at, r.attestation, r.renew_at, r.id].map(csvCell).join(","));
    }
    if (rows.length < 500) break;
  }
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="training-records-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
});

// ── Overview, sync, settings ──────────────────────────────────────────

async function overviewNumbers() {
  return (await get<{ published_courses: number; learners: number; open: number; overdue: number; completed_30d: number; due_7d: number }>(
    `SELECT (SELECT COUNT(*) FROM courses WHERE published_version IS NOT NULL AND archived = 0) published_courses,
            (SELECT COUNT(*) FROM learners WHERE active = 1) learners,
            (SELECT COUNT(*) FROM enrollments WHERE status IN ('assigned', 'in_progress')) open,
            (SELECT COUNT(*) FROM enrollments WHERE status IN ('assigned', 'in_progress') AND due_at < datetime('now')) overdue,
            (SELECT COUNT(*) FROM enrollments WHERE status = 'completed' AND completed_at >= datetime('now', '-30 days')) completed_30d,
            (SELECT COUNT(*) FROM enrollments WHERE status IN ('assigned', 'in_progress') AND due_at >= datetime('now') AND due_at < datetime('now', '+7 days')) due_7d`,
  ))!;
}

api("get", "/api/overview", "Training at a glance: open, overdue and recent completions, per course", async (c, input) => {
  await syncAll(); // renewals that came due and new group members, before counting
  await rebookStalled(c.env, origin(c));
  const courses = await query<{ id: string; title: string; open: number; overdue: number; completed: number; total: number }>(
    `SELECT c.id, c.title,
            SUM(e.status IN ('assigned', 'in_progress')) open,
            SUM(e.status IN ('assigned', 'in_progress') AND e.due_at < datetime('now')) overdue,
            SUM(e.status = 'completed' AND e.renewed = 0) completed,
            SUM(e.status != 'cancelled' AND e.renewed = 0) total
       FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id
      WHERE c.published_version IS NOT NULL AND c.archived = 0
      GROUP BY c.id ORDER BY overdue DESC, open DESC LIMIT 25`,
  );
  return ok(c, { ...(await overviewNumbers()), courses: courses.map((r) => ({ ...r, open: r.open ?? 0, overdue: r.overdue ?? 0, completed: r.completed ?? 0, total: r.total ?? 0 })) });
});

api("post", "/api/sync", "Assign whatever is missing now: renewals that came due and new members of required groups", { status: 200 }, async (c, input) =>
  ok(c, { assigned: await syncAll() }),
);

const SettingsShape = z.object({
  organization_name: z.string().max(200), text_model: z.string().max(120), voice_model: z.string().max(120), voice: z.string().max(120),
  avatar_model: z.string().max(120), certificate_signer: z.string().max(200),
}).openapi("Settings");

api("get", "/api/settings", "App settings", { res: SettingsShape.extend({ storage: z.boolean(), ai: z.boolean() }) }, async (c, input) => {
  const s = await readSettings();
  return ok(c, { ...s, storage: hasUploads(), ai: !!c.env.OPENROUTER_API_KEY });
});

api("put", "/api/settings", "Change app settings (only the fields sent)", { body: SettingsShape.partial(), res: SettingsShape }, async (c, input) => {
  const b = input.json;
  const sets = Object.entries(b).filter(([, v]) => v !== undefined);
  await readSettings();
  if (sets.length) await run(`UPDATE settings SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = 1`, sets.map(([, v]) => (v as string).trim()));
  return ok(c, await readSettings());
});

api("get", "/api/models", "Models this workspace's key can use, for the settings pickers", {
    query: z.object({ kind: z.enum(["text", "speech", "video"]) }),
  },
  async (c, input) => ok(c, { models: (await listModels(c.env, input.query.kind)).slice(0, 400) }),
);

widgets(app, async () => {
  const n = await overviewNumbers();
  return [
    { key: "overdue", kind: "metric", title: "Overdue training", value: n.overdue, at: "/records?status=overdue", icon: "clock", color: "red" },
    { key: "open", kind: "metric", title: "Training still to finish", value: n.open, at: "/records?status=open", icon: "list-checks", color: "amber" },
    { key: "completed-30d", kind: "metric", title: "Completed in the last 30 days", value: n.completed_30d, at: "/records?status=completed", icon: "check-square", color: "green" },
  ];
});

// ── Public: the learner pages, files for model providers, queue steps ──

app.get("/api/public/media/:token", async (c) => {
  const key = await mediaKeyForLink(c.req.param("token"));
  if (!key) return c.text("Not found", 404);
  return (await serveUpload(key, c.req.header("Range"), { "Cache-Control": "no-store" })) ?? c.text("Not found", 404);
});

app.post("/api/video/step", async (c) => {
  const raw = await c.req.text();
  const signed = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  if (!signed) return c.json({ error: "unauthorized" }, 401);
  const lessonId = String((parseJson<{ lesson_id?: unknown }>(raw, {})).lesson_id ?? "");
  if (lessonId) {
    try {
      await advanceVideo(c.env, origin(c), lessonId, { book: true });
    } catch (err) {
      if (!(err instanceof InputError)) console.error(err);
    }
  }
  return c.json({ ok: true }); // always 2xx: the step books the next one itself
});

registerLearn(app as never);

export default app;
