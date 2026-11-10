// Every model call the app makes, through one OpenRouter key.
//
// The base URL comes from the platform (OPENROUTER_BASE_URL): a workspace that
// keeps its AI processing in the EU gets OpenRouter's EU address, and its key
// works nowhere else. Never hard-code openrouter.ai.

import { InputError } from "./util.js";

export interface AiEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
}

const base = (env: AiEnv) => (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");

function key(env: AiEnv): string {
  if (!env.OPENROUTER_API_KEY) throw new InputError("No OpenRouter key is set for this app (OPENROUTER_API_KEY).", 503, "no_key");
  return env.OPENROUTER_API_KEY;
}

/** Turn a provider's refusal into words a person can act on. */
async function refusal(res: Response, what: string): Promise<InputError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    detail = typeof body.error === "string" ? body.error : body.error?.message ?? "";
  } catch {
    detail = res.statusText;
  }
  if (res.status === 402) return new InputError(`Not enough AI credits to ${what}. Add credits to the workspace and try again.`, 409, "insufficient_credits");
  if (res.status === 404 && /region/i.test(detail)) {
    return new InputError(`The model chosen to ${what} is not available in this workspace's data region. Pick another model in Settings.`, 422, "region");
  }
  if (res.status === 404 && /allowed providers|no endpoints/i.test(detail)) {
    return new InputError(`The model chosen to ${what} can't be used with this key. Pick another model in Settings.`, 422, "model_unavailable");
  }
  if (res.status === 401) return new InputError("The OpenRouter key was refused.", 502, "invalid_key");
  return new InputError(`Could not ${what}: ${detail || `the model provider answered ${res.status}`}`, 502, "provider_error");
}

// ── Choosing a text model ─────────────────────────────────────────────

/** In order of preference; the first one this key can use wins. */
const PREFERRED_TEXT_MODELS = ["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash", "openai/gpt-5.6-terra", "anthropic/claude-haiku-5.5"];

