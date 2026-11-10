import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { api, type Lesson } from "../api";

/** A lesson's video: a file from the app, or adaptive playback from the media service. */
export function LessonVideo({ lesson }: { lesson: Lesson }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const v = ref.current;
    if (!v || !lesson.video.stream) return;
    let hls: Hls | null = null;
    let cancelled = false;
    setError("");
    api.videoPlayback(lesson.id).then(
      (p) => {
        if (cancelled) return;
        v.poster = p.thumbnail.replace("{time}", "1");
        if (v.canPlayType("application/vnd.apple.mpegurl")) v.src = p.hls;
        else if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(p.hls);
          hls.attachMedia(v);
        }
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [lesson.id, lesson.video.stream, lesson.video.status]);

  if (error) return <div className="flex aspect-video items-center justify-center p-6 text-center text-sm text-background">{error}</div>;
  return (
    <video
      ref={ref}
      key={lesson.video.url ?? lesson.id}
      src={lesson.video.stream ? undefined : lesson.video.url ?? undefined}
      controls
      playsInline
      preload="metadata"
      className="block aspect-video w-full"
    />
  );
}
