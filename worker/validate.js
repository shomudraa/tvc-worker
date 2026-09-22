import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const run = promisify(execFile);

/**
 * Selfie validation.
 * - Checks real image bytes (magic numbers), not just extension
 * - Re-encodes via ffmpeg, which strips EXIF/GPS and neutralises malformed files
 * - Face count check: TODO. Plug in one of:
 *     a) @vladmandic/face-api (runs locally, free)
 *     b) Gemini Flash vision call: "exactly one real human face, front facing?"
 *     c) AWS Rekognition DetectFaces + DetectModerationLabels + RecognizeCelebrities
 *   Return {ok:false, reason:"no_face"|"multiple_faces"|"not_a_photo"|"moderation"} as needed.
 *
 * WHY THE SELFIE IS KEPT LARGE
 * ----------------------------
 * This file used to shrink every upload to 1024px at JPEG quality 4, which
 * landed around 200 kB. That starved the generation model of facial detail, and
 * it filled the gaps by inventing features: a thicker beard, a different jaw.
 * The reference photo is the only thing telling the model what the person looks
 * like, so detail here is identity accuracy in the output.
 *
 * The size still matters because the image travels as base64 inside the queued
 * Redis job, and base64 adds about a third. Upstash caps a request at 10 MB on
 * both the free and pay as you go plans, so a 4 MB image (about 5.4 MB encoded)
 * leaves comfortable headroom. If ffmpeg lands above that, the steps below
 * re-encode smaller rather than rejecting a photo the visitor took in good
 * faith.
 */
const MAGIC = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46],
};

// Each step is tried in order until one lands under MAX_BYTES.
// q:v 2 is close to lossless, q:v 4 is still good, 31 is the worst allowed.
const ENCODE_STEPS = [
  { width: 1920, quality: 2 },
  { width: 1920, quality: 4 },
  { width: 1280, quality: 4 },
  { width: 1024, quality: 6 },
];

const MAX_BYTES = 4_000_000;

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

    let bytes = null;
    for (const step of ENCODE_STEPS) {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inp,
        // min() never upscales, so a small phone photo stays its own size.
        "-vf", `scale='min(${step.width},iw)':-2`,
        "-map_metadata", "-1",
        "-frames:v", "1",
        "-q:v", String(step.quality),
        out,
      ]);
      const encoded = await fs.readFile(out);
      if (encoded.length <= MAX_BYTES) {
        bytes = encoded;
        break;
      }
    }

    // Every step was still too large, which means something is wrong with the
    // file rather than with our settings.
    if (!bytes) return { ok: false, reason: "invalid_image" };

    // TODO: face count + moderation here
    // Named png for historical reasons; the bytes are JPEG.
    return { ok: true, png: bytes };
  } catch {
    return { ok: false, reason: "invalid_image" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
