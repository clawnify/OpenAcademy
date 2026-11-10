import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Globe, Sparkles, Trash2, Upload } from "lucide-react";
import { api, type CourseDetail, type Group, type Learner, type Source } from "../api";
import { Button, Card, CardTitle, Dialog, Zone } from "../components/ui";
import { Field, Notice } from "../components/layout";
import { day, plural, when } from "../components/format";

// ── Sources and the AI draft ───────────────────────────────────────────

export function SourcesTab({ course, onChanged, onDrafted }: { course: CourseDetail; onChanged: () => Promise<void>; onDrafted: () => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setSources((await api.sources(course.id)).sources);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), [course.id]);

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4 md:grid-cols-[1fr_340px] md:p-6">
      <div className="space-y-4">
        <AddSource courseId={course.id} onAdded={async () => { await load(); await onChanged(); }} />
        <Card>
          <Zone><CardTitle right={sources ? plural(sources.length, "document") : ""}>Documents this course teaches</CardTitle></Zone>
          {error ? <Zone><Notice tone="danger">{error}</Notice></Zone> : null}
          {sources?.length === 0 ? (
            <Zone><p className="text-sm text-muted-foreground">None yet. The draft only uses what you add here, so it never invents a rule your documents don't contain.</p></Zone>
          ) : null}
          {sources?.map((s) => (
            <Zone key={s.id} className="flex items-start gap-3">
              {s.kind === "url" ? <Globe size={16} className="mt-0.5 shrink-0 text-muted-foreground" /> : <FileText size={16} className="mt-0.5 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{s.title}</span>
                  <span className="data shrink-0 text-xs text-muted-foreground">{s.chars.toLocaleString()} characters</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.excerpt}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label={`Remove ${s.title}`} onClick={async () => { await api.deleteSource(s.id); await load(); await onChanged(); }}>
                <Trash2 size={15} />
              </Button>
            </Zone>
          ))}
        </Card>
      </div>
      <DraftPanel course={course} hasSources={!!sources?.length} onDrafted={async () => { await onChanged(); onDrafted(); }} />
    </div>
  );
}

