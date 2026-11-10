// Thin typed wrapper over the app's own API. Every list is paginated.

export type LessonKind = "text" | "video" | "quiz";
export type VideoStatus = "none" | "voicing" | "rendering" | "ready" | "failed";
export type EnrollmentStatus = "assigned" | "in_progress" | "completed" | "cancelled";

export interface Counts { modules: number; lessons: number; open: number; overdue: number; completed: number; groups: number }

export interface Course {
  id: string;
  title: string;
  description: string;
  audience: string;
  language: string;
  pass_mark: number;
  due_days: number;
  renew_months: number | null;
  attestation: string;
  archived: boolean;
  published_version: number | null;
  unpublished_changes: boolean;
  created_at: string;
  updated_at: string;
  counts: Counts;
}

export interface Question { id: string; prompt: string; options: string[]; correct: number[]; explanation: string }

export interface Lesson {
  id: string;
  course_id: string;
  module_id: string;
  title: string;
  kind: LessonKind;
  body: string;
  position: number;
  presenter_id: string | null;
  video: { status: VideoStatus; source: "upload" | "avatar" | null; error: string; cost: number | null; script_changed: boolean; url: string | null; stream: boolean };
  questions: Question[];
}

export interface Module { id: string; course_id: string; title: string; position: number; lessons: Lesson[] }

export interface CourseDetail extends Course {
  modules: Module[];
  groups: { id: string; name: string }[];
  versions: { version: number; notes: string; published_by: string | null; published_at: string }[];
  sources: number;
  problems: string[];
}

export interface Source { id: string; course_id: string; title: string; kind: "text" | "url"; url: string; chars: number; excerpt: string; created_at: string }

export interface Presenter {
  id: string;
  name: string;
  has_photo: boolean;
  photo_url: string | null;
  voice_model: string;
  voice: string;
  consent: { by: string; at: string; note: string } | null;
  lessons: number;
  created_at: string;
}

export interface Group { id: string; name: string; description: string; members: number; courses: number; created_at: string }

export interface Learner {
  id: string;
  name: string;
  email: string;
  external_id: string;
  active: boolean;
  groups: { id: string; name: string }[];
  open: number;
  overdue: number;
  completed: number;
  created_at: string;
}

export interface Enrollment {
  id: string;
  course_id: string;
  course_title: string;
  learner_id: string;
  learner_name: string;
  learner_email: string;
  learner_external_id: string;
  course_version: number;
  status: EnrollmentStatus;
  overdue: boolean;
  assigned_at: string;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  score: number | null;
  attested_at: string | null;
  attestation: string | null;
  renew_at: string | null;
  renewed: boolean;
  link: string;
}

export interface EnrollmentDetail extends Enrollment {
  activity: { kind: string; detail: string; at: string }[];
  attempts: { id: string; lesson_id: string; correct: number; total: number; created_at: string }[];
}

export interface OverviewCourse { id: string; title: string; open: number; overdue: number; completed: number; total: number }

export interface Overview {
  published_courses: number;
  learners: number;
  open: number;
  overdue: number;
  completed_30d: number;
  due_7d: number;
  courses: OverviewCourse[];
}


export interface Settings {
  organization_name: string;
  text_model: string;
  voice_model: string;
  voice: string;
  avatar_model: string;
  certificate_signer: string;
  storage: boolean;
  ai: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(text.slice(0, 200) || res.statusText, res.status);
  }
  if (!res.ok) {
    const body = data as { error?: string; code?: string } | null;
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.code);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

type Paged<K extends string, T> = { [P in K]: T[] } & { total: number; page: number; limit: number };
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

