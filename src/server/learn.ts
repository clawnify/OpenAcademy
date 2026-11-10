// The learner's side: the pages a person opens from their personal link.
//
// Learners are not members of the workspace, so this is public and rendered
// here rather than by the editor's frontend. The link's token is the only key:
// every query below is scoped by the enrollment it resolves to, and a lesson id
// is only honoured if it is in that enrollment's own published version.
//
// None of this is on the OpenAPI surface: an agent has no business taking a
// course on someone's behalf.

import type { Hono } from "hono";
import { get, query, run } from "./db.js";
import {
  completeEnrollment, courseScore, doneLessons, enrollmentByToken, logActivity, markLessonDone, quizPassed, readSnapshot,
  readyToAttest, scoreQuiz, snapshotLessons, startIfNeeded, type EnrollmentRow, type Snapshot, type SnapshotLesson,
} from "./course.js";
import { serveUpload } from "./uploads.js";
import { escapeHtml as esc, renderMarkdown } from "../shared/markdown.js";
import { InputError, parseJson, uid } from "./util.js";
import { readSettings } from "./settings.js";

// ── Page shell ────────────────────────────────────────────────────────

const STYLE = `
:root {
  --bg: oklch(0.975 0.002 85); --card: oklch(1 0 0); --fg: oklch(0.22 0.002 85); --muted: oklch(0.5 0.005 85);
  --faint: oklch(0.68 0.007 85); --border: oklch(0.915 0.007 85); --soft: oklch(0.955 0.003 85);
  --primary: oklch(0.22 0.002 85); --primary-fg: oklch(1 0 0); --accent: oklch(0.6 0.204 15.7056);
  --success: oklch(0.44 0.081 152); --success-tint: oklch(0.955 0.044 152); --success-solid: oklch(0.6 0.134 152);
  --danger: oklch(0.44 0.125 25); --danger-tint: oklch(0.955 0.013 25);
  --info: oklch(0.44 0.211 265); --info-tint: oklch(0.955 0.013 265);
  --warning: oklch(0.44 0.064 78); --warning-tint: oklch(0.955 0.023 78);
  --ring: inset 0 0 0 1px var(--border);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(0.17 0.002 85); --card: oklch(0.2 0.002 85); --fg: oklch(0.95 0.002 85); --muted: oklch(0.8 0.007 85);
    --faint: oklch(0.6 0.006 85); --border: oklch(0.3 0.003 85); --soft: oklch(0.25 0.003 85);
    --primary: oklch(0.95 0.002 85); --primary-fg: oklch(0.17 0.002 85);
    --success: oklch(0.82 0.119 152); --success-tint: oklch(0.27 0.032 152); --success-solid: oklch(0.62 0.130 152);
    --danger: oklch(0.82 0.055 25); --danger-tint: oklch(0.27 0.049 25);
    --info: oklch(0.82 0.049 265); --info-tint: oklch(0.27 0.083 265);
    --warning: oklch(0.82 0.093 78); --warning-tint: oklch(0.27 0.025 78);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 15px/1.6 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.shell { display: flex; min-height: 100vh; }
.side { width: 300px; flex-shrink: 0; border-right: 1px solid var(--border); padding: 20px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.side h2 { font-size: 15px; font-weight: 600; margin: 0 8px 4px; line-height: 1.3; }
.progress { margin: 12px 8px 20px; }
.bar { height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--success-solid); }
.small { font-size: 13px; color: var(--muted); }
.mod { margin: 16px 8px 4px; font-size: 13px; font-weight: 500; color: var(--muted); }
.lesson { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; border-radius: 8px; text-decoration: none; font-size: 14px; }
.lesson:hover { background: var(--soft); }
.lesson[aria-current] { background: var(--soft); font-weight: 500; }
.dot { width: 18px; height: 18px; border-radius: 999px; flex-shrink: 0; box-shadow: var(--ring); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: var(--muted); }
.dot.done { background: var(--success-solid); box-shadow: none; color: var(--primary-fg); }
main { flex: 1; min-width: 0; padding: 40px 24px 80px; }
.page { max-width: 760px; margin: 0 auto; }
.eyebrow { font-size: 13px; color: var(--muted); margin: 0 0 4px; }
h1 { font-size: 28px; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 24px; font-weight: 600; }
.prose h2 { font-size: 20px; margin: 28px 0 8px; font-weight: 600; }
.prose h3, .prose h4 { font-size: 16px; margin: 20px 0 6px; font-weight: 600; }
.prose p, .prose ul, .prose ol { margin: 0 0 14px; }
.prose li { margin: 4px 0; }
.prose blockquote { margin: 0 0 14px; padding: 8px 14px; border-left: 3px solid var(--border); color: var(--muted); }
.prose code { font-size: 13px; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
.card { background: var(--card); border-radius: 12px; box-shadow: var(--ring); padding: 20px; margin: 0 0 16px; }
.video { position: relative; border-radius: 12px; overflow: hidden; background: oklch(0.12 0 0); margin: 0 0 12px; }
.video video { display: block; width: 100%; aspect-ratio: 16 / 9; }
.ai { position: absolute; top: 12px; left: 12px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 6px; background: oklch(0.12 0 0 / 0.75); color: oklch(1 0 0); }
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
.pill.ok { background: var(--success-tint); color: var(--success); }
.pill.no { background: var(--danger-tint); color: var(--danger); }
.pill.info { background: var(--info-tint); color: var(--info); }
.pill.warn { background: var(--warning-tint); color: var(--warning); }
.actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 28px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 16px; border-radius: 8px; border: 0; font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
.btn.primary { background: var(--primary); color: var(--primary-fg); }
.btn.primary:disabled { opacity: 0.45; cursor: default; }
.btn.secondary { background: var(--card); color: var(--fg); box-shadow: var(--ring); }
.q { margin: 0 0 16px; }
.q legend { font-weight: 500; margin-bottom: 10px; padding: 0; }
.q fieldset { border: 0; margin: 0; padding: 0; }
.opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; box-shadow: var(--ring); margin: 0 0 8px; cursor: pointer; background: var(--card); }
.opt input { margin-top: 4px; }
.opt.right { box-shadow: inset 0 0 0 1px var(--success-solid); background: var(--success-tint); }
.opt.wrong { box-shadow: inset 0 0 0 1px var(--danger); background: var(--danger-tint); }
.why { font-size: 14px; color: var(--muted); margin: 6px 0 0; }
.score { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.badge { width: 64px; height: 64px; border-radius: 16px; background: var(--success-solid); color: var(--primary-fg); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; flex-shrink: 0; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; font-size: 14px; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
.check { display: flex; gap: 10px; align-items: flex-start; font-weight: 500; }
.check input { margin-top: 5px; width: 18px; height: 18px; }
.menu { display: none; }
@media (max-width: 860px) {
  .shell { display: block; }
  .side { display: none; }
  .menu { display: block; border-bottom: 1px solid var(--border); padding: 12px 16px; }
  .menu summary { cursor: pointer; font-weight: 500; font-size: 14px; }
  main { padding: 24px 16px 64px; }
  h1 { font-size: 24px; }
  input, select, textarea { font-size: 16px; }
}
@media print { .side, .menu, .actions { display: none !important; } main { padding: 0; } body { background: var(--card); } }
`;

