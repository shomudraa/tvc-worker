import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration, ffmpeg } from "../ffmpeg.js";

const BASE = "https://api.magichour.ai";

async function api(route, init = {}) {
  const res = await fetch(BASE + route, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.keys.magichour}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MagicHour ${route} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function upload(localPath, type, extension) {
  const out = await api("/v1/files/upload-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ type, extension }] }),
  });
  const item = out.items[0];
  const put = await fetch(item.upload_url, { method: "PUT", body: await fs.readFile(localPath) });
  if (!put.ok) throw new Error(`MagicHour upload -> ${put.status} ${await put.text()}`);
  return item.file_path;
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  if (!config.keys.magichour) throw new Error("MAGIC_HOUR_API_KEY missing");

  const mode = process.env.CR_MODE || "replace";
  const resolution = process.env.CR_RESOLUTION || "720p";
  const selectionMode = process.env.CR_SELECTION || "auto";
  const secs = await duration(videoPath);

  const style = { mode, selection_mode: selectionMode };
  if (selectionMode === "point") {
    const raw = process.env.CR_POINT || "";
    const [x, y, t] = raw.split(",").map(Number);
    if ([x, y, t].some(Number.isNaN)) {
      throw new Error('CR_POINT must be "x,y,seconds" when CR_SELECTION=point');
    }
    style.points = [{ position_x: x, position_y: y, time_seconds: t }];
  }

  log(`charreplace: uploading ${secs.toFixed(2)}s segment + reference`);
  const videoRef = await upload(videoPath, "video", "mp4");
  const imageRef = await upload(facePath, "image", "png");

  log(`charreplace: creating job, mode=${mode} ${resolution}`);
  const job = await api("/v1/character-replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "tvc-character-replace",
      start_seconds: 0,
      end_seconds: Number(secs.toFixed(2)),
      resolution,
      style,
      assets: {
        image_file_path: imageRef,
        video_file_path: videoRef,
      },
    }),
  });
  log(`charreplace: job ${job.id}, est ${job.credits_charged} credits`);

  let info;
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    info = await api(`/v1/video-projects/${job.id}`);
    if (info.status === "complete") break;
    if (info.status === "error" || info.status === "canceled") {
      throw new Error(`MagicHour character-replace ${info.status}: ${info.error?.code} ${info.error?.message}`);
    }
    if (i % 5 === 0) log(`charreplace: ${info.status}`);
  }
  if (info?.status !== "complete") throw new Error("MagicHour character-replace timed out");

  const url = info.downloads?.[0]?.url || info.downloads?.[0]?.file_path;
  if (!url) throw new Error(`MagicHour: no download in ${JSON.stringify(info.downloads)}`);
  log(`charreplace: downloading, charged ${info.credits_charged} credits`);
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`MagicHour download -> ${dl.status}`);

  const raw = path.join(path.dirname(outPath), `cr_raw_${path.basename(outPath)}`);
  await fs.writeFile(raw, Buffer.from(await dl.arrayBuffer()));

  await ffmpeg(["-i", raw, "-t", String(secs), "-c", "copy", outPath]);
  await fs.rm(raw, { force: true });
  return outPath;
}
