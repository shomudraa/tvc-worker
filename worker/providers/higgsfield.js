import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration } from "../ffmpeg.js";

/**
 * Higgsfield Open API, MiniMax H3 Reference-to-Video.
 *
 * Model id: minimax/h3/reference-to-video
 * Docs:     https://open.higgsfield.ai/models/minimax/h3/reference-to-video/api-reference
 *
 * HOW THIS DIFFERS FROM charreplace.js
 * ------------------------------------
 * Magic Hour Character Replace edits the footage you give it: the scene, camera
 * move and body motion survive, only the performer changes. H3 is a generative
 * model. It reads the references and renders a NEW clip that resembles them. It
 * does not preserve the master frame for frame. Expect the swapped seconds to
 * look close to the TVC rather than identical to it, and check the cut against
 * the untouched seconds before this goes anywhere near the client.
 *
 * INPUTS ARE URLS, NOT FILES
 * --------------------------
 * H3 takes image_urls / video_urls, so both the segment and the selfie are
 * pushed to Higgsfield's own CDN first (POST /files/generate-upload-url, then a
 * PUT to the signed URL). The returned public_url is unguessable but public,
 * and Higgsfield has no delete endpoint: assume the selfie and the generated
 * clip live on their CDN for at least seven days. Say so in privacy.html.
 *
 * DURATION
 * --------
 * H3 accepts whole seconds from 5 to 15. Segments outside that range are
 * clamped and the pipeline's trimTo() cuts the result back to the exact segment
 * length. A 3 second segment therefore costs 5 seconds of render.
 *
 * Env:
 *   HF_KEY            "KEY_ID:KEY_SECRET" from https://open.higgsfield.ai/api-keys
 *                     (HF_CREDENTIALS is accepted too)
 *   HF_MODEL          default minimax/h3/reference-to-video
 *   HF_PROMPT         the generation prompt, see DEFAULT_PROMPT below
 *   HF_RESOLUTION     default 2K (the only option H3 offers today)
 *   HF_ASPECT_RATIO   auto (default), adaptive, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16
 *   HF_VIDEO_REF      1 (default) sends the original segment as a video
 *                     reference, 0 sends the selfie only
 *   HF_AIGC_WATERMARK 1 to let Higgsfield stamp its AI watermark, default 0
 *   HF_POLL_SECONDS   how long to wait for a render, default 900
 */

const BASE = "https://api.higgsfield.ai";

const DEFAULT_PROMPT =
  "Recreate the reference video shot for shot. Keep the same location, lighting, " +
  "wardrobe, framing and camera movement. The person in the reference photo is the " +
  "performer on screen, with their face and likeness, performing the same actions " +
  "with the same timing. Photorealistic, broadcast commercial quality, no captions, " +
  "no on screen text, no logos.";

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function credentials() {
  const raw = config.keys.higgsfield;
  if (!raw) throw new Error("HF_KEY missing (expected KEY_ID:KEY_SECRET)");
  const parts = raw.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('HF_KEY must be in the form "KEY_ID:KEY_SECRET"');
  }
  return { id: parts[0], secret: parts[1] };
}

function headers() {
  const { id, secret } = credentials();
  return {
    // v2 auth, used by every model endpoint
    Authorization: `Key ${id}:${secret}`,
    // the files endpoint predates v2 and still reads these
    "hf-api-key": id,
    "hf-secret": secret,
    Accept: "application/json",
  };
}

async function api(route, init = {}) {
  const res = await fetch(BASE + route, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Higgsfield ${route} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Push a local file to the Higgsfield CDN and return its public URL.
 */
async function uploadFile(localPath, log) {
  const ext = path.extname(localPath).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) throw new Error(`Higgsfield: unsupported reference type ${ext || "(none)"}`);

  const slot = await api("/files/generate-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType }),
  });
  if (!slot.upload_url || !slot.public_url) {
    throw new Error(`Higgsfield: bad upload slot ${JSON.stringify(slot).slice(0, 200)}`);
  }

  const bytes = await fs.readFile(localPath);
  await putSigned(slot.upload_url, bytes, contentType, log);

  log(`higgsfield: uploaded ${path.basename(localPath)} (${(bytes.length / 1e6).toFixed(2)} MB)`);
  return slot.public_url;
}

