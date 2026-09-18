import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const run = promisify(execFile);

/**
 * Selfie validation.
 * - Checks real image bytes (magic numbers), not just extension
 * - Re-encodes to PNG via ffmpeg, which strips EXIF/GPS and neutralises malformed files
 * - Face count check: TODO for Claude Code. Plug in one of:
 *     a) @vladmandic/face-api (runs locally, free)
 *     b) Gemini Flash vision call: "exactly one real human face, front facing?"
 *     c) AWS Rekognition DetectFaces + DetectModerationLabels + RecognizeCelebrities
 *   Return {ok:false, reason:"no_face"|"multiple_faces"|"not_a_photo"|"moderation"} as needed.
 */
const MAGIC = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46],
};

function sniff(buf) {
  for (const [k, sig] of Object.entries(MAGIC)) {
    if (sig.every((b, i) => buf[i] === b)) return k;
  }
  return null;
}

export async function validateSelfie(buf) {
  const type = sniff(buf);
  if (!type) return { ok: false, reason: "not_an_image" };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "selfie-"));
  const inp = path.join(dir, `in.${type}`);
  const out = path.join(dir, "out.jpg");
  try {
    await fs.writeFile(inp, buf);
    // Re-encode small: the image travels inside the queued job, and an
    // oversized payload is rejected by Redis. 1024px JPEG is ample for a face
    // reference and lands around 100-300 kB instead of several megabytes.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", inp,
      "-vf", "scale='min(1024,iw)':-2", "-map_metadata", "-1", "-frames:v", "1",
      "-q:v", "4", out]);
    const png = await fs.readFile(out);
    if (png.length > 1_500_000) return { ok: false, reason: "invalid_image" };
    // TODO: face count + moderation here
    return { ok: true, png };
  } catch {
    return { ok: false, reason: "invalid_image" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
