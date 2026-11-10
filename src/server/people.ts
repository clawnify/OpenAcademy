// Importing people in bulk (an HR export: hundreds of rows at once).
//
// The database caps one request at 1,000 queries and one statement at 100
// bound values, so this never runs a query per person: rows go in as
// multi-row statements, chunked under the bound-value cap. 500 people with two
// groups each take about 60 statements.

import { get, query, run } from "./db.js";
import { uid } from "./util.js";

export interface PersonInput {
  name: string;
  email: string;
  external_id?: string;
  groups?: string[];
}

/** Split `items` into chunks whose bound values stay under the statement cap, with room to spare. */
function chunks<T>(items: T[], valuesPerItem: number): T[][] {
  const size = Math.max(1, Math.floor(90 / valuesPerItem));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const key = (s: string) => s.trim().toLowerCase();

/** Create every named group that does not exist yet (names match case-insensitively). */
async function ensureGroups(names: string[]): Promise<void> {
  const wanted = new Map<string, string>();
  for (const n of names) if (n.trim() && !wanted.has(key(n))) wanted.set(key(n), n.trim());
  if (!wanted.size) return;
  for (const part of chunks([...wanted.values()], 1)) {
    const found = await query<{ name: string }>(
      `SELECT name FROM groups WHERE name COLLATE NOCASE IN (${part.map(() => "?").join(",")})`,
      part,
    );
    for (const f of found) wanted.delete(key(f.name));
  }
  for (const part of chunks([...wanted.values()], 2)) {
    await run(`INSERT OR IGNORE INTO groups (id, name) VALUES ${part.map(() => "(?, ?)").join(",")}`, part.flatMap((n) => [uid(), n]));
  }
}

/**
 * Create or update people by email, and put them in their groups.
 * `replaceGroups`: a person who is sent groups ends up in exactly those.
 */
export async function importPeople(input: PersonInput[], replaceGroups: boolean): Promise<{ created: number; updated: number }> {
  // One row per email; a later row for the same person wins.
  const byEmail = new Map<string, PersonInput>();
  for (const p of input) byEmail.set(key(p.email), { ...p, email: p.email.trim(), name: p.name.trim() });
  const people = [...byEmail.values()];
  const emails = people.map((p) => p.email);

  let existing = 0;
  for (const part of chunks(emails, 1)) {
    existing += (await get<{ n: number }>(`SELECT COUNT(*) n FROM learners WHERE email IN (${part.map(() => "?").join(",")})`, part))?.n ?? 0;
  }

  for (const part of chunks(people, 4)) {
    await run(
      `INSERT INTO learners (id, name, email, external_id) VALUES ${part.map(() => "(?, ?, ?, ?)").join(",")}
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, active = 1,
         external_id = CASE WHEN excluded.external_id != '' THEN excluded.external_id ELSE learners.external_id END`,
      part.flatMap((p) => [uid(), p.name, p.email, p.external_id?.trim() ?? ""]),
    );
  }

  const withGroups = people.filter((p) => p.groups);
  if (replaceGroups && withGroups.length) {
    for (const part of chunks(withGroups, 1)) {
      await run(
        `DELETE FROM learner_groups WHERE learner_id IN (SELECT id FROM learners WHERE email IN (${part.map(() => "?").join(",")}))`,
        part.map((p) => p.email),
      );
    }
  }

  const pairs = withGroups.flatMap((p) => (p.groups ?? []).filter((g) => g.trim()).map((g) => [p.email, g.trim()] as const));
  await ensureGroups(pairs.map(([, g]) => g));
  for (const part of chunks(pairs, 2)) {
    await run(
      `WITH pairs(email, name) AS (VALUES ${part.map(() => "(?, ?)").join(",")})
       INSERT OR IGNORE INTO learner_groups (learner_id, group_id)
       SELECT l.id, g.id FROM pairs p JOIN learners l ON l.email = p.email JOIN groups g ON g.name = p.name COLLATE NOCASE`,
      part.flat(),
    );
  }

  return { created: people.length - existing, updated: existing };
}
