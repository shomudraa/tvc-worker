import fs from "node:fs/promises";
import { config } from "../config.js";

/**
 * Magic Hour video face swap.
 * Docs: https://docs.magichour.ai/tools/video/face-swap-video
 *
 * NOTE FOR CLAUDE CODE: verify the exact endpoint paths, upload flow and
 * response fields against the live docs before first real run. The shape
 * below follows the documented v1 face swap flow (create job -> poll ->
 * download) but field names must be confirmed. Prefer the official SDK
 * (npm install magic-hour) once confirmed; this raw fetch version keeps
 * dependencies minimal.
 */
const BASE = "https://api.magichour.ai";

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.keys.magichour}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`MagicHour ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function uploadFile(localPath, kind) {
  // 1) request an upload URL
  const { items } = await api("/v1/files/upload-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ type: kind, extension: localPath.split(".").pop() }] }),
  });
  const { upload_url, file_path } = items[0];
  // 2) PUT the bytes
  const buf = await fs.readFile(localPath);
  const put = await fetch(upload_url, { method: "PUT", body: buf });
  if (!put.ok) throw new Error(`Upload failed ${put.status}`);
  return file_path;
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  if (!config.keys.magichour) throw new Error("MAGIC_HOUR_API_KEY missing");

  log("magichour: uploading assets");
  const videoRef = await uploadFile(videoPath, "video");
  const faceRef = await uploadFile(facePath, "image");

  log("magichour: creating face swap job");
  const job = await api("/v1/face-swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "tvc-swap",
      start_seconds: 0,
      end_seconds: 10,
      style: { version: "default" },
      assets: {
        video_source: "file",
        video_file_path: videoRef,
        image_file_path: faceRef,
        face_swap_mode: "all-faces",
      },
    }),
  });

  log(`magichour: job ${job.id} created, polling`);
  let status;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    status = await api(`/v1/video-projects/${job.id}`);
    if (status.status === "complete") break;
    if (status.status === "error" || status.status === "canceled") {
      throw new Error(`MagicHour job failed: ${JSON.stringify(status.error || status)}`);
    }
  }
  if (status?.status !== "complete") throw new Error("MagicHour job timed out");

  const url = status.downloads?.[0]?.url;
  if (!url) throw new Error("MagicHour: no download url in response");
  log("magichour: downloading result");
  const res = await fetch(url);
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}