function AddSource({ courseId, onAdded }: { courseId: string; onAdded: () => Promise<void> }) {
  const [mode, setMode] = useState<"paste" | "url">("paste");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);

  async function add(input: { title?: string; body?: string; url?: string }) {
    setBusy(true);
    setError("");
    try {
      await api.addSource(courseId, input);
      setTitle("");
      setBody("");
      setUrl("");
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function readFiles(files: FileList) {
    for (const f of Array.from(files)) {
      if (!/\.(md|markdown|txt|csv)$/i.test(f.name) && !f.type.startsWith("text/")) {
        setError(`${f.name}: add text, Markdown or CSV files here. For a PDF or Word file, copy its text in, or ask the agent to add it.`);
        continue;
      }
      await add({ title: f.name.replace(/\.[^.]+$/, ""), body: await f.text() });
    }
    if (file.current) file.current.value = "";
  }

  return (
    <Card>
      <Zone className="flex items-center gap-1">
        {(["paste", "url"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`h-7 rounded-sm px-2.5 text-sm font-medium ${mode === m ? "bg-muted" : "text-muted-foreground hover:text-foreground"}`}>
            {m === "paste" ? "Paste text" : "Web page"}
          </button>
        ))}
        <input ref={file} type="file" multiple accept=".md,.markdown,.txt,.csv,text/*" className="hidden" onChange={(e) => e.target.files && void readFiles(e.target.files)} />
        <Button variant="ghost" className="ml-auto" onClick={() => file.current?.click()} disabled={busy}><Upload size={15} /> Text files</Button>
      </Zone>
      <Zone className="space-y-3">
        {mode === "paste" ? (
          <>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. WH-02 Receiving procedure" aria-label="Document title" />
            <textarea className="textarea min-h-40 text-sm" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the procedure, policy or manual here" aria-label="Document text" />
            <div className="flex justify-end"><Button variant="secondary" disabled={busy || !body.trim()} onClick={() => add({ title: title.trim() || undefined, body })}>Add document</Button></div>
          </>
        ) : (
          <>
            <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://intranet.example.com/policies/receiving" aria-label="Page address" />
            <p className="text-xs text-muted-foreground">The page must be public. Its text is read once and kept here.</p>
            <div className="flex justify-end"><Button variant="secondary" disabled={busy || !/^https?:\/\//.test(url)} onClick={() => add({ url: url.trim() })}>Read page</Button></div>
          </>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Zone>
    </Card>
  );
}

function DraftPanel({ course, hasSources, onDrafted }: { course: CourseDetail; hasSources: boolean; onDrafted: () => Promise<void> }) {
  const [instructions, setInstructions] = useState("");
  const [video, setVideo] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function run(replace: boolean) {
    setConfirm(false);
    setBusy(true);
    setError("");
    try {
      const r = await api.draft(course.id, { instructions: instructions.trim() || undefined, video_lessons: video, replace });
      setNote(r.truncated ?? "");
      await onDrafted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit">
      <Zone><CardTitle>Draft with AI</CardTitle></Zone>
      <Zone className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Writes modules, lessons and a quiz per module from the documents, in {course.language}. You edit everything before publishing.
        </p>
        <Field label="Instructions (optional)">
          <textarea className="textarea min-h-20 text-sm" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Focus on what changes for shift leads. Leave out the history of the policy." />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={video} onChange={(e) => setVideo(e.target.checked)} />
          <span>Start each module with a presenter video script</span>
        </label>
        <Button variant="secondary" className="w-full" disabled={busy || !hasSources} onClick={() => (course.modules.length ? setConfirm(true) : run(false))}>
          <Sparkles size={15} /> <span className={busy ? "thinking" : ""}>{busy ? "Drafting, about a minute" : "Draft the course"}</span>
        </Button>
        {!hasSources ? <p className="text-xs text-muted-foreground">Add a document first.</p> : null}
        <p className="text-xs text-muted-foreground">Uses AI credits.</p>
        {note ? <Notice tone="warning">{note}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Zone>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Replace the outline?"
        description={`The draft replaces all ${course.counts.lessons} lessons in this course, with any videos you made for them. Published versions are not affected.`}
        submitLabel="Replace outline"
        danger
        onSubmit={() => run(true)}
      />
    </Card>
  );
}

// ── Assign ─────────────────────────────────────────────────────────────

export function AssignTab({ course, onChanged }: { course: CourseDetail; onChanged: () => Promise<void> }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(course.groups.map((g) => g.id)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.groups().then((r) => setGroups(r.groups), (e: Error) => setError(e.message)); }, []);
  useEffect(() => setChosen(new Set(course.groups.map((g) => g.id))), [course.groups]);

  const dirty = [...chosen].sort().join() !== course.groups.map((g) => g.id).sort().join();
  async function save() {
    setSaving(true);
    setError("");
    try {
      const r = await api.setGroups(course.id, [...chosen]);
      setMessage(course.published_version ? (r.assigned ? `${plural(r.assigned, "person")} assigned.` : "Saved. Nobody new to assign.") : "Saved. They are assigned when you publish.");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4 md:grid-cols-2 md:p-6">
      <Card className="h-fit">
        <Zone><CardTitle>Required for</CardTitle></Zone>
        <Zone className="space-y-1">
          {!course.published_version ? <div className="mb-2"><Notice tone="info">Nobody is assigned until the course is published.</Notice></div> : null}
          {groups?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No groups yet. <Link to="/people" className="underline">Add people and groups</Link> first.</p>
          ) : null}
          {groups?.map((g) => (
            <label key={g.id} className="flex min-h-8 items-center gap-2 rounded-sm px-1 text-sm hover:bg-muted">
              <input type="checkbox" checked={chosen.has(g.id)} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} />
              <span className="flex-1">{g.name}</span>
              <span className="data text-xs text-muted-foreground">{plural(g.members, "person", "people")}</span>
            </label>
          ))}
        </Zone>
        <Zone className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{message}</span>
          <Button variant="secondary" className="ml-auto" onClick={save} disabled={saving || !dirty}>Save groups</Button>
        </Zone>
        {error ? <Zone><Notice tone="danger">{error}</Notice></Zone> : null}
      </Card>
      <div className="space-y-4">
        <AssignPeople course={course} onChanged={onChanged} />
        <Card>
          <Zone className="space-y-2 text-sm">
            <CardTitle>Who has it</CardTitle>
            <p className="text-muted-foreground">
              {course.counts.open} still to finish, {course.counts.overdue} overdue, {course.counts.completed} completed.
              {course.renew_months ? ` Assigned again ${course.renew_months} months after completion.` : ""}
            </p>
            <Link to={`/records?course_id=${course.id}`} className="inline-block font-medium underline">Open the records</Link>
          </Zone>
        </Card>
      </div>
    </div>
  );
}

function AssignPeople({ course, onChanged }: { course: CourseDetail; onChanged: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Learner[]>([]);
  const [picked, setPicked] = useState<Learner[]>([]);
  const [due, setDue] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!search.trim()) return setResults([]);
    const t = window.setTimeout(() => api.learners({ search }).then((r) => setResults(r.learners.slice(0, 8)), () => {}), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  async function assign() {
    setError("");
    try {
      const r = await api.assign(course.id, picked.map((p) => p.id), due || undefined);
      setMessage(r.assigned ? `${plural(r.assigned, "person")} assigned.` : "They already have it open.");
      setPicked([]);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card>
      <Zone><CardTitle>Assign to particular people</CardTitle></Zone>
      <Zone className="space-y-3">
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email" aria-label="Search people" disabled={!course.published_version} />
        {results.length ? (
          <ul className="space-y-0.5">
            {results.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { setPicked([...picked, r]); setSearch(""); }}>
                  <span className="font-medium">{r.name}</span><span className="text-muted-foreground">{r.email}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {picked.length ? (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <button key={p.id} type="button" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} className="rounded-xs bg-muted px-2 py-0.5 text-xs" aria-label={`Remove ${p.name}`}>
                {p.name} ×
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Field label="Due">
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Button variant="secondary" className="ml-auto" disabled={!picked.length} onClick={assign}>Assign</Button>
        </div>
        {!course.published_version ? <p className="text-xs text-muted-foreground">Publish the course first.</p> : null}
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Zone>
    </Card>
  );
}

// ── Settings ───────────────────────────────────────────────────────────

export function SettingsTab({ course, onChanged }: { course: CourseDetail; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const [f, setF] = useState({
    title: course.title, description: course.description, audience: course.audience, language: course.language,
    pass_mark: String(course.pass_mark), due_days: String(course.due_days), renew_months: course.renew_months ? String(course.renew_months) : "",
    attestation: course.attestation,
  });
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setError("");
    try {
      await api.updateCourse(course.id, {
        title: f.title.trim(), description: f.description, audience: f.audience, language: f.language.trim() || "English",
        pass_mark: Number(f.pass_mark), due_days: Number(f.due_days), renew_months: f.renew_months ? Number(f.renew_months) : null,
        attestation: f.attestation.trim(),
      });
      setSaved("Saved");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <Card>
        <Zone className="space-y-3">
          <Field label="Title"><input className="input" value={f.title} onChange={set("title")} /></Field>
          <Field label="Description" hint="Shown to learners before they start. Markdown.">
            <textarea className="textarea text-sm" value={f.description} onChange={set("description")} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Who takes it"><input className="input" value={f.audience} onChange={set("audience")} /></Field>
            <Field label="Language"><input className="input" value={f.language} onChange={set("language")} /></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Pass mark, %"><input className="input" type="number" min={0} max={100} value={f.pass_mark} onChange={set("pass_mark")} /></Field>
            <Field label="Days to complete" hint="0 for no due date"><input className="input" type="number" min={0} max={365} value={f.due_days} onChange={set("due_days")} /></Field>
            <Field label="Renew after, months" hint="Empty: once"><input className="input" type="number" min={1} max={60} value={f.renew_months} onChange={set("renew_months")} /></Field>
          </div>
          <Field label="What learners confirm when they finish">
            <textarea className="textarea min-h-16 text-sm" value={f.attestation} onChange={set("attestation")} />
          </Field>
        </Zone>
        <Zone className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{saved || "Changes to what learners read reach them when you publish."}</span>
          <Button variant="secondary" className="ml-auto" onClick={save}>Save</Button>
        </Zone>
        {error ? <Zone><Notice tone="danger">{error}</Notice></Zone> : null}
      </Card>
      <Card>
        <Zone className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{course.archived ? "Archived" : course.published_version ? "Archive this course" : "Delete this course"}</p>
            <p className="text-xs text-muted-foreground">
              {course.published_version
                ? "Archiving stops new assignments. The records stay, as they must for an audit."
                : "It was never published, so nothing else depends on it."}
            </p>
          </div>
          {course.published_version ? (
            <Button variant="secondary" onClick={async () => { await api.updateCourse(course.id, { archived: !course.archived }); await onChanged(); }}>
              {course.archived ? "Restore" : "Archive"}
            </Button>
          ) : (
            <Button variant="danger" onClick={() => setDeleting(true)}>Delete</Button>
          )}
        </Zone>
      </Card>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${course.title}"?`}
        description="Its outline and sources are deleted."
        submitLabel="Delete course"
        danger
        onSubmit={async () => {
          try {
            await api.deleteCourse(course.id);
            await onChanged();
            navigate("/courses");
          } catch (e) {
            setError((e as Error).message);
            setDeleting(false);
          }
        }}
      />
    </div>
  );
}

// ── Versions ───────────────────────────────────────────────────────────

export function HistoryTab({ course }: { course: CourseDetail }) {
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <Card>
        <Zone><CardTitle right={course.unpublished_changes && course.published_version ? "Unpublished changes in the draft" : ""}>Published versions</CardTitle></Zone>
        {course.versions.length === 0 ? (
          <Zone><p className="text-sm text-muted-foreground">Not published yet. Each publish keeps a frozen copy here, and every completion records which one the person took.</p></Zone>
        ) : (
          course.versions.map((v) => (
            <Zone key={v.version} className="flex items-start gap-4">
              <span className="data w-10 shrink-0 text-sm font-semibold">v{v.version}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{v.notes || <span className="text-muted-foreground">No notes</span>}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{when(v.published_at)}{v.published_by ? ` by ${v.published_by}` : ""}</p>
              </div>
              <Link to={`/records?course_id=${course.id}`} className="shrink-0 text-xs text-muted-foreground underline">Records</Link>
            </Zone>
          ))
        )}
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">Created {day(course.created_at)}.</p>
    </div>
  );
}
