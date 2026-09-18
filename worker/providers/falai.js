import fs from "node:fs/promises";
import { duration } from "../ffmpeg.js";

const DEFAULT_MODEL =
  "fal-ai/kling-video/o3/pro/video-to-video/edit";

const DEFAULT_PROMPTS = {
  "video-edit":
    "Replace the face of the person in @Video1 with the face from @Image1. " +
    "Preserve the original movements, camera angles, clothing, background and lighting.",

  "motion-control":
    "A person speaking to camera outdoors, natural daylight, photoreal",

  "reference-to-video":
    "The person from [Image1] replaces the person in [Video1]. " +
    "Keep the scene, camera movement, framing, lighting and wardrobe of [Video1]. " +
    "Keep the face from [Image1] exact and photoreal.",
};

function shapeFor(model) {
  if (
    model.startsWith("fal-ai/kling-video/") &&
    model.endsWith("/video-to-video/edit")
  ) {
    return "video-edit";
  }

  if (
    model.startsWith("fal-ai/kling-video/") &&
    model.endsWith("/motion-control")
  ) {
    return "motion-control";
  }

  if (
    model.startsWith("bytedance/seedance-") &&
    model.endsWith("/reference-to-video")
  ) {
    return "reference-to-video";
  }

  throw new Error(
    "Unsupported FAL_MODEL for this adapter. Use " +
      DEFAULT_MODEL +
      " for editing the original video."
  );
}

let configured = false;

async function getFal() {
  const { fal } = await import("@fal-ai/client");

  if (!configured) {
    const key = (process.env.FAL_KEY || "").trim();

    if (!key) {
      throw new Error("FAL_KEY missing");
    }

    fal.config({ credentials: key });
    configured = true;
  }

  return fal;
}

async function uploadLocal(fal, localPath, mime) {
  const buffer = await fs.readFile(localPath);
  return fal.storage.upload(new Blob([buffer], { type: mime }));
}

export async function swapVideo({
  videoPath,
  facePath,
  outPath,
  log = () => {},
}) {
  const model = (process.env.FAL_MODEL || DEFAULT_MODEL).trim();
  const shape = shapeFor(model);
  const fal = await getFal();

  const prompt =
    (process.env.FAL_PROMPT || "").trim() ||
    DEFAULT_PROMPTS[shape];

  const seconds = await duration(videoPath);

  if (
    shape === "video-edit" &&
    (seconds < 3 || seconds > 15)
  ) {
    throw new Error(
      `Kling video editing requires a 3–15 second input clip; ` +
        `received ${seconds.toFixed(2)} seconds.`
    );
  }

  log(`falai: uploading ${seconds.toFixed(2)}s segment + selfie`);

  let videoUrl;
  let imageUrl;

  try {
    [videoUrl, imageUrl] = await Promise.all([
      uploadLocal(fal, videoPath, "video/mp4"),
      uploadLocal(fal, facePath, "image/png"),
    ]);
  } catch (error) {
    throw new Error(
      `fal upload failed: ${error.message || "Unknown error"}`,
      { cause: error }
    );
  }

  let input;

  if (shape === "video-edit") {
    // A single selfie is an image reference.
    // The prompt must refer to it as @Image1, not @Element1.
    input = {
      prompt,
      video_url: videoUrl,
      image_urls: [imageUrl],
    };
  } else if (shape === "motion-control") {
    input = {
      prompt,
      image_url: imageUrl,
      video_url: videoUrl,
      character_orientation:
        process.env.FAL_ORIENTATION || "video",
    };
  } else {
    // This input shape is for Seedance, not Kling.
    input = {
      prompt,
      image_urls: [imageUrl],
      video_urls: [videoUrl],
      duration: String(
        Math.max(4, Math.min(15, Math.round(seconds)))
      ),
      resolution: process.env.FAL_RESOLUTION || "480p",
      aspect_ratio: process.env.FAL_ASPECT || "16:9",
      generate_audio: process.env.FAL_AUDIO === "true",
    };
  }

  log(`falai: ${model} (${shape})`);

  let result;

  try {
    result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (
          update.status === "IN_PROGRESS" &&
          update.logs?.length
        ) {
          log(
            `falai: ${
              update.logs[update.logs.length - 1].message
            }`
          );
        } else if (update.status) {
          log(`falai: ${update.status}`);
        }
      },
    });
  } catch (error) {
    throw new Error(
      `fal generation failed: ${error.message || "Unknown error"}`,
      { cause: error }
    );
  }

  const data = result?.data ?? result;
  const url = data?.video?.url;

  if (!url) {
    throw new Error("fal returned no video URL");
  }

  log("falai: downloading result");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `fal download failed: HTTP ${response.status}`
    );
  }

  await fs.writeFile(
    outPath,
    Buffer.from(await response.arrayBuffer())
  );

  return outPath;
}
