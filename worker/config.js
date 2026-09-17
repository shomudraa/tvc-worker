import "dotenv/config";
import path from "node:path";

// Parse "0-5,25-30" into [{start:0,end:5},{start:25,end:30}]
function parseSegments(str) {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [a, b] = s.split("-").map(Number);
      if (Number.isNaN(a) || Number.isNaN(b) || b <= a) {
        throw new Error(`Bad FACE_SEGMENTS entry: ${s}`);
      }
      return { start: a, end: b };
    })
    .sort((x, y) => x.start - y.start);
}

const root = path.resolve(process.cwd());

export const config = {
  provider: process.env.PROVIDER || "mock",
  masterVideo: path.resolve(root, process.env.MASTER_VIDEO || "./assets/master.mp4"),
  segmentsDir: path.resolve(root, "./assets/segments"),
  tmpDir: path.resolve(root, "./tmp"),
  outputsDir: path.resolve(root, "./outputs"),
  faceSegments: parseSegments(process.env.FACE_SEGMENTS || "0-5,25-30"),
  watermark: process.env.WATERMARK_PNG ? path.resolve(root, process.env.WATERMARK_PNG) : null,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  port: Number(process.env.PORT || 4000),
  maxJobsPerDay: Number(process.env.MAX_JOBS_PER_DAY || 5000),
  maxJobsPerIpPerHour: Number(process.env.MAX_JOBS_PER_IP_PER_HOUR || 3),
  retentionHours: Number(process.env.RETENTION_HOURS || 24),
  keys: {
    magichour: process.env.MAGIC_HOUR_API_KEY || "",
    akool: process.env.AKOOL_API_KEY || "",
    vmodel: process.env.VMODEL_API_KEY || "",
  },
};
