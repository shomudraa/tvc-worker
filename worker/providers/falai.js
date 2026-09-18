import fs from "node:fs/promises";
import path from "node:path";
import { duration, ffmpeg } from "../ffmpeg.js";

const DEFAULT_MODEL = "fal-ai/kling-video/v2.6/standard/motion-control";

const DEFAULT_PROMPTS = {
  "motion-control": "A person speaking to camera outdoors, natural daylight, photoreal",
  "reference-to-video":
    "The person from [Image1] replaces the person in [Video1]. " +
    "Keep the scene, camera movement, framing, lighting and wardrobe of [Video1] exactly. " +
    "Keep the face from [Image1] exact and photoreal.",
};

function shapeFor(model) {
  return model.includes("reference-to-video") ? "reference-to-video" : "motion-control";
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
  if (shape === "motion-control") {
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

  await ffmpeg(["-i", raw, "-t", String(secs), "-c", "copy", outPath]);
  await fs.rm(raw, { force: true });
  return outPath;
}
