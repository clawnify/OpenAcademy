import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import app from "./index";

// The platform's Storage binding over node:sqlite: the real routes and SQL run, no mocks.
let db: DatabaseSync;
let queries = 0; // per request, to hold the app under the database's 1,000-queries-per-request cap
const STORAGE = {
  async query(sql: string, params: unknown[] = []) {
    queries++;
    const stmt = db.prepare(sql);
    const values = params as (string | number | null)[];
    if (/^\s*(select|with|pragma)/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...values) };
    const r = stmt.run(...values);
    return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
};

type Who = "user" | "agent" | "local";
const HEADERS: Record<Who, Record<string, string>> = {
  user: { "X-Clawnify-Caller": "user", "X-Clawnify-User-Id": "u1", "X-Clawnify-User-Name": "Dana Quality", "X-Clawnify-Org-Id": "o1", "X-Clawnify-Access-Control": "off" },
  agent: { "X-Clawnify-Caller": "agent", "X-Clawnify-Org-Id": "o1" },
  local: {},
};

const ORIGIN = "https://academy.example";

async function call(method: string, path: string, body?: unknown, who: Who = "user") {
  const env = who === "local" ? { STORAGE } : { STORAGE, CLAWNIFY_TOKEN: "", OPENROUTER_API_KEY: "sk-test" };
  const res = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...HEADERS[who] },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** A learner's browser: plain form posts, redirects not followed. */
async function learner(method: "GET" | "POST", path: string, form?: Record<string, string | string[]>) {
  let body: URLSearchParams | undefined;
  if (form) {
    body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
  }
  const res = await app.request(`${ORIGIN}${path}`, { method, body, redirect: "manual" }, { STORAGE });
  return { status: res.status, html: await res.text(), location: res.headers.get("location") };
}

const OUTLINE = {
  modules: [{
    title: "Receiving goods",
    lessons: [
      { title: "Checking a delivery", kind: "text", body: "## Before you sign\n\n- Count the pallets\n- Check the seals" },
      {
        title: "Quiz: receiving", kind: "quiz", body: "",
        questions: [
          { prompt: "A seal is broken. What do you do?", options: ["Sign anyway", "Refuse and note it on the delivery note", "Call nobody"], correct: [1], explanation: "Procedure WH-02, step 3." },
          { prompt: "What do you count?", options: ["Pallets", "Trucks"], correct: [0], explanation: "" },
        ],
      },
    ],
  }],
};

async function publishedCourse() {
  const course = await call("POST", "/api/courses", { title: "Warehouse receiving", audience: "Warehouse staff", renew_months: 12 });
  expect(course.status).toBe(201);
  const id = course.body.id as string;
  expect((await call("POST", `/api/courses/${id}/outline`, OUTLINE)).status).toBe(201);
  const imp = await call("POST", "/api/learners/import", {
    people: [
      { name: "Ana Ruiz", email: "ana@acme.test", external_id: "E1", groups: ["Warehouse"] },
      { name: "Ben Ode", email: "ben@acme.test", groups: ["Warehouse"] },
      { name: "Cleo Park", email: "cleo@acme.test", groups: ["Office"] },
    ],
  });
  expect(imp.body).toMatchObject({ created: 3, updated: 0 });
  const groups = await call("GET", "/api/groups");
  const warehouse = groups.body.groups.find((g: any) => g.name === "Warehouse");
  await call("PUT", `/api/courses/${id}/groups`, { group_ids: [warehouse.id] });
  const pub = await call("POST", `/api/courses/${id}/publish`, { notes: "First version" });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  expect(pub.body).toEqual({ version: 1, assigned: 2 });
  return { id, warehouseId: warehouse.id as string };
}

async function linkFor(courseId: string, email: string) {
  const r = await call("GET", `/api/enrollments?course_id=${courseId}&search=${encodeURIComponent(email)}&status=open`);
  expect(r.body.enrollments).toHaveLength(1);
  return new URL(r.body.enrollments[0].link).pathname;
}

