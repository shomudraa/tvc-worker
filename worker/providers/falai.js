import fs from "node:fs/promises";
import path from "node:path";
import { duration } from "../ffmpeg.js";

/**
 * "falai" provider — one adapter, two families of fal endpoints.
 *
 * FAL_MODEL picks the endpoint. Two input shapes are supported:
 *
 *   motion-control  (default, $0.07/sec on v2.6 standard)
 *     fal-ai/kling-video/v2.6/standard/motion-control
 *     fal-ai/kling-video/v3/pro/motion-control
 *     Takes ONE image_url + ONE video_url. Transfers the movement from the
 *     video onto the character in the image.
 *
 *   reference-to-video  ($0.222/sec at 720p with video input)
 *     bytedance/seedance-2.0/reference-to-video
 *     bytedance/seedance-2.5/reference-to-video
 *     Takes image_urls[] + video_urls[] and a prompt that names them as
 *     [Image1] and [Video1].
 *
 * The shape is chosen from the model string, so you only change FAL_MODEL.
 *
 * Env:
 *   FAL_KEY         required, from fal.ai
 *   FAL_MODEL       endpoint id (default fal-ai/kling-video/v2.6/standard/motion-control)
 *   FAL_PROMPT      master prompt
 *   FAL_ORIENTATION motion-control only: "video" (default) or "image"
 *   FAL_RESOLUTION  reference-to-video only: 480p (default) or 720p
 *   FAL_ASPECT      reference-to-video only: 16:9 (default)
 *   FAL_AUDIO       "true" to generate audio (default false; master audio is
 *                   re-attached later, and on Seedance audio costs the same
 *                   either way)
 */

const DEFAULT_MODEL = "fal-ai/kling-video/v2.6/standard/motion-control";

const DEFAULT_PROMPTS = {
  "video-edit":
    "Replace the face of the person in the video with @Element1, " +
    "maintaining the same movements, camera angles, clothing, background and lighting.",
  "motion-control": "A person speaking to camera outdoors, natural daylight, photoreal",
  "reference-to-video":
    "The person from [Image1] replaces the person in [Video1]. " +
    "Keep the scene, camera movement, framing, lighting and wardrobe of [Video1] exactly. " +
    "Keep the face from [Image1] exact and photoreal.",
};

function shapeFor(model) {
  if (model.includes("video-to-video")) return "video-edit";
  if (model.includes("reference-to-video")) return "reference-to-video";
  return "motion-control";
}

let configured = false;
async function getFal() {
  const { fal } = await import("@fal-ai/client");
  if (!configured) {
    if (!process.env.FAL_KEY) throw new Error("FAL_KEY missing");
    fal.config({ credentials: process.env.FAL_KEY });
    configured = true;
  }
  return fal;
}

async function uploadLocal(fal, localPath, mime) {
  const buf = await fs.readFile(localPath);
  return fal.storage.upload(new Blob([buf], { type: mime }));
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  const fal = await getFal();

  const model = process.env.FAL_MODEL || DEFAULT_MODEL;
  const shape = shapeFor(model);
  const prompt = process.env.FAL_PROMPT || DEFAULT_PROMPTS[shape];
  const generate_audio = process.env.FAL_AUDIO === "true";
  const secs = await duration(videoPath);

  log(`falai: uploading ${secs.toFixed(2)}s segment + selfie`);
  const [videoUrl, imageUrl] = await Promise.all([
    uploadLocal(fal, videoPath, "video/mp4"),
    uploadLocal(fal, facePath, "image/png"),
  ]);

  let input;
  if (shape === "video-edit") {
    // Kling Omni video-to-video/edit: keeps the original motion and scene and
    // edits the subject. The selfie is passed as @Element1 in the prompt.
    input = {
      prompt,
      video_url: videoUrl,
      elements: [{ frontal_image_url: imageUrl }],
    };
  } else if (shape === "motion-control") {
    input = {
      prompt,
      image_url: imageUrl,
      video_url: videoUrl,
      character_orientation: process.env.FAL_ORIENTATION || "video",
    };
  } else {
    input = {
      prompt,
      image_urls: [imageUrl],
      video_urls: [videoUrl],
      duration: String(Math.max(4, Math.min(15, Math.round(secs)))),
      resolution: process.env.FAL_RESOLUTION || "480p",
      aspect_ratio: process.env.FAL_ASPECT || "16:9",
      generate_audio,
    };
  }

  log(`falai: ${model} (${shape})`);
  const result = await fal.subscribe(model, {
    input,
    logs: true,
    onQueueUpdate: (u) => {
      if (u.status === "IN_PROGRESS" && u.logs?.length) {
        log(`falai: ${u.logs[u.logs.length - 1].message}`);
      } else if (u.status) {
        log(`falai: ${u.status}`);
      }
    },
  });

  const data = result?.data ?? result;
  const url = data?.video?.url;
  if (!url) throw new Error(`fal: no video url in ${JSON.stringify(data).slice(0, 400)}`);

  log("falai: downloading result");
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`fal download -> ${dl.status}`);

  const raw = path.join(path.dirname(outPath), `fal_raw_${path.basename(outPath)}`);
  await fs.writeFile(raw, Buffer.from(await dl.arrayBuffer()));

  // Trim to the exact segment length so the stitch stays aligned
  await ffmpeg(["-i", raw, "-t", String(secs), "-c", "copy", outPath]);
  await fs.rm(raw, { force: true });
  return outPath;
}
