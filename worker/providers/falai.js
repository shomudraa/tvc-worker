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
  if (shape ===
