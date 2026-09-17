import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

// Shared encode settings so every piece matches and the stitch has no seam.
// Re-encoding every piece (rather than stream copy) is deliberate: it
// guarantees identical codec, GOP, pixel format and timebase at the joins.
const VIDEO_ARGS = [
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-r", "25",
  "-g", "25",
  "-keyint_min", "25",
  "-sc_threshold", "0",
  "-movflags", "+faststart",
];

export async function ffmpeg(args) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stderr;
}

export async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,pix_fmt",
    "-of", "json",
    file,
  ]);
  return JSON.parse(stdout);
}

export async function duration(file) {
  const info = await probe(file);
  return Number(info.format.duration);
}

/**
 * Cut a video segment [start, end) with re-encode, video only (audio is
 * re-attached from the master at the end so it never drifts).
 */
export async function cutSegment(input, start, end, output) {
  await ffmpeg([
    "-ss", String(start),
    "-to", String(end),
    "-i", input,
    "-an",
    ...VIDEO_ARGS,
    output,
  ]);
  return output;
}

/**
 * Concatenate several already-matching video files into one.
 */
export async function concat(files, output) {
  const listFile = output + ".txt";
  await fs.writeFile(listFile, files.map((f) => `file '${path.resolve(f)}'`).join("\n"));
  await ffmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-an",
    ...VIDEO_ARGS,
    output,
  ]);
  await fs.unlink(listFile);
  return output;
}

/**
 * Normalize a file returned by the swap provider so it matches our encode
 * settings and the master's resolution (providers sometimes return a
 * different fps or size).
 */
export async function normalize(input, output, width, height) {
  await ffmpeg([
    "-i", input,
    "-an",
    "-vf", `scale=${width}:${height}:flags=lanczos,setsar=1`,
    ...VIDEO_ARGS,
    output,
  ]);
  return output;
}

/**
 * Overlay a PNG watermark bottom-right.
 */
export async function watermark(input, png, output) {
  await ffmpeg([
    "-i", input,
    "-i", png,
    "-filter_complex", "[1]scale=iw*0.6:-1[wm];[0][wm]overlay=W-w-40:H-h-40",
    "-an",
    ...VIDEO_ARGS,
    output,
  ]);
  return output;
}

/**
 * Final mux: take the stitched video and the ORIGINAL master audio track.
 */
export async function muxAudio(video, master, output) {
  await ffmpeg([
    "-i", video,
    "-i", master,
    "-map", "0:v:0",
    "-map", "1:a:0?",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    output,
  ]);
  return output;
}

/**
 * Build the piece plan for a master of given length and face segments.
 * Returns ordered pieces: {kind:'face'|'keep', start, end}
 */
export function planPieces(total, faceSegments) {
  const pieces = [];
  let cursor = 0;
  for (const seg of faceSegments) {
    if (seg.start > cursor) pieces.push({ kind: "keep", start: cursor, end: seg.start });
    pieces.push({ kind: "face", start: seg.start, end: seg.end });
    cursor = seg.end;
  }
  if (cursor < total - 0.01) pieces.push({ kind: "keep", start: cursor, end: total });
  return pieces;
}
