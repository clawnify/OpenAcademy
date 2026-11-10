import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Upload, Users } from "lucide-react";
import { TileIcon, useHostChanges } from "@clawnify/app/client";
import { api, type Group, type Learner } from "../api";
import { Badge, Button, Dialog } from "../components/ui";
import { Field, Notice, Pager, Toolbar } from "../components/layout";
import { plural } from "../components/format";
import { TableSkeleton } from "./courses";

export function PeoplePage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [search, setSearch] = useState("");
  const [inactive, setInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ learners: Learner[]; total: number; limit: number } | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Learner | null>(null);
  const [newGroup, setNewGroup] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, l] = await Promise.all([api.groups(), api.learners({ page, search, group_id: groupId || undefined, active: !inactive })]);
      setGroups(g.groups);
      setData(l);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, search, groupId, inactive]);
  useEffect(() => { const t = window.setTimeout(() => void load(), search ? 250 : 0); return () => window.clearTimeout(t); }, [load, search]);
  useHostChanges(() => void load());

  return (
    <>
      <Toolbar
        icon={<TileIcon icon="users" color="sky" size={20} />}
        title="People"
        actions={
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={15} /> Import</Button>
            <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} /> Add person</Button>
          </>
        }
      />
      <div className="grid md:grid-cols-[240px_1fr]">
        <aside className="border-b border-border p-3 md:min-h-[calc(100vh-3.5rem)] md:border-b-0 md:border-r" aria-label="Groups">
          <p className="px-2 pb-1 text-[0.8125rem] font-medium text-muted-foreground">Groups</p>
          <GroupRow label="Everyone" active={!groupId} onClick={() => { setGroupId(""); setPage(1); }} />
          {groups.map((g) => (
            <GroupRow key={g.id} label={g.name} count={g.members} active={groupId === g.id} onClick={() => { setGroupId(g.id); setPage(1); }} />
          ))}
          <Button variant="ghost" className="mt-1 w-full justify-start" onClick={() => setNewGroup(true)}><Plus size={14} /> Add group</Button>
          <p className="mt-3 px-2 text-xs text-muted-foreground">A course is assigned to groups: by role, department or site.</p>
        </aside>
        <section className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <input className="input max-w-xs" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name, email or employee ID" aria-label="Search people" />
            <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={inactive} onChange={(e) => { setInactive(e.target.checked); setPage(1); }} /> Show deactivated
            </label>
          </div>
          {error ? <div className="p-4"><Notice tone="danger">{error}</Notice></div> : null}
          {!data ? (
            <TableSkeleton />
          ) : data.learners.length === 0 ? (
            <div className="mx-auto max-w-md px-6 py-16 text-center">
              <Users size={36} strokeWidth={1.25} className="mx-auto text-faint" />
              <h2 className="mt-3 text-[1.0625rem] font-semibold">{search || groupId ? "Nobody matches" : "Add the people who take your courses"}</h2>
              {!search && !groupId ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  They don't need an account: each person gets their own link to every course assigned to them. Import an export from your
                  HR system, with a group for each role or department.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="h-8 px-4 font-medium">Person</th>
                    <th className="h-8 px-4 font-medium">Groups</th>
                    <th className="h-8 px-4 text-right font-medium">Open</th>
                    <th className="h-8 px-4 text-right font-medium">Overdue</th>
                    <th className="h-8 px-4 text-right font-medium">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.learners.map((l) => (
                    <tr key={l.id} className="border-b border-border/60 hover:bg-muted">
                      <td className="h-11 px-4">
                        <button type="button" className="text-left" onClick={() => setEditing(l)}>
                          <span className="block font-medium hover:underline">{l.name}{!l.active ? <span className="ml-2"><Badge>Deactivated</Badge></span> : null}</span>
                          <span className="block text-xs text-muted-foreground">{l.email}{l.external_id ? ` · ${l.external_id}` : ""}</span>
                        </button>
                      </td>
                      <td className="px-4 text-muted-foreground">{l.groups.map((g) => g.name).join(", ") || "None"}</td>
                      <td className="data px-4 text-right">{l.open}</td>
                      <td className={`data px-4 text-right ${l.overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>{l.overdue}</td>
                      <td className="data px-4 text-right text-muted-foreground">
                        {l.completed ? <Link className="hover:underline" to={`/records?learner_id=${l.id}`}>{l.completed}</Link> : 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={page} limit={data.limit} total={data.total} onPage={setPage} />
            </div>
          )}
        </section>
      </div>
      <PersonDialog open={adding} onOpenChange={setAdding} groups={groups} onDone={load} />
      <PersonDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} groups={groups} learner={editing ?? undefined} onDone={load} />
      <ImportDialog open={importing} onOpenChange={setImporting} onDone={load} />
      <GroupDialog open={newGroup} onOpenChange={setNewGroup} onDone={load} />
    </>
  );
}

function GroupRow({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "true" : undefined}
      className={`flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm ${active ? "bg-muted font-medium" : "hover:bg-muted"}`}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="data text-xs text-muted-foreground">{count}</span> : null}
    </button>
  );
}

function PersonDialog({ open, onOpenChange, groups, learner, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; groups: Group[]; learner?: Learner; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [externalId, setExternalId] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(learner?.name ?? "");
    setEmail(learner?.email ?? "");
    setExternalId(learner?.external_id ?? "");
    setChosen(new Set(learner?.groups.map((g) => g.id) ?? []));
    setActive(learner?.active ?? true);
    setError("");
  }, [open, learner]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (learner) {
        await api.updateLearner(learner.id, { name: name.trim(), email: email.trim(), external_id: externalId.trim(), active, group_ids: [...chosen] });
      } else {
        await api.addLearner({ name: name.trim(), email: email.trim(), external_id: externalId.trim() || undefined, groups: groups.filter((g) => chosen.has(g.id)).map((g) => g.name) });
      }
      onOpenChange(false);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={learner ? learner.name : "Add a person"} submitLabel={learner ? "Save" : "Add person"} submitting={busy || !name.trim() || !email.includes("@")} onSubmit={submit}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Employee ID (optional)"><input className="input" value={externalId} onChange={(e) => setExternalId(e.target.value)} /></Field>
      {groups.length ? (
        <fieldset>
          <legend className="mb-1 text-[0.8125rem] font-medium text-muted-foreground">Groups</legend>
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.has(g.id)} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} />
                {g.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {learner ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
          <span>Deactivated: left the company or no longer needs training. Their open assignments are withdrawn; their records stay.</span>
        </label>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}

/** One person per line: name, email, employee ID, groups (separated by ;). A header row is skipped. */
export function parsePeople(text: string) {
  const rows: { name: string; email: string; external_id?: string; groups?: string[] }[] = [];
  const problems: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const cells = (line.includes("\t") ? line.split("\t") : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((c) => c.trim().replace(/^"|"$/g, "").replace(/""/g, '"'));
    const [name = "", email = "", external = "", groups = ""] = cells;
    if (i === 0 && /e-?mail/i.test(email)) continue;
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push(`Line ${i + 1}: needs a name and an email`);
      continue;
    }
    rows.push({ name, email, ...(external ? { external_id: external } : {}), ...(groups ? { groups: groups.split(/[;|]/).map((g) => g.trim()).filter(Boolean) } : {}) });
  }
  return { rows, problems };
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setResult(""); setError(""); } }, [open]);
  const parsed = parsePeople(text);

  async function submit() {
    if (result) return onOpenChange(false);
    setBusy(true);
    setError("");
    try {
      let created = 0, updated = 0, assigned = 0;
      for (let i = 0; i < parsed.rows.length; i += 500) {
        const r = await api.importLearners(parsed.rows.slice(i, i + 500));
        created += r.created; updated += r.updated; assigned += r.assigned;
      }
      setResult(`${plural(created, "person", "people")} added, ${updated} updated, ${plural(assigned, "course assignment")} made.`);
      setText("");
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import people"
      description="One per line: name, email, employee ID, groups separated by ;. Paste from a spreadsheet or a CSV. People are matched by email, so importing again updates them."
      submitLabel={result ? "Done" : parsed.rows.length ? `Import ${plural(parsed.rows.length, "person", "people")}` : "Import"}
      submitting={busy || (!result && !parsed.rows.length)}
      onSubmit={submit}
    >
      {result ? (
        <Notice tone="success">{result}</Notice>
      ) : (
        <>
          <textarea className="textarea min-h-40 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Name,Email,Employee ID,Groups\nAna Ruiz,ana@example.com,E1042,Warehouse;Shift leads"} aria-label="People to import" />
          {parsed.problems.length ? <Notice tone="warning">{parsed.problems.slice(0, 5).join(". ")}{parsed.problems.length > 5 ? `, and ${parsed.problems.length - 5} more` : ""}.</Notice> : null}
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}

function GroupDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setName(""); setError(""); } }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a group"
      description="A role, department or site that courses are assigned to."
      submitLabel="Add group"
      submitting={!name.trim()}
      onSubmit={async () => {
        try {
          await api.addGroup(name.trim());
          onOpenChange(false);
          await onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Warehouse" autoFocus /></Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
