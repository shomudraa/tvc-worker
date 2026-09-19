import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { cutSegment, concat, normalize, trimTo, watermark, muxAudio, duration, frameRate, probe, planPieces } from "./ffmpeg.js";
import { getProvider } from "./providers/index.js";

/**
 * Run ONCE at startup (or via npm run prepare:segments).
 * Cuts the master into pieces and caches them. Face pieces are also joined
 * into a single file so the provider is called exactly once per user.
 */
export async function prepareSegments({ force = false } = {}) {
  await fs.mkdir(config.segmentsDir, { recursive: true });
  // Reuse the cache when the master and timing haven't changed
  if (!force) {
    try {
      const m = await loadManifest();
      const st = await fs.stat(config.masterVideo);
      if (m.masterMtime === st.mtimeMs && m.segmentsKey === JSON.stringify(config.faceSegments)) return m;
    } catch {}
  }
  const total = await duration(config.masterVideo);
  const fps = await frameRate(config.masterVideo);
  const pieces = planPieces(total, config.faceSegments);

  const manifest = { total, pieces: [], facePieces: [], joinedFace: null };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const file = path.join(config.segmentsDir, `${String(i).padStart(2, "0")}_${p.kind}.mp4`);
    await cutSegment(config.masterVideo, p.start, p.end, file, fps);
    const entry = { ...p, file, index: i };
    manifest.pieces.push(entry);
    if (p.kind === "face") manifest.facePieces.push(entry);
  }

  const joined = path.join(config.segmentsDir, "face_joined.mp4");
  await concat(manifest.facePieces.map((f) => f.file), joined);
  manifest.joinedFace = joined;

  const info = await probe(config.masterVideo);
  const v = info.streams.find((s) => s.codec_type === "video");
  manifest.width = v.width;
  manifest.height = v.height;
  manifest.fps = fps;
  manifest.masterMtime = (await fs.stat(config.masterVideo)).mtimeMs;
  manifest.segmentsKey = JSON.stringify(config.faceSegments);

  await fs.writeFile(path.join(config.segmentsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`master ${total.toFixed(3)}s ${manifest.width}x${manifest.height} @${fps}fps, pieces:`);
  for (const p of manifest.pieces) console.log(`  ${p.index} ${p.kind} ${p.start}-${p.end}s`);
  return manifest;
}

export async function loadManifest() {
  const raw = await fs.readFile(path.join(config.segmentsDir, "manifest.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Per-user job. Returns the path to the final personalized MP4.
 */
export async function runSwapJob({ jobId, facePath, providerName = config.provider, log = () => {} }) {
  const t0 = Date.now();
  const timings = {};
  const mark = (k) => (timings[k] = Date.now() - t0);

  const manifest = await loadManifest();
  const work = path.join(config.tmpDir, jobId);
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(config.outputsDir, { recursive: true });

  // 1) swap each face segment on its own.
  // One call per segment: providers bill per rendered frame, so the cost is the
  // same as sending them joined, and each segment gets its own face detection.
  // A joined file has a hard cut in it, and the swap only tracked the face it
  // locked onto at the start, leaving later segments unswapped.
  const provider = getProvider(providerName);
  const swappedPieces = {};
  for (const fp of manifest.facePieces) {
    const raw = path.join(work, `raw_${fp.index}.mp4`);
    log(`swapping segment ${fp.start}-${fp.end}s`);
    await provider.swapVideo({ videoPath: fp.file, facePath, outPath: raw, log });
    const want = fp.end - fp.start;
    log(`  provider returned ${(await duration(raw)).toFixed(2)}s, need ${want.toFixed(2)}s`);
    const norm = path.join(work, `norm_${fp.index}.mp4`);
    await normalize(raw, norm, manifest.width, manifest.height, manifest.fps);
    const fitted = path.join(work, `swapped_${fp.index}.mp4`);
    await trimTo(norm, want, fitted, manifest.fps);
    log(`  piece ${fp.index} ready at ${(await duration(fitted)).toFixed(2)}s`);
    await fs.rm(raw, { force: true });
    await fs.rm(norm, { force: true });
    swappedPieces[fp.index] = fitted;
  }
  mark("swap");

  // 4) stitch in original order: keep pieces from cache, face pieces from swap
  const ordered = manifest.pieces.map((p) => (p.kind === "face" ? swappedPieces[p.index] : p.file));
  for (const p of manifest.pieces) {
    const f = p.kind === "face" ? swappedPieces[p.index] : p.file;
    log(`  stitch input ${p.index} ${p.kind} ${p.start}-${p.end}s = ${(await duration(f)).toFixed(2)}s`);
  }
  const stitched = path.join(work, "stitched.mp4");
  await concat(ordered, stitched, manifest.fps);
  log(`  stitched to ${(await duration(stitched)).toFixed(2)}s (master is ${manifest.total.toFixed(2)}s)`);
  mark("stitch");

  // 5) optional watermark
  let videoForMux = stitched;
  if (config.watermark) {
    try {
      await fs.access(config.watermark);
      videoForMux = path.join(work, "watermarked.mp4");
      await watermark(stitched, config.watermark, videoForMux, manifest.fps);
      mark("watermark");
    } catch {
      log("watermark file not found, skipping");
    }
  }

  // 6) mux original master audio
  const final = path.join(config.outputsDir, `${jobId}.mp4`);
  await muxAudio(videoForMux, config.masterVideo, final);
  log(`  final ${(await duration(final)).toFixed(2)}s`);
  mark("mux");

  // 7) delete the user's face photo immediately (privacy)
  try { await fs.unlink(facePath); } catch {}
  await fs.rm(work, { recursive: true, force: true });
  mark("cleanup");

  return { final, timings, totalMs: Date.now() - t0 };
}
