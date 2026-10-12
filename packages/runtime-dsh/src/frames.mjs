import { MAX_FRAME_BYTES } from "./protocol.mjs";

/** Bounded UTF-8 frames: readline would buffer an unbounded unterminated line. */
export async function* frames(stream) {
  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, bytes]);
    let newline = pending.indexOf(10);
    while (newline !== -1) {
      if (newline > MAX_FRAME_BYTES) throw new Error("DSH frame exceeds limit");
      yield decoder.decode(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(10);
    }
    if (pending.length > MAX_FRAME_BYTES) throw new Error("DSH frame exceeds limit");
  }
  if (pending.length) throw new Error("Incomplete DSH frame");
}