async function takeCourse(path: string, s: any) {
  const lessons = s.modules.flatMap((m: any) => m.lessons);
  for (const l of lessons) {
    if (l.kind === "quiz") {
      const answers = Object.fromEntries(l.questions.map((q: any) => [`q_${q.id}`, q.correct.map(String)]));
      const r = await learner("POST", `${path}/l/${l.id}/quiz`, answers);
      expect(r.status).toBe(303);
    } else {
      expect((await learner("POST", `${path}/l/${l.id}/done`)).status).toBe(303);
    }
  }
  const done = await learner("POST", `${path}/finish`, { agree: "1" });
  expect(done.status).toBe(303);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

afterEach(() => vi.unstubAllGlobals());

describe("publishing", () => {
  it("lists what blocks publishing, in words a person can act on", async () => {
    const c = await call("POST", "/api/courses", { title: "Empty" });
    const r = await call("POST", `/api/courses/${c.body.id}/publish`, {});
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("no lessons");

    const m = await call("POST", `/api/courses/${c.body.id}/modules`, { title: "Intro" });
    await call("POST", `/api/modules/${m.body.id}/lessons`, { title: "Welcome", kind: "video", body: "Hello and welcome." });
    await call("POST", `/api/modules/${m.body.id}/lessons`, { title: "Check", kind: "quiz" });
    const again = await call("GET", `/api/courses/${c.body.id}`);
    expect(again.body.problems).toEqual(['Lesson "Welcome" has no video yet.', 'Quiz "Check" has no questions.']);
  });

  it("is something only a person does: an agent drafts but cannot publish", async () => {
    const c = await call("POST", "/api/courses", { title: "Agent draft" }, "agent");
    await call("POST", `/api/courses/${c.body.id}/outline`, OUTLINE, "agent");
    const r = await call("POST", `/api/courses/${c.body.id}/publish`, {}, "agent");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("needs_person");
  });

  it("assigns everyone in the course's groups, and only them", async () => {
    const { id } = await publishedCourse();
    const all = await call("GET", `/api/enrollments?course_id=${id}`);
    expect(all.body.enrollments.map((e: any) => e.learner_name).sort()).toEqual(["Ana Ruiz", "Ben Ode"]);
    expect(all.body.enrollments[0].link).toMatch(new RegExp(`^${ORIGIN}/learn/[A-Za-z0-9_-]{30,}$`));
    expect(all.body.enrollments[0].course_version).toBe(1);
  });

  it("gives a person who joins a required group the course at once", async () => {
    const { id } = await publishedCourse();
    await call("POST", "/api/learners", { name: "Dev New", email: "dev@acme.test", groups: ["Warehouse"] });
    const r = await call("GET", `/api/enrollments?course_id=${id}&search=dev@`);
    expect(r.body.total).toBe(1);
  });
});

describe("taking a course", () => {
  it("records every step and completes on attestation", async () => {
    const { id } = await publishedCourse();
    const path = await linkFor(id, "ana@acme.test");
    const s = (await call("GET", `/api/courses/${id}/versions/1`)).body;
    const [text, quiz] = s.modules[0].lessons;

    const home = await learner("GET", path);
    expect(home.status).toBe(200);
    expect(home.html).toContain("Start the course");

    // A wrong answer is recorded and does not pass.
    const wrong = await learner("POST", `${path}/l/${quiz.id}/quiz`, { [`q_${quiz.questions[0].id}`]: "0", [`q_${quiz.questions[1].id}`]: "0" });
    const result = await learner("GET", wrong.location!);
    expect(result.html).toContain("1 of 2 correct");
    expect(result.html).toContain("Not passed yet");
    expect(result.html).toContain("Procedure WH-02, step 3.");

    // Finishing early is refused.
    expect((await learner("GET", `${path}/finish`)).html).toContain("Finish these first");
    await learner("POST", `${path}/finish`, { agree: "1" });
    expect((await call("GET", `/api/enrollments?course_id=${id}&search=ana`)).body.enrollments[0].status).toBe("in_progress");

    await learner("POST", `${path}/l/${text.id}/done`);
    await takeCourse(path, s);

    const rec = (await call("GET", `/api/enrollments?course_id=${id}&search=ana`)).body.enrollments[0];
    expect(rec).toMatchObject({ status: "completed", score: 100, course_version: 1, attestation: s.course.attestation });
    expect(rec.renew_at).toBeTruthy();

    const detail = await call("GET", `/api/enrollments/${rec.id}`);
    expect(detail.body.activity.map((a: any) => a.kind)).toEqual(["assigned", "started", "quiz", "lesson_done", "quiz", "attested", "completed"]);
    expect(detail.body.attempts).toHaveLength(2);

    const cert = await learner("GET", `${path}/certificate`);
    expect(cert.html).toContain("Ana Ruiz");
    expect(cert.html).toContain("Warehouse receiving");
  });

  it("only serves lessons of the person's own version, and refuses bad links", async () => {
    const { id } = await publishedCourse();
    const path = await linkFor(id, "ana@acme.test");
    expect((await learner("GET", `${path}/l/not-a-lesson`)).status).toBe(404);
    expect((await learner("GET", "/learn/short")).status).toBe(404);
    expect((await learner("GET", "/learn/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });

  it("escapes what course authors write on the learner pages", async () => {
    const c = await call("POST", "/api/courses", { title: "<script>alert(1)</script>" });
    await call("POST", `/api/courses/${c.body.id}/outline`, {
      modules: [{ title: "M", lessons: [{ title: "T", kind: "text", body: "<img src=x onerror=alert(1)> [x](javascript:alert(1))" }] }],
    });
    await call("POST", "/api/learners", { name: "Ana", email: "a@x.test", groups: ["All"] });
    const g = (await call("GET", "/api/groups")).body.groups[0];
    await call("PUT", `/api/courses/${c.body.id}/groups`, { group_ids: [g.id] });
    await call("POST", `/api/courses/${c.body.id}/publish`, {});
    const path = await linkFor(c.body.id, "a@x.test");
    const s = (await call("GET", `/api/courses/${c.body.id}/versions/1`)).body;
    const page = await learner("GET", `${path}/l/${s.modules[0].lessons[0].id}`);
    expect(page.html).not.toContain("<script>alert");
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).not.toContain("javascript:");
  });
});

describe("new versions and renewals", () => {
  it("moves unstarted people to the new version, keeps the started on theirs, and retrains on request", async () => {
    const { id } = await publishedCourse();
    const ana = await linkFor(id, "ana@acme.test");
    await takeCourse(ana, (await call("GET", `/api/courses/${id}/versions/1`)).body);

    const course = await call("GET", `/api/courses/${id}`);
    const text = course.body.modules[0].lessons[0];
    await call("PATCH", `/api/lessons/${text.id}`, { body: "## Before you sign\n\n- Count the pallets\n- Check the seals\n- Photograph damage" });
    expect((await call("GET", `/api/courses/${id}`)).body.unpublished_changes).toBe(true);

    const pub = await call("POST", `/api/courses/${id}/publish`, { notes: "Photograph damage", retrain: true });
    expect(pub.body).toEqual({ version: 2, assigned: 1 });

    const open = await call("GET", `/api/enrollments?course_id=${id}&status=open`);
    expect(open.body.enrollments.map((e: any) => [e.learner_name, e.course_version]).sort()).toEqual([["Ana Ruiz", 2], ["Ben Ode", 2]]);
    const done = await call("GET", `/api/enrollments?course_id=${id}&status=completed`);
    expect(done.body.enrollments[0]).toMatchObject({ learner_name: "Ana Ruiz", course_version: 1, renewed: true });
  });

  it("assigns the course again when a completion comes due", async () => {
    const { id } = await publishedCourse();
    const ana = await linkFor(id, "ana@acme.test");
    await takeCourse(ana, (await call("GET", `/api/courses/${id}/versions/1`)).body);
    expect((await call("POST", "/api/sync")).body.assigned).toBe(0);
    db.exec("UPDATE enrollments SET renew_at = datetime('now', '-1 day') WHERE status = 'completed'");
    expect((await call("POST", "/api/sync")).body.assigned).toBe(1);
    expect((await call("GET", `/api/enrollments?course_id=${id}&search=ana&status=open`)).body.total).toBe(1);
  });

  it("cancels a deactivated person's open assignments and keeps their completions", async () => {
    const { id } = await publishedCourse();
    const ben = (await call("GET", "/api/learners?search=ben")).body.learners[0];
    await call("PATCH", `/api/learners/${ben.id}`, { active: false });
    const r = await call("GET", `/api/enrollments?course_id=${id}&search=ben`);
    expect(r.body.enrollments[0].status).toBe("cancelled");
    const page = await learner("GET", new URL(r.body.enrollments[0].link).pathname);
    expect(page.html).toContain("withdrawn");
  });
});

describe("at scale", () => {
  it("imports 500 people into a published course in a bounded number of queries", async () => {
    const { id } = await publishedCourse();
    const people = Array.from({ length: 500 }, (_, i) => ({
      name: `Person ${i}`, email: `p${i}@acme.test`, external_id: `E${i}`,
      groups: [i % 2 ? "warehouse" : "WAREHOUSE", `Site ${i % 7}`],
    }));
    queries = 0;
    const r = await call("POST", "/api/learners/import", { people });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ created: 500, updated: 0, assigned: 500 });
    expect(queries).toBeLessThan(150);

    // Group names match regardless of case: one Warehouse group, not three.
    const groups = (await call("GET", "/api/groups?search=warehouse")).body.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toBe(502);

    // Importing again updates, and assigns nobody twice.
    const again = await call("POST", "/api/learners/import", { people: people.slice(0, 50).map((p) => ({ ...p, name: `${p.name}!` })) });
    expect(again.body).toEqual({ created: 0, updated: 50, assigned: 0 });
    const open = await call("GET", `/api/enrollments?course_id=${id}&status=open&limit=1`);
    expect(open.body.total).toBe(502);
  });

  it("retrains everyone on a new version in a bounded number of queries", async () => {
    const { id } = await publishedCourse();
    await call("POST", "/api/learners/import", { people: Array.from({ length: 300 }, (_, i) => ({ name: `P${i}`, email: `r${i}@acme.test`, groups: ["Warehouse"] })) });
    db.exec("UPDATE enrollments SET status = 'completed', completed_at = datetime('now')");
    queries = 0;
    const r = await call("POST", `/api/courses/${id}/publish`, { retrain: true });
    expect(r.body).toEqual({ version: 2, assigned: 302 });
    expect(queries).toBeLessThan(60);
  });

  it("renews a person assigned by hand, not only group members", async () => {
    const { id } = await publishedCourse();
    const cleo = (await call("GET", "/api/learners?search=cleo")).body.learners[0];
    await call("POST", `/api/courses/${id}/enrollments`, { learner_ids: [cleo.id] });
    db.exec(`UPDATE enrollments SET status = 'completed', renew_at = datetime('now', '-1 day') WHERE learner_id = '${cleo.id}'`);
    expect((await call("POST", "/api/sync")).body.assigned).toBe(1);
    const mine = await call("GET", `/api/enrollments?course_id=${id}&learner_id=${cleo.id}&status=open`);
    expect(mine.body.total).toBe(1);
  });
});

describe("records export", () => {
  it("exports the record as CSV and never lets a cell become a formula", async () => {
    const { id } = await publishedCourse();
    await call("POST", "/api/learners", { name: "=HYPERLINK(\"x\")", email: "evil@acme.test", groups: ["Warehouse"] });
    const res = await app.request(`${ORIGIN}/api/records.csv?course_id=${id}`, { headers: HEADERS.user }, { STORAGE });
    const csv = await res.text();
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("presenter videos", () => {
  it("refuses an AI presenter without recorded consent, which only a person can record", async () => {
    const c = await call("POST", "/api/courses", { title: "Video" });
    const m = await call("POST", `/api/courses/${c.body.id}/modules`, { title: "M" });
    const l = await call("POST", `/api/modules/${m.body.id}/lessons`, { title: "Hi", kind: "video", body: "Welcome to the team." });
    const p = await call("POST", "/api/presenters", { name: "Sam Lead" });
    db.prepare("UPDATE presenters SET photo_key = 'presenters/x.png' WHERE id = ?").run(p.body.id);

    const r = await call("POST", `/api/lessons/${l.body.id}/video/avatar`, { presenter_id: p.body.id });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("no_consent");

    const agent = await call("PATCH", `/api/presenters/${p.body.id}`, { consent: true }, "agent");
    expect(agent.status).toBe(403);
    const person = await call("PATCH", `/api/presenters/${p.body.id}`, { consent: true, consent_note: "Signed form" });
    expect(person.body.consent).toMatchObject({ by: "Dana Quality", note: "Signed form" });
  });

  it("voices the script, starts the render, and lands the finished video", async () => {
    const stored = new Map<string, Uint8Array>();
    const UPLOADS = {
      async put(key: string, data: ArrayBuffer | Uint8Array) { stored.set(key, new Uint8Array(data as ArrayBuffer)); },
      async get(key: string) { const b = stored.get(key); return b ? { body: new Response(b as BodyInit).body, size: b.byteLength, httpMetadata: { contentType: "video/mp4" } } : null; },
      async delete() {},
    };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
      if (url.endsWith("/videos") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("heygen/avatar-iv");
        expect(body.input_references.map((r: any) => r.type)).toEqual(["image_url", "audio_url"]);
        expect(body.input_references[0].image_url.url).toMatch(/^https:\/\/academy\.example\/api\/public\/media\//);
        return Response.json({ id: "gen-vid-1", status: "pending" });
      }
      if (url.endsWith("/videos/gen-vid-1")) return Response.json({ id: "gen-vid-1", status: "completed", unsigned_urls: ["https://openrouter.test/v.mp4"], usage: { cost: 0.42 } });
      if (url === "https://openrouter.test/v.mp4") return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "video/mp4" } });
      throw new Error(`unexpected fetch ${url}`);
    });
    const env = { STORAGE, UPLOADS, OPENROUTER_API_KEY: "sk-test", OPENROUTER_BASE_URL: "https://eu.openrouter.test/api/v1" };
    const req = async (method: string, path: string, body?: unknown): Promise<any> => {
      const r = await app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...HEADERS.user }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
      return r.json();
    };

    const c = await req("POST", "/api/courses", { title: "Video" });
    const m = await req("POST", `/api/courses/${c.id}/modules`, { title: "M" });
    const l = await req("POST", `/api/modules/${m.id}/lessons`, { title: "Hi", kind: "video", body: "Welcome to the team." });
    const p = await req("POST", "/api/presenters", { name: "Sam Lead" });
    db.prepare("UPDATE presenters SET photo_key = 'presenters/x.png' WHERE id = ?").run(p.id);
    await req("PATCH", `/api/presenters/${p.id}`, { consent: true });

    const started = await req("POST", `/api/lessons/${l.id}/video/avatar`, { presenter_id: p.id });
    expect(started.video.status).toBe("rendering");
    expect(calls.every((u) => u.includes("eu.openrouter.test") || u.includes("openrouter.test/v.mp4"))).toBe(true);

    const done = await req("GET", `/api/lessons/${l.id}/video`);
    expect(done.video).toMatchObject({ status: "ready", source: "avatar", cost: 0.42, script_changed: false });

    await req("PATCH", `/api/lessons/${l.id}`, { body: "Welcome to the whole team." });
    const changed = await req("GET", `/api/courses/${c.id}`);
    expect(changed.problems[0]).toContain("changed after its video was made");
  });
});

describe("uploaded videos on the media service", () => {
  it("opens an upload, waits for processing, publishes, and plays from a signed link", async () => {
    const UID = "a".repeat(32);
    let ready = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "https://services.clawnify.com/media/uploads") {
        expect(JSON.parse(String(init!.body))).toMatchObject({ size: 500_000_000, name: "welcome.mp4", max_duration_seconds: 162 });
        return Response.json({ id: UID, upload_url: "https://upload.example/tus/abc" });
      }
      if (url === `https://services.clawnify.com/media/${UID}`) return Response.json({ id: UID, state: ready ? "ready" : "inprogress", ready, progress: 40, duration: 120, error: null });
      if (url === `https://services.clawnify.com/media/${UID}/playback`) return Response.json({ hls: "https://stream.example/t/manifest/video.m3u8", thumbnail: "https://stream.example/t/thumb.jpg?time={time}s" });
      throw new Error(`unexpected fetch ${url}`);
    });
    const env = { STORAGE, CLAWNIFY_TOKEN: "clw_test" };
    const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = HEADERS.user) => {
      const r = await app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
      return { status: r.status, body: (await r.text()) as any };
    };
    const j = async (...a: Parameters<typeof req>) => { const r = await req(...a); return { ...r, body: JSON.parse(r.body) }; };

    const c = (await j("POST", "/api/courses", { title: "Onboarding" })).body;
    const m = (await j("POST", `/api/courses/${c.id}/modules`, { title: "Welcome" })).body;
    const l = (await j("POST", `/api/modules/${m.id}/lessons`, { title: "Welcome video", kind: "video" })).body;

    const opened = await j("POST", `/api/lessons/${l.id}/video/uploads`, { name: "welcome.mp4", size: 500_000_000, duration: 120 });
    expect(opened.status).toBe(201);
    expect(opened.body).toEqual({ uid: UID, upload_url: "https://upload.example/tus/abc" });

    const attached = await j("POST", `/api/lessons/${l.id}/video/media`, { uid: UID });
    expect(attached.body.video).toMatchObject({ status: "rendering", stream: true, url: null });
    expect((await j("GET", `/api/courses/${c.id}`)).body.problems[0]).toContain("still being made");

    ready = true;
    expect((await j("GET", `/api/lessons/${l.id}/video`)).body.video.status).toBe("ready");
    expect((await j("GET", `/api/lessons/${l.id}/video/playback`)).body.hls).toContain("manifest/video.m3u8");

    await j("POST", "/api/learners", { name: "Ana", email: "ana@x.test", groups: ["All"] });
    const g = (await j("GET", "/api/groups")).body.groups[0];
    await j("PUT", `/api/courses/${c.id}/groups`, { group_ids: [g.id] });
    expect((await j("POST", `/api/courses/${c.id}/publish`, {})).body.version).toBe(1);
    const link = new URL((await j("GET", `/api/enrollments?course_id=${c.id}`)).body.enrollments[0].link).pathname;
    const page = await app.request(`${ORIGIN}${link}/l/${l.id}`, {}, env);
    const html = await page.text();
    expect(html).toContain('data-hls="https://stream.example/t/manifest/video.m3u8"');
    expect(html).toContain("hls.js@1.7.3");
  });

  it("tells the editor to fall back to a direct upload outside Clawnify, capped under the edge's limit", async () => {
    const c = await call("POST", "/api/courses", { title: "Local" }, "local");
    const m = await call("POST", `/api/courses/${c.body.id}/modules`, { title: "M" }, "local");
    const l = await call("POST", `/api/modules/${m.body.id}/lessons`, { title: "V", kind: "video" }, "local");
    const r = await call("POST", `/api/lessons/${l.body.id}/video/uploads`, { name: "v.mp4", size: 1000 }, "local");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("media_unavailable");
    const big = await app.request(`${ORIGIN}/api/lessons/${l.body.id}/video/file`, {
      method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(200 * 1024 * 1024) }, body: "x",
    }, { STORAGE });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toContain("95 MB");
  });
});

