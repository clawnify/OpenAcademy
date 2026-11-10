/** A refusal the caller can fix, with the status it should carry. */
export class InputError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 422 | 502 | 503 = 400, readonly code?: string) {
    super(message);
  }
}

export const uid = () => crypto.randomUUID();

/** An unguessable link token: 24 random bytes, URL-safe. */
export function linkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SQLite's datetime() format, so stored and computed times compare as text. */
export function sqlTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // written by this app; unreadable means empty
  }
}
