import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration } from "../ffmpeg.js";

/**
 * Magic Hour video face swap.
 *
 * Docs: https://docs.magichour.ai/tools/video/face-swap-video
 *       https://docs.magichour.ai/api-reference/video-projects/face-swap-video
 *
 * WHY THIS IS DIFFERENT FROM MINIMAX AND HIGGSFIELD
 * -------------------------------------------------
 * MiniMax H3 and Higgsfield regenerate the whole shot from a reference, so the
 * model decides how the body moves. That is where the walking problem came
 * from. Magic Hour does a true frame by frame face swap: it keeps the original
 * footage and only replaces the face. The actor's body, wardrobe, camera move,
 * lighting and mouth timing all stay exactly as shot, so lip sync is correct by
 * construction and nobody starts walking.
 *
 * BILLING
 * -------
 * Charged per rendered frame. Resolution does not change the price, so a 1080p
 * master costs the same as 480p. The create call returns credits_charged as an
 * estimate and the finished project carries the final number. Both are logged
 * below, so the first live run tells us the real rate per second.
 *
 * SCALE
 * -----
 * Magic Hour states no API rate limit and no concurrency limit, which matters
 * for the campaign. Still cap our own side with the queue.
 *
 * Env:
 *   MAGIC_HOUR_API_KEY   from https://magichour.ai, starts with mhk_live_
 *   MH_STYLE_VERSION     default, v1 or v2. Default is "default"
 *   MH_POLL_SECONDS      how long to wait for a render, default 900
 */

const BASE = "https://api.magichour.ai";

// Straight from the upload-urls reference. Anything else is rejected there.
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm"]);
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "jfif", "heic", "heif", "webp",
  "avif", "jp2", "tiff", "tif", "bmp",
]);

const PUT_MIME = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function apiKey() {
  const k = process.env.MAGIC_HOUR_API_KEY || config.keys.magichour;
  if (!k) throw new Error("MAGIC_HOUR_API_KEY missing");
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
  if (!res.ok) throw new Error(`MagicHour ${route} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

function extOf(localPath, kind) {
  const ext = path.extname(localPath).replace(".", "").toLowerCase();
  const allowed = kind === "video" ? VIDEO_EXT : IMAGE_EXT;
  if (!allowed.has(ext)) {
    throw new Error(`MagicHour: ${kind} extension ${ext || "(none)"} is not accepted`);
  }
  return ext;
}

/** Ask for a presigned URL, PUT the bytes, hand back the file_path reference. */
async function uploadFile(localPath, kind, log) {
  const ext = extOf(localPath, kind);
  const { items } = await api("/v1/files/upload-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ type: kind, extension: ext }] }),
  });

  const slot = items?.[0];
  if (!slot?.upload_url || !slot?.file_path) {
    throw new Error(`MagicHour: bad upload slot ${JSON.stringify(items).slice(0, 200)}`);
  }

  const bytes = await fs.readFile(localPath);
  const put = await fetch(slot.upload_url, {
    method: "PUT",
    headers: PUT_MIME[ext] ? { "Content-Type": PUT_MIME[ext] } : {},
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`MagicHour upload (${kind}) -> ${put.status} ${(await put.text()).slice(0, 300)}`);
  }

  log(`magichour: uploaded ${kind} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  return slot.file_path;
}

async function poll(id, log) {
  const limitMs = Number(process.env.MH_POLL_SECONDS || 900) * 1000;
  const startedAt = Date.now();
  let ticks = 0;

  while (Date.now() - startedAt < limitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const project = await api(`/v1/video-projects/${id}`);
    const status = project.status;

    if (status === "complete") return project;
    if (status === "error" || status === "canceled") {
      const detail = project.error ? JSON.stringify(project.error).slice(0, 300) : status;
      throw new Error(`MagicHour project ${status}: ${detail}`);
    }
    if (ticks++ % 10 === 0) log(`magichour: ${status}`);
  }

  throw new Error(`MagicHour project ${id} timed out after ${limitMs / 1000}s`);
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  apiKey();

  // We send the already cut segment, so the swap window is the whole clip.
  const secs = await duration(videoPath);
  const end = Math.max(0.1, Number(secs.toFixed(2)));

  const [videoRef, faceRef] = await Promise.all([
    uploadFile(videoPath, "video", log),
    uploadFile(facePath, "image", log),
  ]);

  const created = await api("/v1/face-swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "tvc-swap",
      start_seconds: 0,
      end_seconds: end,
      style: { version: process.env.MH_STYLE_VERSION || "default" },
      assets: {
        video_source: "file",
        video_file_path: videoRef,
        image_file_path: faceRef,
        face_swap_mode: "all-faces",
      },
    }),
  });

  const id = created.id;
  if (!id) throw new Error(`MagicHour: no project id in ${JSON.stringify(created).slice(0, 300)}`);
  log(`magichour: project ${id}, ${end}s, estimate ${created.credits_charged ?? "?"} credits`);

  const project = await poll(id, log);
  if (project.credits_charged != null) {
    log(`magichour: billed ${project.credits_charged} credits for ${end}s`);
  }

  const url = project.downloads?.[0]?.url;
  if (!url) throw new Error(`MagicHour: no download url in ${JSON.stringify(project).slice(0, 300)}`);

  log("magichour: downloading result");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MagicHour download -> ${res.status}`);
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}
