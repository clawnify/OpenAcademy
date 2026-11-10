import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { TileIcon, useHostChanges } from "@clawnify/app/client";
import { api, type Overview } from "../api";
import { Toolbar, Notice } from "../components/layout";
import { Card, CardTitle, Empty, Zone } from "../components/ui";
import { TableSkeleton } from "./courses";

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api.overview());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useHostChanges(() => void load());

  return (
    <>
      <Toolbar icon={<TileIcon icon="book-open" color="violet" size={20} />} title="Training" />
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {!data ? (
          <TableSkeleton rows={4} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Overdue" value={data.overdue} to="/records?status=overdue" tone={data.overdue ? "text-destructive" : ""} />
              <Stat label="Still to finish" value={data.open} to="/records?status=open" />
              <Stat label="Due in 7 days" value={data.due_7d} to="/records?status=open" />
              <Stat label="Completed, 30 days" value={data.completed_30d} to="/records?status=completed" />
            </div>
            <Card>
              <Zone>
                <CardTitle right={`${data.published_courses} published · ${data.learners} people`}>Courses</CardTitle>
              </Zone>
              {data.courses.length === 0 ? (
                <div className="mx-auto max-w-md px-6 py-12 text-center">
                  <BookOpen size={36} strokeWidth={1.25} className="mx-auto text-faint" />
                  <h2 className="mt-3 text-[1.0625rem] font-semibold">Turn a procedure into a course</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Create a course, add the documents it should teach, and draft it with AI. Publish it to the groups that must take it,
                    and everyone gets their own link.
                  </p>
                  <Link to="/courses" className="mt-4 inline-flex h-7 items-center rounded-sm bg-primary px-2.5 text-sm font-medium text-primary-foreground shadow-solid hover:bg-primary-hover">
                    Go to courses
                  </Link>
                </div>
              ) : (
                <table className="w-full text-[0.8125rem]">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="h-8 px-4 font-medium">Course</th>
                      <th className="h-8 px-4 font-medium">Completion</th>
                      <th className="h-8 px-4 text-right font-medium">Open</th>
                      <th className="h-8 px-4 text-right font-medium">Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.courses.map((c) => {
                      const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
                      return (
                        <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-muted">
                          <td className="h-11 px-4">
                            <Link to={`/courses/${c.id}`} className="flex items-center gap-2 font-medium hover:underline">
                              <TileIcon icon="book-open" color="violet" size={18} />
                              {c.title}
                            </Link>
                          </td>
                          <td className="px-4">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-border">
                                <div className="h-full bg-success-solid" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="data text-muted-foreground">{c.completed} of {c.total}</span>
                            </div>
                          </td>
                          <td className="data px-4 text-right">{c.open}</td>
                          <td className={`data px-4 text-right ${c.overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                            {c.overdue ? <Link to={`/records?status=overdue&course_id=${c.id}`} className="hover:underline">{c.overdue}</Link> : 0}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
            {data.courses.length > 0 && data.learners === 0 ? (
              <Empty title="Nobody to train yet" hint="Add people on the People page and put them in groups; courses are assigned by group." />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, to, tone = "" }: { label: string; value: number; to: string; tone?: string }) {
  return (
    <Link to={to} className="card block p-4 hover:bg-muted">
      <div className="text-[0.8125rem] font-medium text-muted-foreground">{label}</div>
      <div className={`stat mt-2 ${tone}`}>{value}</div>
    </Link>
  );
}