describe("AI draft", () => {
  it("drafts an outline from the sources and keeps only what the editor can hold", async () => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models/user")) return Response.json({ data: [{ id: "google/gemini-3.8-flash" }, { id: "anthropic/claude-sonnet-5.5" }] });
      if (url.endsWith("/chat/completions")) {
        sent.push(JSON.parse(String(init!.body)));
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          modules: [{ title: "Receiving", lessons: [
            { title: "Intro", kind: "video", body: "Hello.", questions: [] },
            { title: "Empty", kind: "text", body: "  ", questions: [] },
            { title: "Quiz", kind: "quiz", body: "", questions: [
              { prompt: "Q1", options: ["a", "b"], correct: [1], explanation: "" },
              { prompt: "Bad", options: ["a", "b"], correct: [5], explanation: "" },
            ] },
          ] }],
        }) } }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const c = await call("POST", "/api/courses", { title: "Receiving", language: "Deutsch" });
    expect((await call("POST", `/api/courses/${c.body.id}/draft`, {})).body.code).toBe("no_sources");
    await call("POST", `/api/courses/${c.body.id}/sources`, { title: "WH-02", body: "Count pallets. Check seals." });
    const r = await call("POST", `/api/courses/${c.body.id}/draft`, { instructions: "Keep it short" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ model: "anthropic/claude-sonnet-5.5", modules: 1, lessons: 2 });
    expect(sent[0].messages[0].content).toContain("Write everything in Deutsch.");
    expect(sent[0].messages[1].content).toContain("Count pallets. Check seals.");

    const course = await call("GET", `/api/courses/${c.body.id}`);
    expect(course.body.modules[0].lessons.map((l: any) => l.title)).toEqual(["Intro", "Quiz"]);
    expect(course.body.modules[0].lessons[1].questions).toHaveLength(1);
    expect((await call("POST", `/api/courses/${c.body.id}/draft`, {})).body.code).toBe("has_outline");
  });
});
