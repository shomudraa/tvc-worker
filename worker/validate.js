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
  const out = path.join(dir, "out.png");
  try {
    await fs.writeFile(inp, buf);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", inp,
      "-vf", "scale='min(2048,iw)':-2", "-map_metadata", "-1", "-frames:v", "1", out]);
    const png = await fs.readFile(out);
    // TODO: face count + moderation here
    return { ok: true, png };
  } catch {
    return { ok: false, reason: "invalid_image" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
