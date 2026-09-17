import { ffmpeg } from "../worker/ffmpeg.js";
import fs from "node:fs/promises";
// 30s synthetic master: test pattern + timecode burn-in, with a tone so audio sync is checkable.
await fs.mkdir("assets", { recursive: true });
await ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-vf", "drawtext=text='%{pts\\:hms}':fontsize=72:fontcolor=white:x=(w-tw)/2:y=h-120:box=1:boxcolor=black@0.6",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-shortest", "assets/master.mp4",
]);
console.log("assets/master.mp4 created (30s synthetic)");
