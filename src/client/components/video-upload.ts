// Sending a lesson video. On Clawnify it goes straight to the media service,
// resumably (tus), the way OpenVideo uploads footage: the bytes never pass
// through this app, so a long recording uploads like a short one. Outside
// Clawnify there is no media service, and a small file is sent to the app.

import * as tus from "tus-js-client";
import { api, ApiError, type Lesson } from "../api";

/** The length of a video file, read by the browser, or undefined when it can't tell. */
function probeDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (d?: number) => { URL.revokeObjectURL(url); resolve(d && Number.isFinite(d) ? d : undefined); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done();
    window.setTimeout(() => done(), 8000);
    v.src = url;
  });
}

export async function sendLessonVideo(lessonId: string, file: File, onProgress: (sent: number, total: number) => void): Promise<Lesson> {
  const duration = await probeDuration(file);
  let opened: { uid: string; upload_url: string };
  try {
    opened = await api.openVideoUpload(lessonId, { name: file.name.slice(0, 200), size: file.size, ...(duration ? { duration } : {}) });
  } catch (e) {
    if (e instanceof ApiError && e.code === "media_unavailable") return api.uploadVideo(lessonId, file);
    throw e;
  }
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      uploadUrl: opened.upload_url,
      // The media service takes chunks of whole 256 KiB blocks, at least 5 MB.
      chunkSize: 50 * 1024 * 1024,
      retryDelays: [0, 2000, 5000, 10000, 20000, 30000],
      onProgress: (sent) => onProgress(sent, file.size),
      onSuccess: () => resolve(),
      // The raw error names the upload link, which is a capability: never show it.
      onError: () => reject(new Error("The connection dropped during the upload. Try again.")),
    });
    upload.start();
  });
  return api.attachVideo(lessonId, opened.uid);
}
