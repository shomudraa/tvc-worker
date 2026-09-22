import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration, ffmpeg } from "../ffmpeg.js";

/**
 * fal.ai adapter.
 *
 * Four request shapes are supported, picked from FAL_MODEL:
 *
 *   h3-reference        minimax/h3/reference-to-video        (default)
 *                       minimax/h3-max/reference-to-video
 *                       The one we use. Takes the selfie, the original segment
 *                       and that window's audio as three separate reference
 *                       lists, so the model has the scene, the face and the
 *                       voice.
 *
 *                       Plain H3 is the default because it is far cheaper here.
 *                       fal bills plain H3 as output only: $0.05 / $0.06 /
 *                       $0.13 / $0.16 per second at 480P / 768P / 2K / 4K,
 *                       with the first 5 reference images free and no charge
 *                       listed for reference video or audio.
 *
 *                       H3 Max is billed differently: output at $0.05 / $0.08 /
 *                       $0.16 per second at 480P / 768P / 1080P PLUS reference
 *                       tokens beyond a 4,096 allowance at $0.02 per 1,000.
 *                       A 10 second reference clip alone adds about $1.27 at
 *                       768P, which is why a measured 10s H3 Max run cost
 *                       $2.11 against about $0.60 for plain H3.
 *
 *   video-edit          fal-ai/kling-video/.../video-to-video/edit
 *   motion-control      fal-ai/kling-video/.../motion-control
 *   reference-to-video  bytedance/seedance-.../reference-to-video
 *
 * Env:
 *   FAL_KEY              fal credentials
 *   FAL_MODEL            default minimax/h3/reference-to-video
 *   FAL_PROMPT           overrides the shape's default prompt
 *   FAL_RESOLUTION       768P by default. Allowed values differ per model:
 *                        plain H3  480P, 768P, 2K, 4K
 *                        H3 Max    480P, 768P, 1080P
 *   FAL_ASPECT           default adaptive on h3, 16:9 on seedance
 *   FAL_EXPANSION        balanced (default), disabled, fast or quality.
 *                        Higgsfield never set this, so MiniMax's own expansion
 *                        was on for the runs where the scene held. Expansion
 *                        fills in scene detail and helps the video reference
 *                        win over the photo. Set it to disabled only when
 *                        testing exact prompt wording
 *   FAL_AUDIO_REF        1 (default) sends the window's audio for lip sync
 *   FAL_SEED             fixed seed for repeatable tests
 */

const DEFAULT_MODEL = "minimax/h3/reference-to-video";

