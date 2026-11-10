import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, FileText, ListChecks, MoreHorizontal, Plus, Video } from "lucide-react";
import { TileIcon, openChat, useChatContext, useHasChat, useHostChanges } from "@clawnify/app/client";
import { api, type CourseDetail, type Lesson, type LessonKind, type Module } from "../api";
import { Button, Dialog, Popover, PopoverContent, PopoverTrigger } from "../components/ui";
import { Field, Notice, Toolbar } from "../components/layout";
import { LessonEditor } from "../components/lesson-editor";
import { courseState, TableSkeleton } from "./courses";
import { AssignTab, HistoryTab, SettingsTab, SourcesTab } from "./course-tabs";

const TABS = [
  { id: "outline", label: "Outline" },
  { id: "sources", label: "Sources" },
  { id: "assign", label: "Assign" },
  { id: "settings", label: "Settings" },
  { id: "history", label: "Versions" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export const KIND_ICON: Record<LessonKind, typeof FileText> = { text: FileText, video: Video, quiz: ListChecks };
export const KIND_LABEL: Record<LessonKind, string> = { text: "Text", video: "Video", quiz: "Quiz" };

export function CoursePage({ onChanged }: { onChanged: () => Promise<void> }) {
  const { id = "", tab: tabParam } = useParams();
  const tab: Tab = (TABS.find((t) => t.id === tabParam)?.id ?? "outline") as Tab;
  const navigate = useNavigate();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const hasChat = useHasChat();

  const load = useCallback(async () => {
    try {
      setCourse(await api.course(id));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useHostChanges(() => void load());
  useChatContext(course ? { label: "Course", record: { type: "course", id: course.id, label: course.title } } : null);

  const changed = useCallback(async () => {
    await load();
    await onChanged();
  }, [load, onChanged]);

  if (error && !course) return <div className="p-6"><Notice tone="danger">{error}</Notice></div>;
  if (!course) return <TableSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<TileIcon icon="book-open" color="violet" size={20} />}
        title={course.title}
        meta={courseState(course)}
        actions={
          <>
            {hasChat ? (
              <Button variant="ghost" onClick={() => openChat(`Improve the course "${course.title}": `)}>Ask AI</Button>
            ) : null}
            <Button variant="primary" onClick={() => setPublishing(true)} disabled={!course.unpublished_changes && !!course.published_version}>
              {course.published_version ? "Publish changes" : "Publish"}
            </Button>
          </>
        }
      />
      <nav className="flex gap-1 overflow-x-auto border-b border-border px-4 md:px-6" aria-label="Course sections">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/courses/${course.id}${t.id === "outline" ? "" : `/${t.id}`}`}
            aria-current={t.id === tab ? "page" : undefined}
            className={`whitespace-nowrap px-2 py-2.5 text-sm font-medium ${t.id === tab ? "text-foreground shadow-[inset_0_-2px_0_var(--color-foreground)]" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            {t.id === "sources" && course.sources ? <span className="data ml-1.5 text-xs text-muted-foreground">{course.sources}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "outline" ? <OutlineTab course={course} onChanged={changed} /> : null}
        {tab === "sources" ? <SourcesTab course={course} onChanged={changed} onDrafted={() => navigate(`/courses/${course.id}`)} /> : null}
        {tab === "assign" ? <AssignTab course={course} onChanged={changed} /> : null}
        {tab === "settings" ? <SettingsTab course={course} onChanged={changed} /> : null}
        {tab === "history" ? <HistoryTab course={course} /> : null}
      </div>
      <PublishDialog open={publishing} onOpenChange={setPublishing} course={course} onPublished={changed} />
    </div>
  );
}

// ── Outline ────────────────────────────────────────────────────────────

function OutlineTab({ course, onChanged }: { course: CourseDetail; onChanged: () => Promise<void> }) {
  const [params, setParams] = useSearchParams();
  const lessons = useMemo(() => course.modules.flatMap((m) => m.lessons), [course.modules]);
  const selected = lessons.find((l) => l.id === params.get("lesson")) ?? lessons[0] ?? null;
  const select = (id: string) => setParams({ lesson: id }, { replace: true });
  const [addingModule, setAddingModule] = useState(false);

  if (!course.modules.length) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center">
        <TileIcon icon="sparkles" color="violet" size={36} />
        <h2 className="mt-4 text-[1.0625rem] font-semibold">Draft this course from your documents</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Add the procedure, policy or manual it should teach, and the draft writes modules, lessons, presenter scripts and quizzes from
          it. Nothing reaches anyone until you publish.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link to={`/courses/${course.id}/sources`} className="inline-flex h-7 items-center rounded-sm bg-card px-2.5 text-sm font-medium shadow-raised hover:bg-muted">
            Add documents
          </Link>
          <Button variant="ghost" onClick={() => setAddingModule(true)}>Write it yourself</Button>
        </div>
        <ModuleDialog open={addingModule} onOpenChange={setAddingModule} courseId={course.id} onDone={onChanged} />
      </div>
    );
  }

  return (
    <div className="grid min-h-full md:grid-cols-[300px_1fr]">
      <aside className="border-b border-border bg-muted/50 p-3 md:border-b-0 md:border-r" aria-label="Course outline">
        <OutlineList course={course} selected={selected?.id ?? null} onSelect={select} onChanged={onChanged} />
        <Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => setAddingModule(true)}>
          <Plus size={16} /> Add module
        </Button>
        <ModuleDialog open={addingModule} onOpenChange={setAddingModule} courseId={course.id} onDone={onChanged} />
      </aside>
      <section className="min-w-0">
        {selected ? (
          <LessonEditor key={selected.id} lesson={selected} course={course} onChanged={onChanged} onDeleted={async () => { await onChanged(); setParams({}, { replace: true }); }} />
        ) : (
          <p className="p-8 text-sm text-muted-foreground">Add a lesson to a module to start writing.</p>
        )}
      </section>
    </div>
  );
}

function OutlineList({ course, selected, onSelect, onChanged }: { course: CourseDetail; selected: string | null; onSelect: (id: string) => void; onChanged: () => Promise<void> }) {
  const [error, setError] = useState("");
  let n = 0;

  /** Move a module or a lesson one place, across module boundaries for lessons. */
  async function move(kind: "module" | "lesson", id: string, dir: -1 | 1) {
    const mods = course.modules.map((m) => ({ id: m.id, lessons: m.lessons.map((l) => l.id) }));
    if (kind === "module") {
      const i = mods.findIndex((m) => m.id === id);
      const j = i + dir;
      if (j < 0 || j >= mods.length) return;
      [mods[i], mods[j]] = [mods[j]!, mods[i]!];
    } else {
      const mi = mods.findIndex((m) => m.lessons.includes(id));
      const li = mods[mi]!.lessons.indexOf(id);
      const target = li + dir;
      mods[mi]!.lessons.splice(li, 1);
      if (target < 0 && mi > 0) mods[mi - 1]!.lessons.push(id);
      else if (target > mods[mi]!.lessons.length && mi < mods.length - 1) mods[mi + 1]!.lessons.unshift(id);
      else mods[mi]!.lessons.splice(Math.max(0, Math.min(target, mods[mi]!.lessons.length)), 0, id);
    }
    try {
      await api.order(course.id, mods);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {course.modules.map((m, mi) => (
        <div key={m.id}>
          <ModuleHeader module={m} first={mi === 0} last={mi === course.modules.length - 1} onMove={(d) => move("module", m.id, d)} onChanged={onChanged} />
          <ul className="mt-1 space-y-0.5">
            {m.lessons.map((l) => {
              n++;
              return (
                <li key={l.id}>
                  <LessonRow lesson={l} number={n} active={l.id === selected} onSelect={() => onSelect(l.id)} onMove={(d) => move("lesson", l.id, d)} />
                </li>
              );
            })}
          </ul>
          <AddLesson module={m} onAdded={async (l) => { await onChanged(); onSelect(l.id); }} />
        </div>
      ))}
    </div>
  );
}

function ModuleHeader({ module, first, last, onMove, onChanged }: { module: Module; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onChanged: () => Promise<void> }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex items-center gap-1 px-1">
      <h3 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-muted-foreground">{module.title}</h3>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Module ${module.title} options`} className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted">
            <MoreHorizontal size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44">
          {[
            ["Rename", () => setRenaming(true)],
            ...(first ? [] : [["Move up", () => onMove(-1)]]),
            ...(last ? [] : [["Move down", () => onMove(1)]]),
            ["Delete", () => setDeleting(true)],
          ].map(([label, fn]) => (
            <button key={label as string} type="button" onClick={() => { setMenu(false); (fn as () => void)(); }} className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted">
              {label as string}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <ModuleDialog open={renaming} onOpenChange={setRenaming} module={module} onDone={onChanged} />
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${module.title}"?`}
        description={`Its ${module.lessons.length} lessons go with it. Published versions keep theirs.`}
        submitLabel="Delete module"
        danger
        onSubmit={async () => { await api.deleteModule(module.id); setDeleting(false); await onChanged(); }}
      />
    </div>
  );
}

function LessonRow({ lesson, number, active, onSelect, onMove }: { lesson: Lesson; number: number; active: boolean; onSelect: () => void; onMove: (d: -1 | 1) => void }) {
  const Icon = KIND_ICON[lesson.kind];
  const busy = lesson.video.status === "voicing" || lesson.video.status === "rendering";
  const missing =
    (lesson.kind === "video" && lesson.video.status !== "ready") ||
    (lesson.kind === "quiz" && !lesson.questions.length) ||
    (lesson.kind === "text" && !lesson.body.trim());
  return (
    <div className={`group flex items-center gap-2 rounded-sm px-1 ${active ? "bg-card shadow-raised" : "hover:bg-card/70"}`}>
      <button type="button" onClick={onSelect} aria-current={active ? "true" : undefined} className="flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm">
        <span className="data w-5 shrink-0 text-right text-xs text-muted-foreground">{number}</span>
        <Icon size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" aria-label={KIND_LABEL[lesson.kind]} />
        <span className={`min-w-0 flex-1 truncate ${busy ? "thinking" : ""}`}>{lesson.title}</span>
        {lesson.video.status === "failed" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive-solid" aria-label="Video failed" /> : null}
        {!busy && missing && lesson.video.status !== "failed" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-solid" aria-label="Not finished" /> : null}
      </button>
      <span className="hidden shrink-0 gap-0.5 group-hover:flex group-focus-within:flex">
        <button type="button" aria-label="Move up" onClick={() => onMove(-1)} className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"><ArrowUp size={14} /></button>
        <button type="button" aria-label="Move down" onClick={() => onMove(1)} className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"><ArrowDown size={14} /></button>
      </span>
    </div>
  );
}

function AddLesson({ module, onAdded }: { module: Module; onAdded: (l: Lesson) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  async function add(kind: LessonKind) {
    setOpen(false);
    try {
      const title = kind === "quiz" ? `Quiz: ${module.title}` : kind === "video" ? "New video lesson" : "New lesson";
      await onAdded(await api.addLesson(module.id, { title, kind }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="mt-0.5 flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm text-muted-foreground hover:bg-card/70 hover:text-foreground">
            <Plus size={14} /> Add lesson
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          {(["text", "video", "quiz"] as LessonKind[]).map((k) => {
            const Icon = KIND_ICON[k];
            const hint = { text: "Reading, with headings and lists", video: "A presenter reads your script, or upload a video", quiz: "Questions with a pass mark" }[k];
            return (
              <button key={k} type="button" onClick={() => add(k)} className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-muted">
                <Icon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">{KIND_LABEL[k]}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </>
  );
}

function ModuleDialog({ open, onOpenChange, courseId, module, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; courseId?: string; module?: Module; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(module?.title ?? "");
  const [error, setError] = useState("");
  useEffect(() => { if (open) setTitle(module?.title ?? ""); }, [open, module?.title]);
  async function submit() {
    try {
      if (module) await api.renameModule(module.id, title.trim());
      else await api.addModule(courseId!, title.trim());
      onOpenChange(false);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={module ? "Rename module" : "Add a module"} submitLabel={module ? "Save" : "Add module"} submitting={!title.trim()} onSubmit={submit}>
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Receiving goods" autoFocus />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}

// ── Publish ────────────────────────────────────────────────────────────

function PublishDialog({ open, onOpenChange, course, onPublished }: { open: boolean; onOpenChange: (o: boolean) => void; course: CourseDetail; onPublished: () => Promise<void> }) {
  const [notes, setNotes] = useState("");
  const [retrain, setRetrain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ version: number; assigned: number } | null>(null);
  useEffect(() => { if (open) { setError(""); setDone(null); setNotes(""); setRetrain(false); } }, [open]);

  const blocked = course.problems.length > 0;
  async function submit() {
    if (done) return onOpenChange(false);
    setBusy(true);
    setError("");
    try {
      setDone(await api.publish(course.id, { notes: notes.trim() || undefined, retrain }));
      await onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const next = (course.published_version ?? 0) + 1;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={done ? `Version ${done.version} is live` : `Publish version ${next}`}
      description={done ? undefined : "Learners only ever see a published version. People who already started keep the version they started."}
      submitLabel={done ? "Done" : `Publish version ${next}`}
      submitting={busy || (!done && blocked)}
      onSubmit={submit}
    >
      {done ? (
        <p className="text-sm">
          {done.assigned ? `${done.assigned} ${done.assigned === 1 ? "person was" : "people were"} assigned the course.` : "Nobody new was assigned."}{" "}
          {course.groups.length === 0 ? <>The course has no groups yet: choose who must take it on the <Link className="underline" to={`/courses/${course.id}/assign`} onClick={() => onOpenChange(false)}>Assign</Link> tab.</> : null}
        </p>
      ) : blocked ? (
        <Notice tone="warning">
          <p className="font-medium">Fix these first:</p>
          <ul className="mt-1 list-disc pl-4">{course.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Notice>
      ) : (
        <>
          <Field label="What changed" hint="Kept with the version, for the record.">
            <textarea className="textarea text-sm" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={course.published_version ? "Updated step 3 after the new delivery form" : "First version"} />
          </Field>
          {course.published_version ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={retrain} onChange={(e) => setRetrain(e.target.checked)} />
              <span>Everyone who completed an earlier version takes this one too</span>
            </label>
          ) : null}
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
