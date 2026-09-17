import { ffmpeg } from "../ffmpeg.js";

/**
 * Mock provider for free local testing. Returns the input video with a
 * visible tint and label so you can SEE which frames went through the
 * "swap" when checking the stitched result.
 */
export async function swapVideo({ videoPath, outPath, log = () => {} }) {
  log("mock: tinting segment to simulate swap");
  await ffmpeg([
    "-i", videoPath,
    "-vf", "hue=h=90:s=1.4,drawtext=text='SWAPPED':fontsize=48:fontcolor=white:x=40:y=40:box=1:boxcolor=black@0.5",
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    outPath,
  ]);
  return outPath;
}
