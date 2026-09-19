import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

/**
 * Every piece is re-encoded with identical settings so the stitch has no seam.
 *
 * The frame rate is NOT hardcoded. It is taken from the master video and
 * threaded through every step. Forcing a fixed rate onto a master shot at a
 * different one (24 vs 25, say) makes ffmpeg duplicate or drop frames in each
 * piece, and the rounding at every boundary accumulates until the picture runs
 * out of step with the audio track that gets attached at the end.
 */
const DEFAULT_FPS = 25;

function videoArgs(fps = DEFAULT_FPS) {
  const r = String(fps);
  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-threads", "1",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", r,
    "-g", r,
    "-keyint_min", r,
    "-sc_threshold", "0",
    "-video_track_timescale", "90000",
    "-movflags", "+faststart",
  ];
}

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

/** Frame rate of a file, as a number. "24/1" -> 24, "30000/1001" -> 29.97. */
export async function frameRate(file) {
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === "video");
  if (!v?.r_frame_rate) return DEFAULT_FPS;
  const [n, d] = v.r_frame_rate.split("/").map(Number);
  const fps = d ? n / d : n;
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

/** Cut [start, end) with re-encode. Audio is dropped; the master's own audio
 *  track is attached once at the very end so it can never drift. */
export async function cutSegment(input, start, end, output, fps) {
  await ffmpeg([
    "-ss", String(start),
    "-to", String(end),
    "-i", input,
    "-an",
    ...videoArgs(fps),
    output,
  ]);
  return output;
}

/** Join already-matching pieces. */
export async function concat(files, output, fps) {
  const listFile = output + ".txt";
  await fs.writeFile(listFile, files.map((f) => `file '${path.resolve(f)}'`).join("\n"));
  await ffmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-an",
    ...videoArgs(fps),
    output,
  ]);
  await fs.unlink(listFile);
  return output;
}

/** Force a provider's clip to the master's size and frame rate. */
export async function normalize(input, output, width, height, fps) {
  await ffmpeg([
    "-i", input,
    "-an",
    "-vf", `scale=${width}:${height}:flags=lanczos,setsar=1`,
    ...videoArgs(fps),
    output,
  ]);
  return output;
}

/** Re-encode to an exact duration. Generated clips come back longer than asked
 *  and with odd timestamps, which breaks concat, so every piece passes here. */
export async function trimTo(input, secs, output, fps) {
  await ffmpeg([
    "-i", input,
    "-t", String(secs),
    "-an",
    ...videoArgs(fps),
    output,
  ]);
  return output;
}

export async function watermark(input, png, output, fps) {
  await ffmpeg([
    "-i", input,
    "-i", png,
    "-filter_complex", "[1]scale=iw*0.6:-1[wm];[0][wm]overlay=W-w-40:H-h-40",
    "-an",
    ...videoArgs(fps),
    output,
  ]);
  return output;
}

/** Final mux: stitched picture plus the ORIGINAL master audio, untouched. */
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

/** Ordered pieces for a master of `total` seconds and the given face windows. */
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
