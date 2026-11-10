// Making a presenter video for a lesson: the script is read aloud, then a
// model animates the presenter's photo to that voice track.
//
//   none/failed/ready ──start──▶ voicing ──(voice stored, job started)──▶ rendering ──▶ ready
//                                     └──────────────── any refusal ──────────────────▶ failed
//
// A render takes a minute or more, so it is advanced in steps: by the platform
// queue (a signed delivery to /api/video/step every 20 seconds) on a deployed
// app, and by the editor's status check everywhere, local dev included.
// Stored videos are never deleted here: a published version may still play one.

import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import { get, run } from "./db.js";
import { getVideoJob, speak, startPresenterVideo, videoDownload, type AiEnv } from "./ai.js";
import { readCourse, touchCourse, type LessonRow } from "./course.js";
import { putUpload, putUploadFromUrl } from "./uploads.js";
import { InputError, addDays, linkToken, sqlTime } from "./util.js";

export type VideoEnv = AiEnv & QueueEnv;

/** About three minutes of speech. Longer lessons read better split in two. */
export const SCRIPT_MAX = 2800;
/** A render still unfinished after this long is given up on. */
const RENDER_TIMEOUT_MINUTES = 30;
const STEP_SECONDS = 20;

interface PresenterRow {
  id: string;
  name: string;
  photo_key: string | null;
  voice_model: string;
  voice: string;
  consent_at: string | null;
}

interface SettingsRow {
  voice_model: string;
  voice: string;
  avatar_model: string;
}

/** A link a model provider can fetch a stored file from, for a short while. */
export async function mediaLink(origin: string, key: string, minutes = 120): Promise<string> {
  const token = linkToken();
  await run("INSERT INTO media_links (token, key, expires_at) VALUES (?, ?, ?)", [token, key, sqlTime(new Date(Date.now() + minutes * 60_000))]);
  await run("DELETE FROM media_links WHERE expires_at < datetime('now')");
  return `${origin}/api/public/media/${token}`;
}

export async function mediaKeyForLink(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = await get<{ key: string }>("SELECT key FROM media_links WHERE token = ? AND expires_at > datetime('now')", [token]);
  return row?.key ?? null;
}

async function fail(lessonId: string, message: string): Promise<void> {
  await run("UPDATE lessons SET video_status = 'failed', video_error = ?, updated_at = datetime('now') WHERE id = ?", [message, lessonId]);
}

async function readLesson(id: string): Promise<LessonRow> {
  const l = await get<LessonRow>("SELECT * FROM lessons WHERE id = ?", [id]);
  if (!l) throw new InputError("Lesson not found", 404);
  return l;
}

/** Book the next step on the platform queue. False off-platform, where the editor's check drives it. */
async function bookStep(env: VideoEnv, origin: string, lessonId: string): Promise<boolean> {
  if (!env.CLAWNIFY_TOKEN) return false;
  const at = new Date(Date.now() + STEP_SECONDS * 1000);
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/video/step`,
      payload: { lesson_id: lessonId },
      runAt: at,
      idempotencyKey: `video-${new URL(origin).host}-${lessonId}-${at.toISOString()}`,
      maxAttempts: 3,
    });
  } catch {
    return false;
  }
  await run("UPDATE lessons SET video_step_booked_at = datetime('now') WHERE id = ?", [lessonId]);
  return true;
}

/** Check the consent and inputs, then voice the script and start the render. */
export async function startAvatarVideo(env: VideoEnv, origin: string, lessonId: string, presenterId: string | null): Promise<LessonRow> {
  const lesson = await readLesson(lessonId);
  if (lesson.kind !== "video") throw new InputError("Only a video lesson has a presenter video.", 400);
  if (lesson.video_status === "voicing" || lesson.video_status === "rendering") throw new InputError("A video for this lesson is already being made.", 409, "busy");
  const script = lesson.body.trim();
  if (!script) throw new InputError("Write the script first: the presenter reads the lesson's script.", 400);
  if (script.length > SCRIPT_MAX) throw new InputError(`The script is ${script.length} characters. Keep it under ${SCRIPT_MAX} (about three minutes), or split the lesson.`, 400);

  const pid = presenterId ?? lesson.presenter_id;
  if (!pid) throw new InputError("Choose a presenter first.", 400);
  const presenter = await get<PresenterRow>("SELECT * FROM presenters WHERE id = ?", [pid]);
  if (!presenter) throw new InputError("Presenter not found", 404);
  if (!presenter.photo_key) throw new InputError(`Add a photo of ${presenter.name} first.`, 400);
  if (!presenter.consent_at) throw new InputError(`Record ${presenter.name}'s consent to an AI presenter made from their photo first.`, 403, "no_consent");

  const settings = (await get<SettingsRow>("SELECT voice_model, voice, avatar_model FROM settings WHERE id = 1"))!;
  await readCourse(lesson.course_id);
  await run(
    `UPDATE lessons SET presenter_id = ?, video_status = 'voicing', video_source = 'avatar', video_script = ?, video_error = '',
       video_job_id = NULL, video_cost = NULL, updated_at = datetime('now') WHERE id = ?`,
    [pid, script, lessonId],
  );
  await touchCourse(lesson.course_id);

  try {
    const audio = await speak(env, {
      model: presenter.voice_model || settings.voice_model,
      voice: presenter.voice || settings.voice,
      text: script,
    });
    const audioKey = `lessons/${lessonId}/voice-${Date.now()}.mp3`;
    await putUpload(audioKey, audio, "audio/mpeg");
    const job = await startPresenterVideo(env, {
      model: settings.avatar_model,
      photoUrl: await mediaLink(origin, presenter.photo_key),
      audioUrl: await mediaLink(origin, audioKey),
    });
    await run("UPDATE lessons SET video_status = 'rendering', video_job_id = ?, updated_at = datetime('now') WHERE id = ?", [job.id, lessonId]);
    await bookStep(env, origin, lessonId);
  } catch (err) {
    await fail(lessonId, err instanceof InputError ? err.message : "The presenter video could not be started.");
    if (!(err instanceof InputError)) console.error(err);
  }
  return readLesson(lessonId);
}

