import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { duration } from "../ffmpeg.js";

/**
 * Magic Hour Character Replace.
 *
 * Sends the original segment plus a reference character image. The model keeps
 * the scene, camera move and body motion from the footage and replaces the
 * performer.
 *
 * The reference must be ONE full-body, front-facing character image. A bare
 * head-and-shoulders selfie gives the model nothing to build a body from, which
 * is why an earlier test came back as a head swap on the original body. A
 * multi-panel character sheet is worse: the model reads the panels as separate
 * people.
 *
 * So when CR_BODY_IMAGE is set, this provider first face-swaps the visitor onto
 * that still (a frame of the real actor, full body, in the TVC's wardrobe) and
 * uses the result as the character reference. The build and clothing are then
 * real rather than invented, so the swapped seconds blend with the untouched
 * footage. That first step is a photo swap: 10 credits and a few seconds.
 *
 * Env:
 *   CR_BODY_IMAGE   path to the full-body still, e.g. ./assets/body.jpg
 *                   Leave unset to send the selfie straight through.
 *   CR_MODE         replace (default) | animate
 *   CR_RESOLUTION   480p (default) | 720p | 1080p, subject to your plan
 *   CR_SELECTION    auto (default) | point
 *   CR_POINT        for CR_SELECTION=point, as "x,y,seconds"
 */

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

async function poll(kind, id, log) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await api(`/v1/${kind}/${id}`);
    if (info.status === "complete") return info;
    if (info.status === "error" || info.status === "canceled") {
      throw new Error(`MagicHour ${kind} ${info.status}: ${info.error?.code || ""} ${info.error?.message || ""}`.trim());
    }
    if (i % 5 === 0) log(`${kind}: ${info.status}`);
  }
  throw new Error(`MagicHour ${kind} timed out`);
}

async function download(info, outPath) {
  const url = info.downloads?.[0]?.url || info.downloads?.[0]?.file_path;
  if (!url) throw new Error(`MagicHour: no download in ${JSON.stringify(info.downloads)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MagicHour download -> ${res.status}`);
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

/**
 * Put the visitor's face onto the full-body still, giving a character image
 * with a real body and the right wardrobe. Returns a local file path.
 */
async function buildCharacterImage(facePath, bodyPath, workDir, log) {
  const ext = path.extname(bodyPath).slice(1).toLowerCase() || "jpg";
  log("charreplace: building character image from the body still");
  const [faceRef, bodyRef] = await Promise.all([
    upload(facePath, "image", "jpg"),
    upload(bodyPath, "image", ext),
  ]);
  const job = await api("/v1/face-swap-photo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "tvc-character",
      assets: {
        face_swap_mode: "all-faces",
        source_file_path: faceRef,
        target_file_path: bodyRef,
      },
    }),
  });
  const info = await poll("image-projects", job.id, log);
  const out = path.join(workDir, "character.png");
  await download(info, out);
  log(`charreplace: character image ready (${info.credits_charged} credits)`);
  return out;
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  if (!config.keys.magichour) throw new Error("MAGIC_HOUR_API_KEY missing");

  const mode = process.env.CR_MODE || "replace";
  const resolution = process.env.CR_RESOLUTION || "480p";
  const selectionMode = process.env.CR_SELECTION || "auto";
  const secs = await duration(videoPath);
  const workDir = path.dirname(outPath);

  // Optional step: turn the selfie into a full-body character image
  let referencePath = facePath;
  const bodyEnv = process.env.CR_BODY_IMAGE;
  if (bodyEnv) {
    const bodyPath = path.resolve(process.cwd(), bodyEnv);
    try {
      await fs.access(bodyPath);
      referencePath = await buildCharacterImage(facePath, bodyPath, workDir, log);
    } catch (e) {
      log(`charreplace: body still unusable (${e.message}), sending the selfie as-is`);
    }
  }

  const style = { mode, selection_mode: selectionMode };
  if (selectionMode === "point") {
    const [x, y, t] = String(process.env.CR_POINT || "").split(",").map(Number);
    if ([x, y, t].some(Number.isNaN)) {
      throw new Error('CR_POINT must be "x,y,seconds" when CR_SELECTION=point');
    }
    style.points = [{ position_x: x, position_y: y, time_seconds: t }];
  }

  log(`charreplace: uploading ${secs.toFixed(2)}s segment + reference`);
  const isPng = referencePath.endsWith(".png");
  const [videoRef, imageRef] = await Promise.all([
    upload(videoPath, "video", "mp4"),
    upload(referencePath, "image", isPng ? "png" : "jpg"),
  ]);

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
      assets: { image_file_path: imageRef, video_file_path: videoRef },
    }),
  });
  log(`charreplace: job ${job.id}, est ${job.credits_charged} credits`);

  const info = await poll("video-projects", job.id, log);
  log(`charreplace: downloading, charged ${info.credits_charged} credits`);

  // Written as-is. The pipeline normalizes it to the master's size and frame
  // rate and trims it to the exact segment length, so no ffmpeg work here.
  await download(info, outPath);
  if (referencePath !== facePath) await fs.rm(referencePath, { force: true });
  return outPath;
}
