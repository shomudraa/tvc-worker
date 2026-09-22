import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../worker/config.js";
import { prepareSegments, runSwapJob } from "../worker/pipeline.js";
import { duration, ffmpeg } from "../worker/ffmpeg.js";

const provider = config.provider;
const face = process.env.FACE || null;

if (!face) throw new Error("Set FACE to a test selfie; this test makes paid fal.ai requests.");

await prepareSegments();

let facePath = face;
if (!facePath) {
  await fs.mkdir(config.tmpDir, { recursive: true });
  facePath = path.join(config.tmpDir, "placeholder_face.png");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=orange:s=512x512:d=1", "-frames:v", "1", facePath]);
}

const jobId = `test_${Date.now()}`;
console.log(`provider=${provider} job=${jobId}`);
const res = await runSwapJob({ jobId, facePath, providerName: provider, log: (m) => console.log("  " + m) });
const len = await duration(res.final);
console.log(`final: ${res.final}`);
console.log(`final duration: ${len.toFixed(2)}s (master ${(await duration(config.masterVideo)).toFixed(2)}s)`);
console.log("timings ms:", res.timings, "total:", res.totalMs);