/** One look at a render in progress. Safe to call any number of times, from anywhere. */
export async function advanceVideo(env: VideoEnv, origin: string, lessonId: string, opts: { book: boolean }): Promise<LessonRow> {
  const lesson = await readLesson(lessonId);
  if (lesson.video_status !== "rendering" || !lesson.video_job_id) return lesson;

  let job;
  try {
    job = await getVideoJob(env, lesson.video_job_id);
  } catch (err) {
    // A failed check is not a failed render: try again on the next step.
    if (opts.book) await bookStep(env, origin, lessonId);
    if (!(err instanceof InputError)) console.error(err);
    return lesson;
  }

  if (job.status === "completed") {
    const where = videoDownload(env, job);
    const key = `lessons/${lessonId}/video-${Date.now()}.mp4`;
    try {
      await putUploadFromUrl(where!.url, key, where!.headers);
    } catch (err) {
      console.error(err);
      await fail(lessonId, "The video was made but could not be saved. Make it again.");
      return readLesson(lessonId);
    }
    // Only the render this lesson is still waiting for may land: a second check
    // that raced this one finds the status already changed and writes nothing.
    await run(
      `UPDATE lessons SET video_status = 'ready', video_key = ?, video_cost = ?, video_error = '', updated_at = datetime('now')
        WHERE id = ? AND video_status = 'rendering' AND video_job_id = ?`,
      [key, job.usage?.cost ?? null, lessonId, lesson.video_job_id],
    );
    await touchCourse(lesson.course_id);
    return readLesson(lessonId);
  }

  if (job.status === "failed" || job.status === "cancelled" || job.status === "expired") {
    await fail(lessonId, job.error ? `The video could not be made: ${job.error}` : "The video could not be made. Try again.");
    return readLesson(lessonId);
  }

  const started = new Date(`${lesson.updated_at.replace(" ", "T")}Z`);
  if (Date.now() - started.getTime() > RENDER_TIMEOUT_MINUTES * 60_000) {
    await fail(lessonId, `The video was still not ready after ${RENDER_TIMEOUT_MINUTES} minutes. Try again.`);
    return readLesson(lessonId);
  }
  if (opts.book) await bookStep(env, origin, lessonId);
  return lesson;
}

/** Renders whose booked step is long overdue (a lost delivery) get booked again. */
export async function rebookStalled(env: VideoEnv, origin: string): Promise<void> {
  const stale = sqlTime(addDays(new Date(), 0 - 2 / 1440));
  const rows = await get<{ id: string }>(
    "SELECT id FROM lessons WHERE video_status = 'rendering' AND (video_step_booked_at IS NULL OR video_step_booked_at < ?) LIMIT 1",
    [stale],
  );
  if (rows) await bookStep(env, origin, rows.id);
}