function html(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${esc(title)}</title>` +
      `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">` +
      `<style>${STYLE}</style></head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

function message(title: string, text: string, status = 200): Response {
  return html(title, `<main><div class="page"><h1>${esc(title)}</h1><p class="small">${esc(text)}</p></div></main>`, status);
}

const notFound = () => message("This link doesn't work", "Check that you opened the whole link from your invitation, or ask whoever sent it for a new one.", 404);

interface Ctx {
  e: EnrollmentRow;
  s: Snapshot;
  base: string;
  done: Set<string>;
  passed: Set<string>;
  orgName: string;
  learnerName: string;
}

async function context(token: string): Promise<Ctx | Response> {
  const e = await enrollmentByToken(token);
  if (!e) return notFound();
  if (e.status === "cancelled") return message("This assignment was withdrawn", "You no longer need to take this course. If you think that's a mistake, ask whoever assigned it.");
  const s = await readSnapshot(e.course_id, e.course_version);
  const done = await doneLessons(e.id);
  const { perQuiz } = await courseScore(e, s);
  const passed = new Set(snapshotLessons(s).filter((l) => l.kind === "quiz" && quizPassed(perQuiz.get(l.id), s.course.pass_mark)).map((l) => l.id));
  const settings = await readSettings();
  const learner = await get<{ name: string }>("SELECT name FROM learners WHERE id = ?", [e.learner_id]);
  return { e, s, base: `/learn/${token}`, done, passed, orgName: settings?.organization_name ?? "", learnerName: learner?.name ?? "" };
}

const isDone = (c: Ctx, l: SnapshotLesson) => (l.kind === "quiz" ? c.passed.has(l.id) : c.done.has(l.id));

function progress(c: Ctx) {
  const all = snapshotLessons(c.s);
  const n = all.filter((l) => isDone(c, l)).length;
  return { n, total: all.length, percent: all.length ? Math.round((n / all.length) * 100) : 0 };
}

function nextLesson(c: Ctx, after?: string): SnapshotLesson | null {
  const all = snapshotLessons(c.s);
  const start = after ? all.findIndex((l) => l.id === after) + 1 : 0;
  return all.slice(start).find((l) => !isDone(c, l)) ?? all.slice(0, start).find((l) => !isDone(c, l)) ?? null;
}

function sidebar(c: Ctx, current: string | null): string {
  const p = progress(c);
  let i = 0;
  const list = c.s.modules
    .map((m) => {
      const rows = m.lessons
        .map((l) => {
          i++;
          const d = isDone(c, l);
          return `<a class="lesson" href="${c.base}/l/${l.id}"${l.id === current ? ' aria-current="page"' : ""}>` +
            `<span class="dot${d ? " done" : ""}" aria-label="${d ? "Done" : "Not done"}">${d ? "✓" : i}</span>${esc(l.title)}</a>`;
        })
        .join("");
      return `<div class="mod">${esc(m.title)}</div>${rows}`;
    })
    .join("");
  const head = `<h2><a href="${c.base}" style="text-decoration:none">${esc(c.s.course.title)}</a></h2>` +
    `<div class="progress"><div class="bar"><span style="width:${p.percent}%"></span></div>` +
    `<div class="small" style="margin-top:6px">${p.n} of ${p.total} done</div></div>`;
  return `<nav class="side" aria-label="Lessons">${head}${list}</nav>` +
    `<details class="menu"><summary>${esc(c.s.course.title)} · ${p.n} of ${p.total} done</summary><div style="margin-top:8px">${list}</div></details>`;
}

const frame = (c: Ctx, current: string | null, inner: string) =>
  `<div class="shell">${sidebar(c, current)}<main><div class="page">${inner}</div></main></div>`;

const fmtDate = (sql: string | null) => {
  if (!sql) return "";
  const d = new Date(`${sql.replace(" ", "T")}Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

// ── Pages ─────────────────────────────────────────────────────────────

function overview(c: Ctx): string {
  const p = progress(c);
  const next = nextLesson(c);
  const ready = !next;
  let status = "";
  if (c.e.status === "completed") {
    status = `<div class="score"><div class="badge">${c.e.score ?? "✓"}</div><div><span class="pill ok">Completed</span>` +
      `<div style="font-weight:600;margin-top:4px">${esc(c.s.course.title)}</div>` +
      `<div class="small">${fmtDate(c.e.completed_at)} · version ${c.e.course_version}</div></div></div>`;
  }
  const due = c.e.due_at && c.e.status !== "completed"
    ? `<p class="small">Due by ${fmtDate(c.e.due_at)}.</p>`
    : "";
  const action = c.e.status === "completed"
    ? `<a class="btn secondary" href="${c.base}/certificate">Certificate</a>`
    : ready
      ? `<a class="btn primary" href="${c.base}/finish">Finish the course</a>`
      : `<a class="btn primary" href="${c.base}/l/${next!.id}">${p.n ? "Continue" : "Start the course"}</a>`;
  return frame(
    c,
    null,
    `${status}<p class="eyebrow">${esc(c.orgName || "Training")}${c.learnerName ? ` · for ${esc(c.learnerName)}` : ""}</p>` +
      `<h1>${esc(c.s.course.title)}</h1>` +
      (c.s.course.description ? `<div class="prose">${renderMarkdown(c.s.course.description)}</div>` : "") +
      `<p class="small">${p.total} lessons in ${c.s.modules.length} ${c.s.modules.length === 1 ? "module" : "modules"}. ` +
      `${snapshotLessons(c.s).some((l) => l.kind === "quiz") ? `Each quiz needs ${c.s.course.pass_mark}% to pass, and you can retake it as often as you like.` : ""}</p>` +
      due +
      `<div class="actions" style="justify-content:flex-start">${action}</div>`,
  );
}

function lessonPage(c: Ctx, l: SnapshotLesson, attempt: { answers: Record<string, number[]>; correct: number; total: number } | null): string {
  const mod = c.s.modules.find((m) => m.lessons.some((x) => x.id === l.id))!;
  const head = `<p class="eyebrow">${esc(mod.title)}</p><h1>${esc(l.title)}</h1>`;
  const after = nextLesson({ ...c, done: new Set([...c.done, l.id]) }, l.id);
  const nextHref = after ? `${c.base}/l/${after.id}` : `${c.base}/finish`;

  if (l.kind === "quiz") {
    const passed = c.passed.has(l.id);
    let banner = "";
    if (attempt) {
      const ok = quizPassed({ correct: attempt.correct, total: attempt.total }, c.s.course.pass_mark);
      banner = `<div class="card" role="status"><span class="pill ${ok ? "ok" : "no"}">${ok ? "Passed" : "Not passed yet"}</span> ` +
        `<strong style="margin-left:6px">${attempt.correct} of ${attempt.total} correct</strong>` +
        `<p class="small" style="margin:6px 0 0">${ok ? "Well done." : `You need ${c.s.course.pass_mark}% to pass. Read the explanations, then try again.`}</p></div>`;
    } else if (passed) {
      banner = `<div class="card"><span class="pill ok">Passed</span> <span class="small">You can take it again to practise.</span></div>`;
    }
    const questions = l.questions
      .map((q, qi) => {
        const multi = q.correct.length > 1;
        const given = attempt?.answers[q.id] ?? [];
        const opts = q.options
          .map((o, oi) => {
            let cls = "opt";
            if (attempt && given.includes(oi)) cls += q.correct.includes(oi) ? " right" : " wrong";
            return `<label class="${cls}"><input type="${multi ? "checkbox" : "radio"}" name="q_${q.id}" value="${oi}"${attempt && given.includes(oi) ? " checked" : ""}${attempt ? " disabled" : multi ? "" : " required"}> <span>${esc(o)}</span></label>`;
          })
          .join("");
        const why = attempt && q.explanation ? `<p class="why">${esc(q.explanation)}</p>` : "";
        return `<div class="card q"><fieldset><legend>${qi + 1}. ${esc(q.prompt)}${multi ? ' <span class="small">(choose all that apply)</span>' : ""}</legend>${opts}${why}</fieldset></div>`;
      })
      .join("");
    const showNext = attempt ? quizPassed({ correct: attempt.correct, total: attempt.total }, c.s.course.pass_mark) : passed;
    const actions = attempt
      ? `<a class="btn secondary" href="${c.base}/l/${l.id}">Try again</a>${showNext ? `<a class="btn primary" href="${nextHref}">Continue</a>` : ""}`
      : `${passed ? `<a class="btn secondary" href="${nextHref}">Skip, I've passed</a>` : ""}<button class="btn primary" type="submit">Check answers</button>`;
    const form = attempt
      ? `${questions}<div class="actions">${actions}</div>`
      : `<form method="post" action="${c.base}/l/${l.id}/quiz">${questions}<div class="actions">${actions}</div></form>`;
    return frame(c, l.id, head + banner + form);
  }

  let content = "";
  if (l.kind === "video") {
    const label = l.ai_presenter ? `<span class="ai">AI GENERATED</span>` : "";
    content = `<div class="video">${label}<video id="v" controls playsinline preload="metadata" src="${c.base}/media/${l.id}"></video></div>` +
      (l.ai_presenter
        ? `<p class="small">${l.presenter_name ? `${esc(l.presenter_name)} is presented by an AI-generated video.` : "The presenter in this video is AI-generated."}</p>`
        : "") +
      (l.body ? `<details style="margin-top:12px"><summary class="small" style="cursor:pointer">Read the transcript</summary><div class="prose" style="margin-top:8px">${renderMarkdown(l.body)}</div></details>` : "");
  } else {
    content = `<div class="prose">${renderMarkdown(l.body)}</div>`;
  }
  const doneAlready = c.done.has(l.id);
  // A video's Continue waits for the end of the video, once. It is a nudge, not proof:
  // the record says the person marked it done, never that they watched every second.
  const gate = l.kind === "video" && !doneAlready
    ? `<script>(function(){var v=document.getElementById("v"),b=document.getElementById("go");if(!v||!b)return;b.disabled=true;b.title="Available when the video ends";v.addEventListener("ended",function(){b.disabled=false;b.title="";});v.addEventListener("error",function(){b.disabled=false;});})();</script>`
    : "";
  return frame(
    c,
    l.id,
    head + content +
      `<form method="post" action="${c.base}/l/${l.id}/done"><div class="actions"><button id="go" class="btn primary" type="submit">Continue</button></div></form>` +
      gate,
  );
}

async function finishPage(c: Ctx): Promise<string> {
  if (c.e.status === "completed") return overview(c);
  const missing = snapshotLessons(c.s).filter((l) => !isDone(c, l));
  if (missing.length) {
    return frame(
      c,
      null,
      `<h1>Almost there</h1><p>Finish these first:</p><ul>${missing.map((l) => `<li><a href="${c.base}/l/${l.id}">${esc(l.title)}</a>${l.kind === "quiz" ? " (pass the quiz)" : ""}</li>`).join("")}</ul>`,
    );
  }
  const { percent } = await courseScore(c.e, c.s);
  return frame(
    c,
    null,
    `<h1>Finish the course</h1>` +
      (percent !== null ? `<p class="small">Your score: ${percent}%.</p>` : "") +
      `<form method="post" action="${c.base}/finish"><div class="card"><label class="check"><input type="checkbox" name="agree" value="1" required> <span>${esc(c.s.course.attestation)}</span></label></div>` +
      `<p class="small">Your name, the date, the version of the course and your score are kept as the record that you completed it.</p>` +
      `<div class="actions"><button class="btn primary" type="submit">Complete the course</button></div></form>`,
  );
}

async function certificate(c: Ctx): Promise<string> {
  const signer = (await readSettings()).certificate_signer;
  return `<main><div class="page"><div class="card" style="padding:48px 40px;text-align:center">` +
    `<p class="eyebrow">${esc(c.orgName || "Certificate of completion")}</p>` +
    `<h1 style="margin:8px 0 4px">${esc(c.learnerName)}</h1>` +
    `<p>completed</p><p style="font-size:20px;font-weight:600;margin:4px 0 24px">${esc(c.s.course.title)}</p>` +
    `<dl class="facts" style="justify-content:center;text-align:left;margin:0 auto 24px;width:max-content">` +
    `<dt>Completed</dt><dd>${fmtDate(c.e.completed_at)}</dd>` +
    `<dt>Course version</dt><dd>${c.e.course_version}</dd>` +
    (c.e.score !== null ? `<dt>Score</dt><dd>${c.e.score}%</dd>` : "") +
    (signer ? `<dt>Issued by</dt><dd>${esc(signer)}</dd>` : "") +
    `<dt>Reference</dt><dd style="font-family:ui-monospace,monospace;font-size:12px">${esc(c.e.id)}</dd></dl>` +
    `<p class="small" style="max-width:480px;margin:0 auto">They confirmed: “${esc(c.e.attestation ?? c.s.course.attestation)}”</p>` +
    `</div><div class="actions"><a class="btn secondary" href="${c.base}">Back</a><button class="btn primary" onclick="window.print()">Print or save as PDF</button></div></div></main>`;
}

// ── Routes ────────────────────────────────────────────────────────────

function findLesson(c: Ctx, id: string): SnapshotLesson | null {
  return snapshotLessons(c.s).find((l) => l.id === id) ?? null;
}

export function registerLearn(app: Hono<any>) {
  app.get("/learn/:token", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    return html(ctx.s.course.title, overview(ctx));
  });

  app.get("/learn/:token/l/:lesson", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    const lesson = findLesson(ctx, c.req.param("lesson"));
    if (!lesson) return notFound();
    if (ctx.e.status !== "completed") await startIfNeeded(ctx.e);
    let attempt = null;
    const attemptId = c.req.query("attempt");
    if (attemptId && lesson.kind === "quiz") {
      const row = await get<{ answers: string; correct: number; total: number }>(
        "SELECT answers, correct, total FROM quiz_attempts WHERE id = ? AND enrollment_id = ? AND lesson_id = ?",
        [attemptId, ctx.e.id, lesson.id],
      );
      if (row) attempt = { answers: parseJson<Record<string, number[]>>(row.answers, {}), correct: row.correct, total: row.total };
    }
    return html(`${lesson.title} · ${ctx.s.course.title}`, lessonPage(ctx, lesson, attempt));
  });

  app.post("/learn/:token/l/:lesson/done", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    const lesson = findLesson(ctx, c.req.param("lesson"));
    if (!lesson || lesson.kind === "quiz") return notFound();
    if (ctx.e.status !== "completed") {
      await startIfNeeded(ctx.e);
      await markLessonDone(ctx.e, lesson);
    }
    ctx.done.add(lesson.id);
    const next = nextLesson(ctx, lesson.id);
    return c.redirect(next ? `${ctx.base}/l/${next.id}` : `${ctx.base}/finish`, 303);
  });

  app.post("/learn/:token/l/:lesson/quiz", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    const lesson = findLesson(ctx, c.req.param("lesson"));
    if (!lesson || lesson.kind !== "quiz") return notFound();
    const form = await c.req.formData();
    const answers: Record<string, number[]> = {};
    for (const q of lesson.questions) {
      answers[q.id] = form.getAll(`q_${q.id}`).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    }
    const score = scoreQuiz(lesson, answers);
    const id = uid();
    if (ctx.e.status !== "completed") await startIfNeeded(ctx.e);
    await run("INSERT INTO quiz_attempts (id, enrollment_id, lesson_id, answers, correct, total) VALUES (?, ?, ?, ?, ?, ?)", [
      id, ctx.e.id, lesson.id, JSON.stringify(answers), score.correct, score.total,
    ]);
    await logActivity(ctx.e.id, "quiz", `${lesson.title}: ${score.correct} of ${score.total}`);
    return c.redirect(`${ctx.base}/l/${lesson.id}?attempt=${id}`, 303);
  });

  app.get("/learn/:token/finish", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    return html(`Finish · ${ctx.s.course.title}`, await finishPage(ctx));
  });

  app.post("/learn/:token/finish", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    const form = await c.req.formData();
    if (form.get("agree") !== "1") return c.redirect(`${ctx.base}/finish`, 303);
    if (!(await readyToAttest(ctx.e, ctx.s))) return c.redirect(`${ctx.base}/finish`, 303);
    try {
      await completeEnrollment(ctx.e, ctx.s);
    } catch (err) {
      if (err instanceof InputError) return c.redirect(`${ctx.base}/finish`, 303);
      throw err;
    }
    return c.redirect(ctx.base, 303);
  });

  app.get("/learn/:token/certificate", async (c) => {
    const ctx = await context(c.req.param("token"));
    if (ctx instanceof Response) return ctx;
    if (ctx.e.status !== "completed") return c.redirect(ctx.base, 303);
    return html(`Certificate · ${ctx.s.course.title}`, await certificate(ctx));
  });

  app.get("/learn/:token/media/:lesson", async (c) => {
    const e = await enrollmentByToken(c.req.param("token"));
    if (!e || e.status === "cancelled") return c.text("Not found", 404);
    const s = await readSnapshot(e.course_id, e.course_version);
    const lesson = snapshotLessons(s).find((l) => l.id === c.req.param("lesson"));
    if (!lesson?.video_key) return c.text("Not found", 404);
    const res = await serveUpload(lesson.video_key, c.req.header("Range"), { "Cache-Control": "private, max-age=3600" });
    return res ?? c.text("Not found", 404);
  });
}

/** For the editor's records view: the attempts behind one enrollment. */
export async function attemptsFor(enrollmentId: string) {
  return query<{ id: string; lesson_id: string; correct: number; total: number; created_at: string }>(
    "SELECT id, lesson_id, correct, total, created_at FROM quiz_attempts WHERE enrollment_id = ? ORDER BY created_at",
    [enrollmentId],
  );
}
