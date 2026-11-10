// Lesson videos on the managed media service, the same path OpenVideo uses for
// long footage. The browser uploads straight to it, resumably, so a video never
// passes through this app (requests here are capped at 100 MB), and learners get
// adaptive playback from signed, short-lived links.
//
// Deployed apps have it (CLAWNIFY_TOKEN); local dev does not, and falls back to
// the app's own storage for small files.

import { refusalDetail } from "./refusal.js";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

export const MEDIA_UID = /^[0-9a-f]{32}$/;

export interface MediaConfig {
  servicesUrl?: string;
  token?: string;
}

export interface MediaFailure {
  error: string;
  detail: string;
}

export interface MediaState {
  id: string;
  state: string;
  progress: number | null;
  ready: boolean;
  duration: number | null;
  error: string | null;
}

export interface MediaPlayback {
  /** Adaptive playback, signed and short-lived. */
  hls: string;
  /** A frame at any second: put the seconds in place of `{time}`. */
  thumbnail: string;
}

export const mediaConfig = (env: { SERVICES_URL?: string; CLAWNIFY_TOKEN?: string }): MediaConfig => ({
  servicesUrl: env.SERVICES_URL,
  token: env.CLAWNIFY_TOKEN,
});

async function call<T>(cfg: MediaConfig, path: string, init: RequestInit = {}): Promise<{ data: T } | { failure: MediaFailure }> {
  if (!cfg.token) {
    return { failure: { error: "media_unavailable", detail: "large videos need the managed media service, which deployed apps have and local dev does not" } };
  }
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/media${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* a proxy or policy message, kept as text below */
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string };
    return { failure: { error: err.error ?? "media_failed", detail: refusalDetail(body, raw.trim().slice(0, 300) || `media service returned ${res.status}`) } };
  }
  return { data: body as T };
}

/**
 * Open an upload the browser sends the file to itself (tus). Until it
 * completes it reserves `maxDurationSeconds` of the org's video storage, so
 * pass the real length when the browser could read it.
 */
export async function openMediaUpload(cfg: MediaConfig, size: number, name: string, maxDurationSeconds?: number) {
  const res = await call<{ id: string; upload_url: string }>(cfg, "/uploads", {
    method: "POST",
    body: JSON.stringify({ size, name, ...(maxDurationSeconds ? { max_duration_seconds: maxDurationSeconds } : {}) }),
  });
  return "failure" in res ? res : { id: res.data.id, uploadUrl: res.data.upload_url };
}

export async function mediaState(cfg: MediaConfig, uid: string) {
  const res = await call<MediaState>(cfg, `/${uid}`);
  return "failure" in res ? res : { media: res.data };
}

export async function mediaPlayback(cfg: MediaConfig, uid: string) {
  const res = await call<MediaPlayback>(cfg, `/${uid}/playback`, { method: "POST" });
  return "failure" in res ? res : { playback: res.data };
}
