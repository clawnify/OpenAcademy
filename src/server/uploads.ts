// Files the app keeps: presenter photos, voice tracks and lesson videos.
// Adapted from OpenVideo's store: streamed in and out, never held whole in
// memory, and served with byte ranges so a lesson video can be seeked.

let bucket: R2Bucket | undefined;

export function initUploads(b: R2Bucket | undefined) {
  bucket = b;
}

export function hasUploads(): boolean {
  return !!bucket;
}

function store(): R2Bucket {
  if (!bucket) throw new Error("This app has no file storage. Turn on storage for the app to upload files.");
  return bucket;
}

export async function putUpload(key: string, data: ArrayBuffer | Uint8Array | ReadableStream, contentType: string): Promise<void> {
  await store().put(key, data, { httpMetadata: { contentType } });
}

/** Stream a file from a URL straight into storage. A streamed put needs its length up front. */
export async function putUploadFromUrl(url: string, key: string, headers: Record<string, string> = {}): Promise<{ size: number; contentType: string }> {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const type = res.headers.get("content-type") || "video/mp4";
  const size = Number(res.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) {
    const bytes = await res.arrayBuffer(); // no length given: a generated clip is small enough to buffer
    await putUpload(key, bytes, type);
    return { size: bytes.byteLength, contentType: type };
  }
  const fixed = new FixedLengthStream(size);
  const pipe = res.body.pipeTo(fixed.writable);
  await putUpload(key, fixed.readable, type);
  await pipe;
  return { size, contentType: type };
}

export async function deleteUpload(key: string | string[]): Promise<void> {
  if (bucket) await bucket.delete(key);
}

/** A stored object as an HTTP response, honouring `Range: bytes=a-b`. */
export async function serveUpload(key: string, range: string | undefined, headers: Record<string, string> = {}): Promise<Response | null> {
  const b = store();
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : undefined;
    let obj: R2ObjectBody | null = null;
    try {
      obj = await b.get(key, { range: { offset: start, ...(end !== undefined ? { length: end - start + 1 } : {}) } });
    } catch {
      obj = null;
    }
    if (obj) {
      const last = end !== undefined ? Math.min(end, obj.size - 1) : obj.size - 1;
      return new Response(obj.body, {
        status: 206,
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
          "Content-Range": `bytes ${start}-${last}/${obj.size}`,
          "Content-Length": String(last - start + 1),
          "Accept-Ranges": "bytes",
          ...headers,
        },
      });
    }
  }
  const obj = await b.get(key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Accept-Ranges": "bytes",
      ...headers,
    },
  });
}
