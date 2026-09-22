import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration, ffmpeg } from "../ffmpeg.js";

export const MODEL = "minimax/h3/reference-to-video";
// Preserve the working Higgsfield branch's prompt word for word.
export const DEFAULT_PROMPT =
  "Recreate the reference video shot for shot. Keep the same location, lighting, " +
  "wardrobe, framing and camera movement. The person in the reference photo is the " +
  "performer on screen, with their face and likeness, performing the same actions " +
  "with the same timing. The performer speaks the reference audio: mouth shapes, jaw " +
  "and tongue follow every syllable of that voice track, starting and stopping exactly " +
  "with it, closed lips through the silences. Photorealistic, broadcast commercial " +
  "quality, no captions, no on screen text, no logos.";

export function settings(env = process.env) {
  // MODEL is pinned in code. Ignore stale deployment values from older versions.
  const resolution = (env.FAL_RESOLUTION || "2K").trim().toUpperCase();
  if (!["480P", "768P", "2K", "4K"].includes(resolution)) {
    throw new Error("Invalid FAL_RESOLUTION. Use 480P, 768P, 2K or 4K.");
  }
  const aspect = (env.FAL_ASPECT || env.HF_ASPECT_RATIO || "adaptive").trim();
  const aspectRatio = aspect === "auto" ? "adaptive" : aspect;
  if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(aspectRatio)) {
    throw new Error("Invalid FAL_ASPECT.");
  }
  return {
    prompt: (env.FAL_PROMPT || env.HF_PROMPT || "").trim() || DEFAULT_PROMPT,
    resolution, aspect_ratio: aspectRatio,
    videoRef: (env.FAL_VIDEO_REF ?? env.HF_VIDEO_REF) !== "0",
    audioRef: (env.FAL_AUDIO_REF ?? env.HF_AUDIO_REF) !== "0",
  };
}

export function referenceInput(seconds, options, { imageUrl, videoUrl, audioUrl }) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid segment duration.");
  if (videoUrl && (seconds < 2 || seconds > 15)) {
    throw new Error("fal reference video must be 2–15 seconds. Check FACE_SEGMENTS.");
  }
  const input = {
    prompt: options.prompt,
    duration: Math.min(15, Math.max(5, Math.ceil(seconds))),
    resolution: options.resolution,
    aspect_ratio: options.aspect_ratio,
    reference_image_urls: [imageUrl],
  };
  if (videoUrl) input.reference_video_urls = [videoUrl];
  if (audioUrl) input.reference_audio_urls = [audioUrl];
  return input;
}

export function falError(error) {
  const detail = error?.body?.detail;
  const message = typeof detail === "string" ? detail : error?.message || "Unknown error";
  if (error?.status === 401 || error?.status === 403 || /No user found for Key ID and Secret|unauthorized|invalid.{0,15}(key|credential)/i.test(message)) {
    return "fal authentication failed. Check FAL_KEY in the active worker environment and fal service status. If the key was changed, redeploy. Higgsfield and MiniMax keys cannot authenticate with fal.ai.";
  }
  return message;
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".wav": "audio/wav" };
async function uploadLocal(fal, filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()];
  if (!type) throw new Error("Unsupported reference file type.");
  return fal.storage.upload(new Blob([await fs.readFile(filePath)], { type }));
}

export async function swapVideo({ videoPath, facePath, outPath, start, end, log = () => {} }) {
  const options = settings();
  const key = (process.env.FAL_KEY || "").trim();
  if (!key) throw new Error("FAL_KEY missing. Set a fal.ai API key in the worker environment.");
  const { createFalClient } = await import("@fal-ai/client");
  const fal = createFalClient({ credentials: key });
  const seconds = await duration(videoPath);
  // Validate before uploading any references.
  referenceInput(seconds, options, { imageUrl: "pending", videoUrl: options.videoRef ? "pending" : null });
  let audioPath = null;
  try {
    if (options.audioRef && Number.isFinite(start) && Number.isFinite(end)) {
      audioPath = path.join(path.dirname(outPath), `refaudio_${start}_${end}.wav`);
      try {
        await ffmpeg(["-ss", String(start), "-to", String(end), "-i", config.masterVideo,
          "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", audioPath]);
      } catch (error) {
        log(`falai: no usable audio for ${start}-${end}s, sending without it`);
        await fs.rm(audioPath, { force: true });
        audioPath = null;
      }
    }
    log("falai: uploading references");
    // Await every upload before cleanup, including when an upload fails.
    const uploads = await Promise.allSettled([
      uploadLocal(fal, facePath),
      options.videoRef ? uploadLocal(fal, videoPath) : null,
      audioPath ? uploadLocal(fal, audioPath) : null,
    ]);
    const failed = uploads.find((result) => result.status === "rejected");
    if (failed) throw new Error(`fal upload failed: ${falError(failed.reason)}`, { cause: failed.reason });
    const [imageUrl, videoUrl, audioUrl] = uploads.map((result) => result.value);
    const input = referenceInput(seconds, options, { imageUrl, videoUrl, audioUrl });
    log(`falai: ${MODEL}, ${input.duration}s at ${input.resolution}`);
    let result;
    try {
      result = await fal.subscribe(MODEL, {
        input, logs: true,
        onQueueUpdate: (update) => { if (update.status) log(`falai: ${update.status}`); },
      });
    } catch (error) {
      throw new Error(`fal generation failed: ${falError(error)}`, { cause: error });
    }
    const url = result?.data?.video?.url;
    if (!url) throw new Error("fal returned no video URL.");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fal download failed: HTTP ${response.status}`);
    await fs.writeFile(outPath, Buffer.from(await response.arrayBuffer()));
    return outPath;
  } finally {
    if (audioPath) await fs.rm(audioPath, { force: true });
  }
}