const DEFAULT_PROMPTS = {
  // THIS IS THE KNOWN GOOD PROMPT. Word for word what the Higgsfield provider
  // sent to the same model, where the scene held correctly.
  //
  // It leads with "recreate the reference video". That ordering is what keeps
  // the scene. Two rewrites proved it the hard way:
  //   - A heavy "reproduce Video 1 exactly, identical, identical" version made
  //     the model return the reference clip with no swap at all.
  //   - An identity first version ("Image 1 is the person...") flipped the
  //     weight onto the photo and produced a selfie style video instead of the
  //     commercial's scene.
  //
  // Its one known weakness is that the performer sometimes walks. Fix that with
  // a single added sentence and test it on its own. Do not restructure this.
  "h3-reference":
    "Recreate the reference video shot for shot. Keep the same location, lighting, " +
    "wardrobe, framing and camera movement. The person in the reference photo is the " +
    "performer on screen, with their face and likeness, performing the same actions " +
    "with the same timing. The performer speaks the reference audio: mouth shapes, jaw " +
    "and tongue follow every syllable of that voice track, starting and stopping exactly " +
    "with it, closed lips through the silences. Photorealistic, broadcast commercial " +
    "quality, no captions, no on screen text, no logos.",

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

// H3 and H3 Max on fal, both reference-to-video. The resolution lists differ:
// plain H3 goes up to 4K and has no 1080P tier, H3 Max tops out at 1080P.
const H3_LIMITS = {
  "minimax/h3/reference-to-video": {
    min: 4,
    max: 15,
    resolutions: ["480P", "768P", "2K", "4K"],
  },
  "minimax/h3-max/reference-to-video": {
    min: 5,
    max: 15,
    resolutions: ["480P", "768P", "1080P"],
  },
};

function shapeFor(model) {
  if (H3_LIMITS[model]) return "h3-reference";

  if (model.startsWith("fal-ai/kling-video/") && model.endsWith("/video-to-video/edit")) {
    return "video-edit";
  }

  if (model.startsWith("fal-ai/kling-video/") && model.endsWith("/motion-control")) {
    return "motion-control";
  }

  if (model.startsWith("bytedance/seedance-") && model.endsWith("/reference-to-video")) {
    return "reference-to-video";
  }

  throw new Error(
    `Unsupported FAL_MODEL "${model}". Use ${DEFAULT_MODEL}, or one of: ` +
      Object.keys(H3_LIMITS).join(", ") +
      ", fal-ai/kling-video/*/video-to-video/edit, fal-ai/kling-video/*/motion-control, " +
      "bytedance/seedance-*/reference-to-video."
  );
}

let configured = false;

async function getFal() {
  const { fal } = await import("@fal-ai/client");

  if (!configured) {
    const key = (process.env.FAL_KEY || "").trim();
    if (!key) throw new Error("FAL_KEY missing");
    fal.config({ credentials: key });
    configured = true;
  }

  return fal;
}

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/**
 * Upload a local file to fal storage.
 *
 * The content type MUST match the real bytes. fal stores the file under the
 * type given here, and the model decodes it by that type, so labelling a JPEG
 * as image/png makes H3 Max reject the whole request with 422 Unprocessable
 * Entity. Our selfies arrive as .jpg from validate.js, so the type is read
 * from the extension rather than assumed.
 */
async function uploadLocal(fal, localPath) {
  const ext = path.extname(localPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`fal upload: unsupported file type ${ext || "(none)"} for ${path.basename(localPath)}`);
  const buffer = await fs.readFile(localPath);
  return fal.storage.upload(new Blob([buffer], { type: mime }));
}

/** fal puts the useful part of a 422 in body.detail. Surface it. */
function falErrorText(error) {
  const detail = error?.body?.detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => `${Array.isArray(d.loc) ? d.loc.join(".") : d.loc || "?"}: ${d.msg || d.type || ""}`)
      .join("; ");
  }
  if (typeof detail === "string") return detail;
  if (error?.body) return JSON.stringify(error.body).slice(0, 400);
  return error?.message || "Unknown error";
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
    log(`falai: no usable audio for ${start}-${end}s (${e.message.slice(0, 120)})`);
    return null;
  }
}

