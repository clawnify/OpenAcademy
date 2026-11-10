import type { Enrollment } from "../api";
import { Badge, type Tone } from "./ui";

/** A stored SQLite time ("2026-11-10 09:30:00", UTC) as a Date. */
export const toDate = (sql: string) => new Date(`${sql.replace(" ", "T")}Z`);

export function day(sql: string | null | undefined): string {
  if (!sql) return "";
  return toDate(sql).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function when(sql: string | null | undefined): string {
  if (!sql) return "";
  return toDate(sql).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS: Record<Enrollment["status"], [string, Tone]> = {
  assigned: ["Not started", "neutral"],
  in_progress: ["In progress", "info"],
  completed: ["Completed", "success"],
  cancelled: ["Withdrawn", "neutral"],
};

export function EnrollmentBadge({ e }: { e: Pick<Enrollment, "status" | "overdue"> }) {
  if (e.overdue) return <Badge tone="danger">Overdue</Badge>;
  const [label, tone] = STATUS[e.status];
  return <Badge tone={tone}>{label}</Badge>;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
