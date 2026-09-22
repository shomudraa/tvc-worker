import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration, ffmpeg } from "../ffmpeg.js";

/**
 * MiniMax Video Generation V2, direct.
 *
 * Docs: https://platform.minimax.io/docs/api-reference/video-generation-v2-create
 *
 * WHY DIRECT RATHER THAN THROUGH HIGGSFIELD
 * -----------------------------------------
 * Higgsfield resells this same model but hard codes resolution to 2K, which is
 * the slowest and dearest setting. MiniMax's own API exposes 480P and 768P, and
 * a fast variant of the model, so the same job renders in a fraction of the
 * time. It also accepts the reference files inline as data URIs, so there is no
 * CDN upload, no presigned URL, and the visitor's selfie never sits on a third
 * party's storage.
 *
 * MODELS AND RESOLUTIONS
 * ----------------------
 *   MiniMax-H3-Max   480P, 768P   5 to 15s   the fast variant, no 2K
 *   MiniMax-H3       768P, 2K     4 to 15s   the slower, higher quality one
 *
 * List price per second of output: 480P $0.05, 768P $0.08, 2K $0.13.
 *
 * REQUEST SIZE
 * ------------
 * Everything travels in one JSON body, capped at 64 MB, and base64 inflates by
 * about a third. A 10 second 1080p reference clip plus a selfie plus the audio
 * lands around 8 MB, so there is plenty of room, but the check below fails
 * early and clearly rather than letting MiniMax reject a huge request.
 *
 * Env:
 *   MINIMAX_API_KEY   from https://platform.minimax.io
 *   MM_MODEL          default MiniMax-H3-Max (fastest)
 *   MM_RESOLUTION     default 768P. 480P is faster and cheaper but soft
 *                     against a 1080p master
 *   MM_RATIO          default adaptive
 *   MM_PROMPT         the generation prompt, see DEFAULT_PROMPT
 *   MM_VIDEO_REF      1 (default) sends the original segment so the model has
 *                     the scene. 0 sends the selfie only and it will invent one
 *   MM_AUDIO_REF      1 (default) sends that window's audio so the mouth has
 *                     something to sync to
 *   MM_POLL_SECONDS   how long to wait for a render, default 1800
 */

const BASE = "https://api.minimax.io";

// Per model limits, straight from the API reference.
const LIMITS = {
  "MiniMax-H3-Max": { min: 5, max: 15, resolutions: ["480P", "768P"] },
  "MiniMax-H3": { min: 4, max: 15, resolutions: ["768P", "2K"] },
};

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const DEFAULT_PROMPT =
  "Recreate the reference video shot for shot. Keep the same location, lighting, " +
  "wardrobe, framing and camera movement. The person in the reference photo is the " +
  "performer on screen, with their face and likeness. The performer is stationary: " +
  "both feet stay planted, no walking and no stepping, only the head, face, eyes and " +
  "hands move. The performer speaks the reference audio, with mouth shapes following " +
  "every syllable of that voice and closed lips through the silences. Photorealistic, " +
  "broadcast commercial quality, no captions, no on screen text, no logos.";

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function apiKey() {
  const k = process.env.MINIMAX_API_KEY || config.keys.minimax;
  if (!k) throw new Error("MINIMAX_API_KEY missing");
  return k;
}