export async function listModels(env: AiEnv, modality: "text" | "speech" | "video"): Promise<{ id: string; name: string }[]> {
  const path = modality === "video" ? "/videos/models" : `/models/user${modality === "speech" ? "?output_modalities=speech" : ""}`;
  const res = await fetch(`${base(env)}${path}`, { headers: { Authorization: `Bearer ${key(env)}` } });
  if (!res.ok) throw await refusal(res, "list models");
  const data = ((await res.json()) as { data?: { id: string; name?: string; architecture?: { output_modalities?: string[] } }[] }).data ?? [];
  return data
    .filter((m) => modality !== "text" || !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
    .map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

export async function pickTextModel(env: AiEnv, configured: string): Promise<string> {
  if (configured) return configured;
  const ids = new Set((await listModels(env, "text")).map((m) => m.id));
  return PREFERRED_TEXT_MODELS.find((m) => ids.has(m)) ?? [...ids][0] ?? PREFERRED_TEXT_MODELS[0]!;
}

// ── Drafting a course from source documents ───────────────────────────

export interface DraftQuestion {
  prompt: string;
  options: string[];
  correct: number[];
  explanation: string;
}

export interface DraftLesson {
  title: string;
  kind: "text" | "video" | "quiz";
  body: string;
  questions: DraftQuestion[];
}

export interface DraftCourse {
  modules: { title: string; lessons: DraftLesson[] }[];
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["modules"],
  properties: {
    modules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "lessons"],
        properties: {
          title: { type: "string" },
          lessons: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "kind", "body", "questions"],
              properties: {
                title: { type: "string" },
                kind: { type: "string", enum: ["text", "video", "quiz"] },
                body: { type: "string", description: "Markdown for a text lesson; the presenter's spoken script for a video lesson; empty for a quiz" },
                questions: {
                  type: "array",
                  description: "Only for a quiz lesson; empty otherwise",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["prompt", "options", "correct", "explanation"],
                    properties: {
                      prompt: { type: "string" },
                      options: { type: "array", items: { type: "string" } },
                      correct: { type: "array", items: { type: "integer" }, description: "Indexes into options" },
                      explanation: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** The most source text one draft reads. Past it, the person is told what was left out. */
export const SOURCE_BUDGET = 150_000;

export async function draftCourse(
  env: AiEnv,
  model: string,
  input: {
    title: string;
    audience: string;
    language: string;
    instructions: string;
    sources: { title: string; body: string }[];
    videoLessons: boolean;
  },
): Promise<DraftCourse> {
  let used = 0;
  const parts: string[] = [];
  for (const s of input.sources) {
    const room = SOURCE_BUDGET - used;
    if (room <= 0) break;
    const body = s.body.slice(0, room);
    used += body.length;
    parts.push(`<document title="${s.title.replace(/"/g, "'")}">\n${body}\n</document>`);
  }

  const system = [
    "You turn an organisation's own documents into a training course its employees take.",
    "Teach what the documents say, in the organisation's own terms. Never invent a rule, a number, a role or a step the documents do not contain.",
    "When the documents are silent on something a learner would need, leave it out rather than fill it in.",
    "Structure: 2 to 6 modules. Each module has 1 to 4 teaching lessons and ends with one quiz lesson of 3 to 5 questions about that module.",
    input.videoLessons
      ? "Make the first lesson of each module a video lesson: its body is a script a presenter reads aloud, 90 to 180 words, plain sentences, no headings, no lists, no stage directions. The other teaching lessons are text."
      : "Teaching lessons are text lessons.",
    "A text lesson body is Markdown, 150 to 500 words: short paragraphs, lists for steps, and what the learner must do differently in their own work.",
    "Quiz questions test applying the procedure to a situation, not recalling a sentence. Each has 3 or 4 options, at least one correct, and an explanation that cites the procedure.",
    `Write everything in ${input.language}.`,
  ].join("\n");
  const user = [
    `Course title: ${input.title}`,
    input.audience ? `Who takes it: ${input.audience}` : "",
    input.instructions ? `Instructions from the course author: ${input.instructions}` : "",
    "",
    parts.join("\n\n"),
  ].filter(Boolean).join("\n");

  const res = await fetch(`${base(env)}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "course", strict: true, schema: DRAFT_SCHEMA } },
      max_tokens: 16000,
    }),
  });
  if (!res.ok) throw await refusal(res, "draft the course");
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = body.choices?.[0]?.message?.content ?? "";
  let parsed: DraftCourse;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as DraftCourse;
  } catch {
    throw new InputError("The model's draft could not be read. Try again, or pick another model in Settings.", 502, "bad_draft");
  }
  return cleanDraft(parsed);
}

/** Keep only what the editor can hold: drop empty lessons and impossible answers. */
export function cleanDraft(d: DraftCourse): DraftCourse {
  const modules = (d.modules ?? [])
    .map((m) => ({
      title: String(m.title ?? "").trim().slice(0, 200) || "Module",
      lessons: (m.lessons ?? [])
        .map((l): DraftLesson => {
          const kind = l.kind === "video" || l.kind === "quiz" ? l.kind : "text";
          const questions = kind === "quiz"
            ? (l.questions ?? [])
                .map((q) => {
                  const options = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6);
                  const correct = [...new Set((q.correct ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))];
                  return { prompt: String(q.prompt ?? "").trim(), options, correct, explanation: String(q.explanation ?? "").trim() };
                })
                .filter((q) => q.prompt && q.options.length >= 2 && q.correct.length)
            : [];
          return { title: String(l.title ?? "").trim().slice(0, 200) || "Lesson", kind, body: kind === "quiz" ? "" : String(l.body ?? ""), questions };
        })
        .filter((l) => (l.kind === "quiz" ? l.questions.length > 0 : l.body.trim().length > 0)),
    }))
    .filter((m) => m.lessons.length);
  if (!modules.length) throw new InputError("The draft came back empty. Add more source material, or say more in the instructions.", 422, "empty_draft");
  return { modules };
}

// ── Voice and presenter video ─────────────────────────────────────────

/** Read a script aloud. Returns MP3 bytes. */
export async function speak(env: AiEnv, opts: { model: string; voice: string; text: string }): Promise<ArrayBuffer> {
  const res = await fetch(`${base(env)}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: opts.model, input: opts.text, voice: opts.voice, response_format: "mp3" }),
  });
  if (!res.ok) throw await refusal(res, "record the voice track");
  return res.arrayBuffer();
}

export interface VideoJob {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired" | string;
  error?: string;
  unsigned_urls?: string[];
  urls?: string[];
  usage?: { cost?: number | null };
}

/** Start a talking-presenter video: a photo of the presenter, lip-synced to the voice track. */
export async function startPresenterVideo(env: AiEnv, opts: { model: string; photoUrl: string; audioUrl: string }): Promise<VideoJob> {
  const res = await fetch(`${base(env)}/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      // Both as HTTPS links: providers refuse an inline photo or voice track.
      input_references: [
        { type: "image_url", image_url: { url: opts.photoUrl } },
        { type: "audio_url", audio_url: { url: opts.audioUrl } },
      ],
      resolution: "720p",
      aspect_ratio: "16:9",
    }),
  });
  if (!res.ok) throw await refusal(res, "make the presenter video");
  return (await res.json()) as VideoJob;
}

export async function getVideoJob(env: AiEnv, id: string): Promise<VideoJob> {
  const res = await fetch(`${base(env)}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key(env)}` } });
  if (!res.ok) throw await refusal(res, "check the presenter video");
  return (await res.json()) as VideoJob;
}

/** Where to download a finished video, and the header it needs. */
export function videoDownload(env: AiEnv, job: VideoJob): { url: string; headers: Record<string, string> } | null {
  if (job.urls?.[0]) return { url: job.urls[0], headers: {} };
  if (job.unsigned_urls?.[0]) return { url: job.unsigned_urls[0], headers: { Authorization: `Bearer ${key(env)}` } };
  return { url: `${base(env)}/videos/${encodeURIComponent(job.id)}/content`, headers: { Authorization: `Bearer ${key(env)}` } };
}
