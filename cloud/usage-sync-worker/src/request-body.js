// Bound the stream before decoding, including chunked requests without Content-Length.
export async function readBody(request, maxBytes = 1024 * 1024) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("body_too_large");
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid_json"); }
}
