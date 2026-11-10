import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, Download } from "lucide-react";
import { TileIcon, useHostChanges } from "@clawnify/app/client";
import { api, type Course, type Enrollment, type EnrollmentDetail } from "../api";
import { Button, Dialog, Picker, Tooltip } from "../components/ui";
import { Notice, Pager, Toolbar } from "../components/layout";
import { EnrollmentBadge, day, when } from "../components/format";
import { TableSkeleton } from "./courses";

const STATUSES = [
  { value: "", label: "Every status" },
  { value: "open", label: "Still to finish" },
  { value: "overdue", label: "Overdue" },
  { value: "in_progress", label: "In progress" },
  { value: "assigned", label: "Not started" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Withdrawn" },
];

const ACTIVITY: Record<string, string> = {
  assigned: "Assigned",
  started: "Started",
  lesson_done: "Finished a lesson",
  quiz: "Took a quiz",
  attested: "Confirmed",
  completed: "Completed",
  cancelled: "Withdrawn",
};

export function RecordsPage() {
  const [params, setParams] = useSearchParams();
  const courseId = params.get("course_id") ?? "";
  const status = params.get("status") ?? "";
  const learnerId = params.get("learner_id") ?? "";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [courses, setCourses] = useState<Course[]>([]);
  const [data, setData] = useState<{ enrollments: Enrollment[]; total: number; limit: number } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };

  const load = useCallback(async () => {
    try {
      setData(await api.enrollments({ page, search, course_id: courseId || undefined, status: status || undefined, learner_id: learnerId || undefined }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, search, courseId, status, learnerId]);
  useEffect(() => { const t = window.setTimeout(() => void load(), search ? 250 : 0); return () => window.clearTimeout(t); }, [load, search]);
  useEffect(() => { api.courses().then((r) => setCourses(r.courses), () => {}); }, []);
  useHostChanges(() => void load());

  const csv = `/api/records.csv?${new URLSearchParams({ ...(courseId ? { course_id: courseId } : {}), ...(status ? { status } : {}) })}`;

  return (
    <>
      <Toolbar
        icon={<TileIcon icon="clipboard-list" color="green" size={20} />}
        title="Records"
        meta={data ? `${data.total}` : undefined}
        actions={<a href={csv} className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-card px-2.5 text-sm font-medium shadow-raised hover:bg-muted"><Download size={15} /> Export CSV</a>}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Picker kind="view" label="Course" value={courseId} onChange={(v) => setFilter("course_id", v)} options={[{ value: "", label: "Every course" }, ...courses.map((c) => ({ value: c.id, label: c.title }))]} />
        <Picker kind="view" label="Status" value={status} onChange={(v) => setFilter("status", v)} options={STATUSES} />
        {learnerId ? <Button variant="ghost" onClick={() => setFilter("learner_id", "")}>One person ×</Button> : null}
        <input className="input ml-auto max-w-xs" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search people" aria-label="Search people" />
      </div>
      {error ? <div className="p-4"><Notice tone="danger">{error}</Notice></div> : null}
      {!data ? (
        <TableSkeleton />
      ) : data.enrollments.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-muted-foreground">No records match. People appear here once a published course is assigned to them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="h-8 px-4 font-medium">Person</th>
                <th className="h-8 px-4 font-medium">Course</th>
                <th className="h-8 px-4 font-medium">Status</th>
                <th className="h-8 px-4 font-medium">Due</th>
                <th className="h-8 px-4 font-medium">Completed</th>
                <th className="h-8 px-4 text-right font-medium">Score</th>
                <th className="h-8 px-4 font-medium"><span className="sr-only">Link</span></th>
              </tr>
            </thead>
            <tbody>
              {data.enrollments.map((e) => (
                <tr key={e.id} className="border-b border-border/60 hover:bg-muted">
                  <td className="h-11 px-4">
                    <button type="button" className="text-left" onClick={() => setOpen(e.id)}>
                      <span className="block font-medium hover:underline">{e.learner_name}</span>
                      <span className="block text-xs text-muted-foreground">{e.learner_email}</span>
                    </button>
                  </td>
                  <td className="px-4">{e.course_title} <span className="text-muted-foreground">v{e.course_version}</span></td>
                  <td className="px-4"><EnrollmentBadge e={e} /></td>
                  <td className={`px-4 ${e.overdue ? "text-destructive" : "text-muted-foreground"}`}>{day(e.due_at)}</td>
                  <td className="px-4 text-muted-foreground">{day(e.completed_at)}</td>
                  <td className="data px-4 text-right">{e.score !== null ? `${e.score}%` : ""}</td>
                  <td className="px-4 text-right">{e.status === "assigned" || e.status === "in_progress" ? <CopyLink link={e.link} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} limit={data.limit} total={data.total} onPage={setPage} />
        </div>
      )}
      <RecordDialog id={open} onClose={() => setOpen(null)} onChanged={load} />
    </>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied" : "Copy their personal link"}>
      <Button variant="ghost" size="icon" aria-label="Copy their personal link" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </Button>
    </Tooltip>
  );
}

function RecordDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const [r, setR] = useState<EnrollmentDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setR(null);
    setError("");
    if (id) api.enrollment(id).then(setR, (e: Error) => setError(e.message));
  }, [id]);
  const withdrawable = r && (r.status === "assigned" || r.status === "in_progress");

  return (
    <Dialog
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={r ? `${r.learner_name}: ${r.course_title}` : "Record"}
      description={r ? `Version ${r.course_version} · assigned ${day(r.assigned_at)}${r.due_at ? ` · due ${day(r.due_at)}` : ""}` : undefined}
      submitLabel={withdrawable ? "Withdraw assignment" : "Close"}
      danger={!!withdrawable}
      onSubmit={async () => {
        if (withdrawable) {
          await api.cancelEnrollment(r!.id);
          await onChanged();
        }
        onClose();
      }}
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {r ? (
        <>
          <div className="flex items-center gap-2"><EnrollmentBadge e={r} />{r.score !== null ? <span className="data text-sm">Score {r.score}%</span> : null}</div>
          {r.attestation ? <p className="rounded-sm bg-muted px-3 py-2 text-sm">“{r.attestation}” <span className="text-muted-foreground">confirmed {when(r.attested_at)}</span></p> : null}
          <ol className="max-h-64 space-y-1.5 overflow-y-auto text-sm">
            {r.activity.map((a, i) => (
              <li key={i} className="flex gap-3">
                <span className="data w-36 shrink-0 text-xs text-muted-foreground">{when(a.at)}</span>
                <span>{ACTIVITY[a.kind] ?? a.kind}{a.detail ? <span className="text-muted-foreground">: {a.detail}</span> : null}</span>
              </li>
            ))}
          </ol>
          {withdrawable ? <p className="text-xs text-muted-foreground">Their link: <span className="break-all">{r.link}</span></p> : null}
        </>
      ) : null}
    </Dialog>
  );
}