async function api(route, init = {}) {
  const res = await fetch(BASE + route, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MiniMax ${route} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Read a local file as a data URI, which is how references travel here. */
async function dataUri(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`MiniMax: unsupported reference type ${ext || "(none)"}`);
  const bytes = await fs.readFile(localPath);
  return { uri: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
}

/** Pull this window's audio off the master, since the cached segments are silent. */
async function extractAudio(start, end, outPath, log) {
  try {
    await ffmpeg([
      "-ss", String(start),
      "-to", String(end),
      "-i", config.masterVideo,
      "-vn",
      "-acodec", "pcm_s16le",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      outPath,
    ]);
    return outPath;
  } catch (e) {
    log(`minimax: no usable audio for ${start}-${end}s (${e.message.slice(0, 120)})`);
    return null;
  }
}

async function poll(taskId, log) {
  const limitMs = Number(process.env.MM_POLL_SECONDS || 1800) * 1000;
  const startedAt = Date.now();
  let ticks = 0;
  while (Date.now() - startedAt < limitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const out = await api(`/v2/query/video_generation/${taskId}`);
    const task = out.task || out;
    const status = task.status;
    if (status === "succeeded") return task;
    if (status === "failed" || status === "cancelled") {
      const detail = task.error ? JSON.stringify(task.error).slice(0, 300) : status;
      throw new Error(`MiniMax task ${status}: ${detail}`);
    }
    if (ticks++ % 10 === 0) log(`minimax: ${status}`);
  }
  throw new Error(`MiniMax task ${taskId} timed out`);
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MiniMax download -> ${res.status}`);
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

export async function swapVideo({ videoPath, facePath, outPath, start, end, log = () => {} }) {
  apiKey();

  const model = process.env.MM_MODEL || "MiniMax-H3-Max";
  const limits = LIMITS[model];
  if (!limits) throw new Error(`MM_MODEL must be one of: ${Object.keys(LIMITS).join(", ")}`);

  const resolution = process.env.MM_RESOLUTION || "768P";
  if (!limits.resolutions.includes(resolution)) {
    throw new Error(`${model} supports ${limits.resolutions.join(" or ")}, not ${resolution}`);
  }

  const secs = await duration(videoPath);
  const want = Math.min(limits.max, Math.max(limits.min, Math.ceil(secs)));
  if (want !== Math.round(secs)) {
    log(`minimax: segment is ${secs.toFixed(2)}s, asking for ${want}s and trimming after`);
  }

  const workDir = path.dirname(outPath);
  const content = [{ type: "text", text: process.env.MM_PROMPT || DEFAULT_PROMPT }];
  let bodyBytes = 0;

  const face = await dataUri(facePath);
  content.push({ type: "image_url", image_url: { url: face.uri }, role: "reference_image" });
  bodyBytes += face.bytes;

  const parts = ["selfie"];

  if (process.env.MM_VIDEO_REF !== "0") {
    const clip = await dataUri(videoPath);
    content.push({ type: "video_url", video_url: { url: clip.uri }, role: "reference_video" });
    bodyBytes += clip.bytes;
    parts.push("segment");
  }

  let audioPath = null;
  if (process.env.MM_AUDIO_REF !== "0" && Number.isFinite(start) && Number.isFinite(end)) {
    audioPath = await extractAudio(start, end, path.join(workDir, `mmaudio_${start}_${end}.wav`), log);
    if (audioPath) {
      const au = await dataUri(audioPath);
      content.push({ type: "audio_url", audio_url: { url: au.uri }, role: "reference_audio" });
      bodyBytes += au.bytes;
      parts.push("audio");
      await fs.rm(audioPath, { force: true });
    }
  }

  // base64 costs about a third on top of the raw bytes.
  const encoded = Math.ceil(bodyBytes * 1.37);
  if (encoded > MAX_BODY_BYTES) {
    throw new Error(
      `MiniMax: references are ${(encoded / 1e6).toFixed(1)} MB encoded, over the 64 MB request limit. ` +
        `Shorten FACE_SEGMENTS or send a smaller reference clip.`
    );
  }

  log(`minimax: ${model} ${resolution} ${want}s, refs (${parts.join(" + ")}), ${(encoded / 1e6).toFixed(1)} MB body`);

  const created = await api("/v2/video_generation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      content,
      resolution,
      duration: want,
      ratio: process.env.MM_RATIO || "adaptive",
    }),
  });

  const taskId = created.task_id || created.task?.id || created.id;
  if (!taskId) throw new Error(`MiniMax: no task id in ${JSON.stringify(created).slice(0, 300)}`);
  log(`minimax: task ${taskId}`);

  const task = await poll(taskId, log);
  const url = task.content?.url || task.video?.url;
  if (!url) throw new Error(`MiniMax: no output url in ${JSON.stringify(task).slice(0, 300)}`);

  if (task.usage) log(`minimax: billed ${task.usage.output_seconds ?? task.usage.total_seconds}s of ${resolution}`);
  log("minimax: downloading result");

  // Written as-is. The pipeline normalizes it to the master's size and frame
  // rate and trims it to the exact segment length, so no ffmpeg work here.
  await download(url, outPath);
  return outPath;
}