export async function swapVideo({ videoPath, facePath, outPath, start, end, log = () => {} }) {
  const model = (process.env.FAL_MODEL || DEFAULT_MODEL).trim();
  const shape = shapeFor(model);
  const fal = await getFal();

  const prompt = (process.env.FAL_PROMPT || "").trim() || DEFAULT_PROMPTS[shape];
  const seconds = await duration(videoPath);

  if (shape === "video-edit" && (seconds < 3 || seconds > 15)) {
    throw new Error(
      `Kling video editing requires a 3-15 second input clip; received ${seconds.toFixed(2)} seconds.`
    );
  }

  if (shape === "h3-reference" && (seconds < 2 || seconds > 15)) {
    throw new Error(
      `fal reference video clips must be 2-15 seconds; received ${seconds.toFixed(2)} seconds. ` +
        `Adjust FACE_SEGMENTS.`
    );
  }

  log(`falai: uploading ${seconds.toFixed(2)}s segment + selfie`);

  let videoUrl;
  let imageUrl;

  try {
    [videoUrl, imageUrl] = await Promise.all([
      uploadLocal(fal, videoPath),
      uploadLocal(fal, facePath),
    ]);
  } catch (error) {
    throw new Error(`fal upload failed: ${falErrorText(error)}`, { cause: error });
  }

  let input;

  if (shape === "h3-reference") {
    const limits = H3_LIMITS[model];
    const want = Math.min(limits.max, Math.max(limits.min, Math.ceil(seconds)));

    const resolution = (process.env.FAL_RESOLUTION || "768P").toUpperCase();
    if (!limits.resolutions.includes(resolution)) {
      throw new Error(
        `${model} supports ${limits.resolutions.join(", ")}, not ${resolution}. Fix FAL_RESOLUTION.`
      );
    }

    // Audio reference: without it the model invents mouth movement.
    const references = ["Image 1", "Video 1"];
    let audioUrl = null;

    if (process.env.FAL_AUDIO_REF !== "0" && Number.isFinite(start) && Number.isFinite(end)) {
      const audioPath = path.join(path.dirname(outPath), `falaudio_${start}_${end}.wav`);
      const made = await extractAudio(start, end, audioPath, log);
      if (made) {
        try {
          audioUrl = await uploadLocal(fal, made);
          references.push("Audio 1");
        } finally {
          await fs.rm(made, { force: true });
        }
      }
    }

    input = {
      prompt,
      // Matches the Higgsfield setup, where this was left at MiniMax's own
      // default. Expansion adds scene detail and keeps the video reference
      // from being overpowered by the selfie.
      prompt_expansion_mode: process.env.FAL_EXPANSION || "balanced",
      reference_image_urls: [imageUrl],
      reference_video_urls: [videoUrl],
      duration: want,
      resolution,
      aspect_ratio: process.env.FAL_ASPECT || "adaptive",
    };

    if (audioUrl) input.reference_audio_urls = [audioUrl];
    if (process.env.FAL_SEED) input.seed = Number(process.env.FAL_SEED);

    if (want !== Math.round(seconds)) {
      log(`falai: segment is ${seconds.toFixed(2)}s, asking for ${want}s and trimming after`);
    }
    log(`falai: ${resolution} ${want}s, refs (${references.join(" + ")}), expansion ${input.prompt_expansion_mode}`);
  } else if (shape === "video-edit") {
    // A single selfie is an image reference.
    // The prompt must refer to it as @Image1, not @Element1.
    input = { prompt, video_url: videoUrl, image_urls: [imageUrl] };
  } else if (shape === "motion-control") {
    input = {
      prompt,
      image_url: imageUrl,
      video_url: videoUrl,
      character_orientation: process.env.FAL_ORIENTATION || "video",
    };
  } else {
    // This input shape is for Seedance, not Kling.
    input = {
      prompt,
      image_urls: [imageUrl],
      video_urls: [videoUrl],
      duration: String(Math.max(4, Math.min(15, Math.round(seconds)))),
      resolution: process.env.FAL_RESOLUTION || "480p",
      aspect_ratio: process.env.FAL_ASPECT || "16:9",
      generate_audio: process.env.FAL_AUDIO === "true",
    };
  }

  log(`falai: ${model} (${shape})`);

  const startedAt = Date.now();
  let result;

  try {
    result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && update.logs?.length) {
          log(`falai: ${update.logs[update.logs.length - 1].message}`);
        } else if (update.status) {
          log(`falai: ${update.status}`);
        }
      },
    });
  } catch (error) {
    const detail = falErrorText(error);
    log(`falai: request rejected -> ${detail}`);
    throw new Error(`fal generation failed: ${detail}`, { cause: error });
  }

  const data = result?.data ?? result;
  const url = data?.video?.url;

  if (!url) throw new Error("fal returned no video URL");

  log(`falai: render took ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  if (data?.timings) log(`falai: timings ${JSON.stringify(data.timings).slice(0, 200)}`);

  log("falai: downloading result");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fal download failed: HTTP ${response.status}`);

  await fs.writeFile(outPath, Buffer.from(await response.arrayBuffer()));
  return outPath;
}
