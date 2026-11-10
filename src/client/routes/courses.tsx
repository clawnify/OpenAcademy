import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BookOpen, Plus } from "lucide-react";
import { TileIcon } from "@clawnify/app/client";
import { api, type Course } from "../api";
import { Badge, Button, Dialog } from "../components/ui";
import { Field, Notice, Toolbar } from "../components/layout";
import { day } from "../components/format";

export function courseState(c: Pick<Course, "published_version" | "unpublished_changes" | "archived">) {
  if (c.archived) return <Badge>Archived</Badge>;
  if (!c.published_version) return <Badge tone="warning">Draft</Badge>;
  return c.unpublished_changes ? <Badge tone="info">Version {c.published_version}, edited</Badge> : <Badge tone="success">Version {c.published_version}</Badge>;
}

export function CoursesPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setCourses(null);
    api.courses({ archived }).then((r) => setCourses(r.courses), (e: Error) => setError(e.message));
  }, [archived]);

  return (
    <>
      <Toolbar
        icon={<TileIcon icon="book-open" color="violet" size={20} />}
        title="Courses"
        actions={
          <>
            <Button variant="ghost" onClick={() => setArchived(!archived)}>{archived ? "Current courses" : "Archived"}</Button>
            <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} /> New course</Button>
          </>
        }
      />
      {error ? <div className="p-4"><Notice tone="danger">{error}</Notice></div> : null}
      {!courses ? (
        <TableSkeleton />
      ) : courses.length === 0 ? (
        <div className="mx-auto max-w-md px-6 py-20 text-center">
          <BookOpen size={40} strokeWidth={1.25} className="mx-auto text-faint" />
          <h2 className="mt-4 text-[1.0625rem] font-semibold">{archived ? "No archived courses" : "Start from a document you already have"}</h2>
          {!archived ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                A procedure, a policy, a manual. Add it to a new course and draft the modules, lessons and quizzes from it, then edit what you
                need before you publish.
              </p>
              <div className="mt-5"><Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} /> New course</Button></div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="h-8 px-4 font-medium">Course</th>
                <th className="h-8 px-4 font-medium">State</th>
                <th className="h-8 px-4 text-right font-medium">Lessons</th>
                <th className="h-8 px-4 text-right font-medium">Groups</th>
                <th className="h-8 px-4 text-right font-medium">Open</th>
                <th className="h-8 px-4 text-right font-medium">Overdue</th>
                <th className="h-8 px-4 text-right font-medium">Completed</th>
                <th className="h-8 px-4 font-medium">Changed</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => (
                <tr key={c.id} className="border-b border-border/60 hover:bg-muted">
                  <td className="h-11 px-4">
                    <Link to={`/courses/${c.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <TileIcon icon="book-open" color="violet" size={18} />
                      {c.title}
                    </Link>
                  </td>
                  <td className="px-4">{courseState(c)}</td>
                  <td className="data px-4 text-right text-muted-foreground">{c.counts.lessons}</td>
                  <td className="data px-4 text-right text-muted-foreground">{c.counts.groups}</td>
                  <td className="data px-4 text-right">{c.counts.open}</td>
                  <td className={`data px-4 text-right ${c.counts.overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>{c.counts.overdue}</td>
                  <td className="data px-4 text-right text-muted-foreground">{c.counts.completed}</td>
                  <td className="px-4 text-muted-foreground">{day(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewCourseDialog open={open} onOpenChange={setOpen} onCreated={onChanged} />
    </>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-8 animate-pulse rounded-sm bg-muted" />)}
    </div>
  );
}

function NewCourseDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const [draftId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState("");
  const [language, setLanguage] = useState("English");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const c = await api.createCourse({ id: draftId, title: title.trim(), audience: audience.trim(), language: language.trim() || "English" });
      await onCreated();
      onOpenChange(false);
      navigate(`/courses/${c.id}/sources`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New course" description="Next, add the documents it should teach." submitLabel="Create course" submitting={busy || !title.trim()} onSubmit={submit}>
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Receiving goods at the warehouse" autoFocus />
      </Field>
      <Field label="Who takes it" hint="Helps the draft pitch it at the right level.">
        <input className="input" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Warehouse staff and shift leads" />
      </Field>
      <Field label="Language">
        <input className="input" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="English" />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
