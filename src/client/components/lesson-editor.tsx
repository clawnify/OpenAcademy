import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { api, type CourseDetail, type Lesson, type Presenter, type Question } from "../api";
import { renderMarkdown } from "../../shared/markdown";
import { Avatar, Button, Dialog, Picker } from "./ui";
import { Notice } from "./layout";
import { LessonVideo } from "./lesson-video";
import { sendLessonVideo } from "./video-upload";

const SCRIPT_MAX = 2800;

/** Save a field a moment after typing stops, and on blur. */
function useAutosave(save: (v: string) => Promise<void>, initial: string) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const last = useRef(initial);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(async (v: string) => {
    window.clearTimeout(timer.current);
    if (v === last.current) return;
    setState("saving");
    try {
      await save(v);
      last.current = v;
      setState("saved");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  }, [save]);

  const change = (v: string) => {
    setValue(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(v), 900);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { value, change, flush: () => flush(value), state, error };
}

function SaveState({ state, error }: { state: string; error: string }) {
  if (state === "saving") return <span className="text-xs text-muted-foreground">Saving</span>;
  if (state === "saved") return <span className="text-xs text-muted-foreground">Saved</span>;
  if (state === "error") return <span className="text-xs text-destructive">{error}</span>;
  return null;
}

export function LessonEditor({ lesson, course, onChanged, onDeleted }: { lesson: Lesson; course: CourseDetail; onChanged: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  const title = useAutosave(async (v) => {
    if (!v.trim()) throw new Error("A lesson needs a title");
    await api.updateLesson(lesson.id, { title: v.trim() });
    await onChanged();
  }, lesson.title);
  const module = course.modules.find((m) => m.id === lesson.module_id);

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="mb-1 flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
        <span className="truncate">{module?.title}</span>
        <span aria-hidden>·</span>
        <span>{lesson.kind === "text" ? "Text lesson" : lesson.kind === "video" ? "Video lesson" : "Quiz"}</span>
        <span className="ml-auto"><SaveState state={title.state} error={title.error} /></span>
      </div>
      <div className="flex items-start gap-2">
        <input
          aria-label="Lesson title"
          className="min-w-0 flex-1 bg-transparent text-[1.5rem] font-semibold leading-tight tracking-[-0.01em] outline-none placeholder:text-faint"
          value={title.value}
          onChange={(e) => title.change(e.target.value)}
          onBlur={() => void title.flush()}
        />
        <Button variant="ghost" size="icon" aria-label="Delete lesson" onClick={() => setDeleting(true)}><Trash2 size={16} /></Button>
      </div>
      <div className="mt-6">
        {lesson.kind === "text" ? <TextBody lesson={lesson} onChanged={onChanged} /> : null}
        {lesson.kind === "video" ? <VideoBody lesson={lesson} onChanged={onChanged} /> : null}
        {lesson.kind === "quiz" ? <QuizBody lesson={lesson} passMark={course.pass_mark} onChanged={onChanged} /> : null}
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${lesson.title}"?`}
        description="It leaves the draft. Published versions keep it until you publish again."
        submitLabel="Delete lesson"
        danger
        onSubmit={async () => { await api.deleteLesson(lesson.id); setDeleting(false); await onDeleted(); }}
      />
    </div>
  );
}

// ── Text ───────────────────────────────────────────────────────────────

function TextBody({ lesson, onChanged }: { lesson: Lesson; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<"write" | "preview">(lesson.body.trim() ? "preview" : "write");
  const body = useAutosave(async (v) => { await api.updateLesson(lesson.id, { body: v }); await onChanged(); }, lesson.body);
  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        {(["write", "preview"] as const).map((m) => (
          <button key={m} type="button" onClick={() => { if (m === "preview") void body.flush(); setMode(m); }}
            className={`h-7 rounded-sm px-2.5 text-sm font-medium ${mode === m ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {m === "write" ? "Write" : "Preview"}
          </button>
        ))}
        <span className="ml-auto"><SaveState state={body.state} error={body.error} /></span>
      </div>
      {mode === "write" ? (
        <>
          <textarea
            aria-label="Lesson text"
            className="textarea min-h-[24rem] font-mono text-[0.8125rem] leading-relaxed"
            value={body.value}
            onChange={(e) => body.change(e.target.value)}
            onBlur={() => void body.flush()}
            placeholder={"## What to check\n\n- Count the pallets against the delivery note\n- Check every seal\n\nIf a seal is broken, **refuse the pallet** and note it."}
          />
          <p className="mt-1 text-xs text-muted-foreground">Markdown: ## headings, - lists, **bold**, [links](https://…).</p>
        </>
      ) : body.value.trim() ? (
        <div className="prose card p-6" dangerouslySetInnerHTML={{ __html: renderMarkdown(body.value) }} />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing written yet.</p>
      )}
    </div>
  );
}

// ── Video: the player, and the script box under it ─────────────────────

function VideoBody({ lesson: initial, onChanged }: { lesson: Lesson; onChanged: () => Promise<void> }) {
  const [lesson, setLesson] = useState(initial);
  const [presenters, setPresenters] = useState<Presenter[] | null>(null);
  const [presenterId, setPresenterId] = useState(initial.presenter_id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const script = useAutosave(async (v) => {
    const l = await api.updateLesson(initial.id, { body: v });
    setLesson(l);
  }, initial.body);

  useEffect(() => { api.presenters().then((r) => setPresenters(r.presenters), () => setPresenters([])); }, []);
  useEffect(() => { if (!presenterId && presenters?.length === 1) setPresenterId(presenters[0]!.id); }, [presenters, presenterId]);

  const working = lesson.video.status === "voicing" || lesson.video.status === "rendering";
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(async () => {
      try {
        const l = await api.videoState(lesson.id);
        setLesson(l);
        if (l.video.status !== "voicing" && l.video.status !== "rendering") await onChanged();
      } catch { /* keep polling */ }
    }, 5000);
    return () => window.clearInterval(t);
  }, [working, lesson.id, onChanged]);

  const presenter = presenters?.find((p) => p.id === presenterId) ?? null;
  const blocker = !presenter
    ? null
    : !presenter.has_photo
      ? `Add a photo of ${presenter.name} first.`
      : !presenter.consent
        ? `Record ${presenter.name}'s consent before making a presenter from their photo.`
        : null;

  async function make() {
    setBusy(true);
    setError("");
    try {
      await script.flush();
      if (presenterId !== lesson.presenter_id) await api.updateLesson(lesson.id, { presenter_id: presenterId || null });
      setLesson(await api.makeVideo(lesson.id, presenterId));
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(f: File) {
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      setLesson(await sendLessonVideo(lesson.id, f, (sent, total) => setProgress(sent / total)));
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
      if (file.current) file.current.value = "";
    }
  }

  const words = script.value.trim() ? script.value.trim().split(/\s+/).length : 0;
  const minutes = words / 150;

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-md bg-foreground/90 shadow-raised">
        {(lesson.video.url || lesson.video.stream) && !working && progress === null ? (
          <>
            <LessonVideo lesson={lesson} />
            {lesson.video.source === "avatar" ? (
              <span className="absolute left-3 top-3 rounded-xs bg-foreground/75 px-2 py-0.5 text-[0.6875rem] font-semibold text-background">AI generated</span>
            ) : null}
          </>
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center text-background">
            {progress !== null ? (
              <>
                <p className="text-sm font-medium">Uploading <span className="data">{Math.round(progress * 100)}%</span></p>
                <div className="h-1.5 w-64 overflow-hidden rounded-full bg-background/25">
                  <div className="h-full bg-background" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <p className="max-w-sm text-xs opacity-75">Keep this page open until the upload finishes.</p>
              </>
            ) : working ? (
              <>
                <p className="thinking text-sm font-medium">
                  {lesson.video.status === "voicing" ? "Recording the voice" : lesson.video.source === "upload" ? "Processing the video" : "Animating the presenter"}
                </p>
                <p className="max-w-sm text-xs opacity-75">This takes a minute or two. You can leave this page; the video lands here when it's done.</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No video yet</p>
                <p className="max-w-sm text-xs opacity-75">Make one from the script below with a presenter, or upload one you recorded.</p>
              </>
            )}
          </div>
        )}
      </div>

      {lesson.video.status === "failed" ? <Notice tone="danger">{lesson.video.error || "The video could not be made."}</Notice> : null}
      {lesson.video.script_changed && !working ? (
        <Notice tone="warning">The script changed after this video was made. Make the video again, or change the script back, before you publish.</Notice>
      ) : null}

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <PresenterChip presenters={presenters} value={presenterId} onChange={setPresenterId} />
          <span className="ml-auto text-xs text-muted-foreground data">
            {script.value.length} / {SCRIPT_MAX} · about {minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))} s` : `${minutes.toFixed(1)} min`}
          </span>
        </div>
        <textarea
          aria-label="Presenter script"
          className="block min-h-48 w-full resize-y bg-transparent px-4 py-3 text-[0.9375rem] leading-relaxed outline-none placeholder:text-faint"
          value={script.value}
          maxLength={SCRIPT_MAX}
          onChange={(e) => script.change(e.target.value)}
          onBlur={() => void script.flush()}
          placeholder="What the presenter says, as they would say it. Short sentences read best: say what to do, then why."
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <SaveState state={script.state} error={script.error} />
          <span className="text-xs text-muted-foreground">Making a video uses AI credits. Learners see it marked as AI generated.</span>
          <div className="ml-auto flex gap-2">
            <input ref={file} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
            <Button variant="ghost" onClick={() => file.current?.click()} disabled={busy || working}><Upload size={15} /> Upload video</Button>
            <Button variant="secondary" onClick={make} disabled={busy || working || !presenterId || !!blocker || !script.value.trim()}>
              <Sparkles size={15} /> {lesson.video.status === "ready" ? "Make again" : "Make video"}
            </Button>
          </div>
        </div>
      </div>
      {blocker ? <Notice tone="warning" action={<Link to="/presenters" className="text-sm font-medium underline">Presenters</Link>}>{blocker}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

function PresenterChip({ presenters, value, onChange }: { presenters: Presenter[] | null; value: string; onChange: (v: string) => void }) {
  if (presenters && presenters.length === 0) {
    return (
      <Link to="/presenters" className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm text-muted-foreground hover:bg-muted">
        <Plus size={14} /> Add a presenter
      </Link>
    );
  }
  const current = presenters?.find((p) => p.id === value);
  return (
    <div className="flex items-center gap-2">
      {current ? <Avatar name={current.name} src={current.photo_url} size={24} /> : null}
      <Picker
        kind="view"
        label="Presenter"
        value={value}
        placeholder="Choose a presenter"
        onChange={onChange}
        options={(presenters ?? []).map((p) => ({ value: p.id, label: p.name, hint: !p.has_photo ? "No photo" : !p.consent ? "No consent" : p.voice || undefined }))}
      />
    </div>
  );
}

// ── Quiz ───────────────────────────────────────────────────────────────

function QuizBody({ lesson, passMark, onChanged }: { lesson: Lesson; passMark: number; onChanged: () => Promise<void> }) {
  const [error, setError] = useState("");
  async function add() {
    try {
      await api.addQuestion(lesson.id, { prompt: "New question", options: ["First answer", "Second answer"], correct: [0], explanation: "" });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Learners need {passMark}% on this quiz to pass, and can retake it as often as they like. Mark every correct answer; with more than one, they
        must choose all of them.
      </p>
      {lesson.questions.map((q, i) => <QuestionCard key={q.id} q={q} n={i + 1} onChanged={onChanged} />)}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button variant="secondary" onClick={add}><Plus size={15} /> Add question</Button>
    </div>
  );
}

function QuestionCard({ q, n, onChanged }: { q: Question; n: number; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(q);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => setDraft(q), [q]);

  async function save(next: Question) {
    setDraft(next);
    if (!next.prompt.trim() || next.options.some((o) => !o.trim()) || !next.correct.length) {
      setState("error");
      setError(!next.correct.length ? "Mark at least one correct answer" : "Fill in the question and every answer");
      return;
    }
    setState("saving");
    try {
      await api.updateQuestion(q.id, { prompt: next.prompt, options: next.options, correct: next.correct, explanation: next.explanation });
      setState("saved");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  }

  const toggle = (i: number) => {
    const correct = draft.correct.includes(i) ? draft.correct.filter((x) => x !== i) : [...draft.correct, i].sort();
    void save({ ...draft, correct });
  };
  const removeOption = (i: number) => {
    const options = draft.options.filter((_, x) => x !== i);
    const correct = draft.correct.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
    void save({ ...draft, options, correct });
  };

  return (
    <div className="card p-4">
      <div className="flex items-start gap-2">
        <span className="data mt-1.5 text-sm text-muted-foreground">{n}.</span>
        <textarea
          aria-label={`Question ${n}`}
          rows={2}
          className="min-w-0 flex-1 resize-y bg-transparent py-1 text-[0.9375rem] font-medium outline-none"
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          onBlur={() => void save(draft)}
        />
        <Button variant="ghost" size="icon" aria-label={`Delete question ${n}`} onClick={async () => { await api.deleteQuestion(q.id); await onChanged(); }}>
          <Trash2 size={15} />
        </Button>
      </div>
      <ul className="mt-2 space-y-1.5 pl-5">
        {draft.options.map((o, i) => (
          <li key={i} className="flex items-center gap-2">
            <input type="checkbox" aria-label={`Answer ${i + 1} is correct`} checked={draft.correct.includes(i)} onChange={() => toggle(i)} className="h-4 w-4" />
            <input
              className={`input h-8 ${draft.correct.includes(i) ? "font-medium" : ""}`}
              aria-label={`Answer ${i + 1}`}
              value={o}
              onChange={(e) => setDraft({ ...draft, options: draft.options.map((x, j) => (j === i ? e.target.value : x)) })}
              onBlur={() => void save(draft)}
            />
            {draft.options.length > 2 ? (
              <Button variant="ghost" size="icon" aria-label={`Remove answer ${i + 1}`} onClick={() => removeOption(i)}><Trash2 size={14} /></Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="mt-2 pl-5">
        {draft.options.length < 8 ? (
          <Button variant="ghost" onClick={() => setDraft({ ...draft, options: [...draft.options, ""] })}><Plus size={14} /> Add answer</Button>
        ) : null}
      </div>
      <label className="mt-3 block pl-5">
        <span className="mb-1 block text-[0.8125rem] font-medium text-muted-foreground">Explanation, shown after answering</span>
        <textarea
          rows={2}
          className="textarea min-h-0 text-sm"
          value={draft.explanation}
          onChange={(e) => setDraft({ ...draft, explanation: e.target.value })}
          onBlur={() => void save(draft)}
          placeholder="Which part of the procedure says so"
        />
      </label>
      <div className="mt-2 pl-5"><SaveState state={state} error={error} /></div>
    </div>
  );
}
