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

// x264 was pinned to a single thread, which left most of the machine idle on
// every encode. 0 means "use every core". Set FFMPEG_THREADS to go back to 1
// if a build ever needs the old deterministic single threaded behaviour.
const THREADS = String(process.env.FFMPEG_THREADS ?? 0);

function videoArgs(fps = DEFAULT_FPS) {
  const r = String(fps);
  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-threads", THREADS,
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

/**
 * Join already-matching pieces.
 *
 * Every piece is encoded with the same settings, by cutSegment or by
 * normalizeTo, so the streams line up and can be joined without re-encoding.
 * That matters a lot: a re-encode here rebuilds the ENTIRE master on every
 * single job, even though the keep pieces are identical for every visitor.
 * Copying is roughly a hundred times faster.
 *
 * If the pieces ever stop matching, ffmpeg either errors or writes a file of
 * the wrong length, so the result is measured and a real encode takes over.
 */
export async function concat(files, output, fps) {
  const listFile = output + ".txt";
  await fs.writeFile(listFile, files.map((f) => `file '${path.resolve(f)}'`).join("\n"));

  let want = 0;
  for (const f of files) want += await duration(f);

  try {
    await ffmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-an",
      "-c", "copy",
      "-movflags", "+faststart",
      output,
    ]);
    if (Math.abs((await duration(output)) - want) <= 0.25) {
      await fs.unlink(listFile);
      return output;
    }
  } catch {
    // fall through to the re-encode
  }

  await ffmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-an",
    ...videoArgs(fps),
    output,
  ]);
  await fs.unlink(listFile);

  // A real mismatch between pieces (different size, say) confuses the concat
  // demuxer and the timestamps run away, which used to ship a visitor a video
  // of the wrong length with no warning. Fail the job instead.
  const got = await duration(output);
  if (Math.abs(got - want) > 0.5) {
    throw new Error(`concat produced ${got.toFixed(2)}s, expected ${want.toFixed(2)}s: the pieces do not match`);
  }
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

/** One pass: force a provider's clip to the master's size and frame rate AND
 *  cut it to the exact segment length. This replaces a normalize followed by a
 *  trimTo, which encoded the same clip twice. */
export async function normalizeTo(input, output, width, height, fps, secs) {
  await ffmpeg([
    "-i", input,
    "-t", String(secs),
    "-an",
    "-vf", `scale=${width}:${height}:flags=lanczos,setsar=1`,
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