async function upload<T>(path: string, file: File): Promise<T> {
  const res = await fetch(path, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  overview: () => request<Overview>("/api/overview"),

  courses: (p: { page?: number; search?: string; archived?: boolean } = {}) =>
    request<Paged<"courses", Course>>(`/api/courses${qs({ page: p.page, search: p.search, archived: p.archived ? "true" : undefined, limit: 50 })}`),
  course: (id: string) => request<CourseDetail>(`/api/courses/${id}`),
  createCourse: (input: Partial<Course> & { id: string; title: string }) => request<Course>("/api/courses", json("POST", input)),
  updateCourse: (id: string, input: Partial<Course>) => request<Course>(`/api/courses/${id}`, json("PATCH", input)),
  deleteCourse: (id: string) => request(`/api/courses/${id}`, { method: "DELETE" }),
  publish: (id: string, input: { notes?: string; retrain?: boolean }) => request<{ version: number; assigned: number }>(`/api/courses/${id}/publish`, json("POST", input)),
  setGroups: (id: string, group_ids: string[]) => request<{ assigned: number }>(`/api/courses/${id}/groups`, json("PUT", { group_ids })),
  order: (id: string, modules: { id: string; lessons: string[] }[]) => request(`/api/courses/${id}/order`, json("PUT", { modules })),
  assign: (id: string, learner_ids: string[], due_at?: string) => request<{ assigned: number }>(`/api/courses/${id}/enrollments`, json("POST", { learner_ids, due_at })),

  sources: (courseId: string) => request<Paged<"sources", Source>>(`/api/courses/${courseId}/sources?limit=100`),
  addSource: (courseId: string, input: { title?: string; body?: string; url?: string }) => request<Source>(`/api/courses/${courseId}/sources`, json("POST", input)),
  deleteSource: (id: string) => request(`/api/sources/${id}`, { method: "DELETE" }),
  draft: (courseId: string, input: { instructions?: string; video_lessons?: boolean; replace?: boolean }) =>
    request<{ model: string; modules: number; lessons: number; truncated: string | null }>(`/api/courses/${courseId}/draft`, json("POST", input)),

  addModule: (courseId: string, title: string) => request<Module>(`/api/courses/${courseId}/modules`, json("POST", { title })),
  renameModule: (id: string, title: string) => request(`/api/modules/${id}`, json("PATCH", { title })),
  deleteModule: (id: string) => request(`/api/modules/${id}`, { method: "DELETE" }),

  addLesson: (moduleId: string, input: { title: string; kind: LessonKind; body?: string }) => request<Lesson>(`/api/modules/${moduleId}/lessons`, json("POST", input)),
  updateLesson: (id: string, input: Partial<Pick<Lesson, "title" | "body" | "kind" | "presenter_id">>) => request<Lesson>(`/api/lessons/${id}`, json("PATCH", input)),
  deleteLesson: (id: string) => request(`/api/lessons/${id}`, { method: "DELETE" }),
  videoState: (id: string) => request<Lesson>(`/api/lessons/${id}/video`),
  makeVideo: (id: string, presenter_id: string) => request<Lesson>(`/api/lessons/${id}/video/avatar`, json("POST", { presenter_id })),
  removeVideo: (id: string) => request<Lesson>(`/api/lessons/${id}/video`, { method: "DELETE" }),
  uploadVideo: (id: string, file: File) => upload<Lesson>(`/api/lessons/${id}/video/file`, file),
  openVideoUpload: (id: string, input: { name: string; size: number; duration?: number }) =>
    request<{ uid: string; upload_url: string }>(`/api/lessons/${id}/video/uploads`, json("POST", input)),
  attachVideo: (id: string, uid: string) => request<Lesson>(`/api/lessons/${id}/video/media`, json("POST", { uid })),
  videoPlayback: (id: string) => request<{ hls: string; thumbnail: string }>(`/api/lessons/${id}/video/playback`),

  addQuestion: (lessonId: string, q: Omit<Question, "id">) => request<Question>(`/api/lessons/${lessonId}/questions`, json("POST", q)),
  updateQuestion: (id: string, q: Partial<Omit<Question, "id">>) => request<Question>(`/api/questions/${id}`, json("PATCH", q)),
  deleteQuestion: (id: string) => request(`/api/questions/${id}`, { method: "DELETE" }),

  presenters: () => request<Paged<"presenters", Presenter>>("/api/presenters?limit=100"),
  addPresenter: (input: { name: string; voice_model?: string; voice?: string }) => request<Presenter>("/api/presenters", json("POST", input)),
  updatePresenter: (id: string, input: Partial<{ name: string; voice_model: string; voice: string; consent: boolean; consent_note: string }>) =>
    request<Presenter>(`/api/presenters/${id}`, json("PATCH", input)),
  deletePresenter: (id: string) => request(`/api/presenters/${id}`, { method: "DELETE" }),
  uploadPhoto: (id: string, file: File) => upload<Presenter>(`/api/presenters/${id}/photo`, file),

  groups: (search?: string) => request<Paged<"groups", Group>>(`/api/groups${qs({ search, limit: 100 })}`),
  addGroup: (name: string, description?: string) => request<Group>("/api/groups", json("POST", { name, description })),
  updateGroup: (id: string, input: { name?: string; description?: string }) => request<Group>(`/api/groups/${id}`, json("PATCH", input)),
  deleteGroup: (id: string) => request(`/api/groups/${id}`, { method: "DELETE" }),

  learners: (p: { page?: number; search?: string; group_id?: string; active?: boolean } = {}) =>
    request<Paged<"learners", Learner>>(`/api/learners${qs({ page: p.page, search: p.search, group_id: p.group_id, active: p.active === false ? "false" : undefined, limit: 50 })}`),
  addLearner: (input: { name: string; email: string; external_id?: string; groups?: string[] }) => request<Learner>("/api/learners", json("POST", input)),
  importLearners: (people: { name: string; email: string; external_id?: string; groups?: string[] }[]) =>
    request<{ created: number; updated: number; assigned: number }>("/api/learners/import", json("POST", { people })),
  updateLearner: (id: string, input: Partial<{ name: string; email: string; external_id: string; active: boolean; group_ids: string[] }>) =>
    request<Learner>(`/api/learners/${id}`, json("PATCH", input)),

  enrollments: (p: { page?: number; search?: string; course_id?: string; learner_id?: string; group_id?: string; status?: string } = {}) =>
    request<Paged<"enrollments", Enrollment>>(`/api/enrollments${qs({ ...p, limit: 50 })}`),
  enrollment: (id: string) => request<EnrollmentDetail>(`/api/enrollments/${id}`),
  cancelEnrollment: (id: string, reason?: string) => request(`/api/enrollments/${id}/cancel`, json("POST", { reason })),

  settings: () => request<Settings>("/api/settings"),
  saveSettings: (input: Partial<Settings>) => request<Settings>("/api/settings", json("PUT", input)),
  models: (kind: "text" | "speech" | "video") => request<{ models: { id: string; name: string }[] }>(`/api/models?kind=${kind}`),
};