/**
 * PUT the bytes to a presigned S3 URL.
 *
 * The signature covers an exact set of headers, listed in the URL's
 * X-Amz-SignedHeaders parameter. Sending Content-Type when the signature did
 * not cover it, or omitting it when it did, both come back as
 * 403 SignatureDoesNotMatch. So read the list and send only what was signed,
 * then fall back to the other shape if S3 still refuses.
 */
async function putSigned(url, bytes, contentType, log) {
  let signed = [];
  try {
    signed = (new URL(url).searchParams.get("X-Amz-SignedHeaders") || "")
      .toLowerCase()
      .split(";")
      .filter(Boolean);
  } catch {}

  const withType = { "Content-Type": contentType };
  const order = signed.includes("content-type") ? [withType, {}] : [{}, withType];

  let last = "";
  for (let i = 0; i < order.length; i++) {
    const res = await fetch(url, { method: "PUT", headers: order[i], body: bytes });
    if (res.ok) {
      if (i > 0) log("higgsfield: upload needed the fallback header shape");
      return;
    }
    last = `${res.status} ${(await res.text()).slice(0, 300)}`;
    // Only a signature rejection is worth a second shape. Anything else
    // (expired URL, size limit, network) will fail the same way twice.
    if (res.status !== 403) break;
  }
  throw new Error(
    `Higgsfield upload -> ${last} (signed headers: ${signed.join(";") || "none"})`
  );
}

/**
 * Poll /requests/:id/status until the render lands.
 */
async function poll(requestId, log) {
  const limitMs = Number(process.env.HF_POLL_SECONDS || 900) * 1000;
  const startedAt = Date.now();
  let ticks = 0;
  while (Date.now() - startedAt < limitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await api(`/requests/${requestId}/status`);
    if (info.status === "completed") return info;
    if (info.status === "failed") {
      throw new Error(`Higgsfield request failed: ${JSON.stringify(info).slice(0, 400)}`);
    }
    if (info.status === "nsfw") {
      throw new Error("Higgsfield rejected the render as NSFW");
    }
    if (ticks++ % 10 === 0) log(`higgsfield: ${info.status}`);
  }
  throw new Error(`Higgsfield request ${requestId} timed out`);
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Higgsfield download -> ${res.status}`);
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  credentials(); // fail fast and clearly if HF_KEY is missing or malformed
  const model = process.env.HF_MODEL || "minimax/h3/reference-to-video";
  const secs = await duration(videoPath);
  // H3 takes whole seconds, 5 to 15. trimTo() in the pipeline cuts the result
  // back to the exact segment length afterwards.
  const want = Math.min(15, Math.max(5, Math.ceil(secs)));
  if (want !== Math.round(secs)) {
    log(`higgsfield: segment is ${secs.toFixed(2)}s, asking for ${want}s and trimming after`);
  }

  const sendVideoRef = process.env.HF_VIDEO_REF !== "0";
  log(`higgsfield: uploading references${sendVideoRef ? " (segment + selfie)" : " (selfie only)"}`);
  const [imageUrl, videoUrl] = await Promise.all([
    uploadFile(facePath, log),
    sendVideoRef ? uploadFile(videoPath, log) : Promise.resolve(null),
  ]);

  const input = {
    prompt: process.env.HF_PROMPT || DEFAULT_PROMPT,
    duration: want,
    resolution: process.env.HF_RESOLUTION || "2K",
    aspect_ratio: process.env.HF_ASPECT_RATIO || "auto",
    aigc_watermark: process.env.HF_AIGC_WATERMARK === "1",
    image_urls: [imageUrl],
  };
  if (videoUrl) input.video_urls = [videoUrl];

  log(`higgsfield: submitting to ${model}, ${want}s at ${input.resolution}`);
  const job = await api(`/${model}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!job.request_id) {
    throw new Error(`Higgsfield: no request_id in ${JSON.stringify(job).slice(0, 300)}`);
  }
  log(`higgsfield: request ${job.request_id}`);

  const info = job.status === "completed" ? job : await poll(job.request_id, log);
  const url = info.video?.url || info.images?.[0]?.url;
  if (!url) throw new Error(`Higgsfield: no output in ${JSON.stringify(info).slice(0, 300)}`);

  log("higgsfield: downloading result");
  // Written as-is. The pipeline normalizes it to the master's size and frame
  // rate and trims it to the exact segment length, so no ffmpeg work here.
  await download(url, outPath);
  return outPath;
}
