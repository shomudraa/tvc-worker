import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { prepareSegments } from "./pipeline.js";
import { validateSelfie } from "./validate.js";
import { createQueue } from "./queue.js";
import { validEmail, emailEnabled } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "../web");
const queue = await createQueue();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// CORS for a separately hosted frontend (set SITE_ORIGIN=https://your-site.vercel.app)
app.use((req, res, next) => {
  const allowed = process.env.SITE_ORIGIN;
  if (allowed && req.headers.origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Security headers (Cloudflare adds more at the edge in production)
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' " + (process.env.SITE_ORIGIN || "") + "; frame-ancestors 'none'");
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const hashIp = (ip) => crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);

async function checkLimits(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `swap:count:${day}`;
  const ipKey = `swap:ip:${hashIp(ip)}:${Math.floor(Date.now() / 3600000)}`;
  if (Number((await queue.getKV(dayKey)) || 0) >= config.maxJobsPerDay) return "daily_cap";
  if (Number((await queue.getKV(ipKey)) || 0) >= config.maxJobsPerIpPerHour) return "rate_limited";
  await queue.incrKV(dayKey, 172800);
  await queue.incrKV(ipKey, 3600);
  return null;
}

app.get("/health", (_req, res) => res.json({ ok: true, queue: queue.kind, provider: config.provider, email: emailEnabled() }));

app.post("/jobs", upload.single("face"), async (req, res) => {
  try {
    if ((await queue.getKV("swap:paused")) === "1") return res.status(503).json({ error: "paused" });
    if (!req.file) return res.status(400).json({ error: "no_file" });
    if (req.body.consent !== "true") return res.status(400).json({ error: "consent_required" });
    const ip = req.headers["cf-connecting-ip"] || req.ip;
    const limited = await checkLimits(ip);
    if (limited) return res.status(429).json({ error: limited });

    const check = await validateSelfie(req.file.buffer);
    if (!check.ok) return res.status(400).json({ error: check.reason });

    const jobId = crypto.randomUUID();
    await fs.mkdir(config.tmpDir, { recursive: true });
    const facePath = path.join(config.tmpDir, `${jobId}_face.png`);
    await fs.writeFile(facePath, check.png);
    const email = (req.body.email || "").trim();
    if (email && !validEmail(email)) return res.status(400).json({ error: "bad_email" });

    await queue.setKV(`swap:consent:${jobId}`, JSON.stringify({ ts: Date.now(), ipHash: hashIp(ip), policy: "v1" }), config.retentionHours * 3600);
    if (email) await queue.setKV(`swap:email:${jobId}`, email, config.retentionHours * 3600);
    await queue.add(jobId, { facePath, email });
    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/jobs/:id", async (req, res) => {
  const job = await queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  const out = { state: job.state };
  if (job.state === "completed") out.videoUrl = `/videos/${req.params.id}.mp4`;
  res.json(out);
});

app.delete("/jobs/:id", async (req, res) => {
  await fs.rm(path.join(config.outputsDir, `${req.params.id}.mp4`), { force: true });
  await queue.delKV(`swap:consent:${req.params.id}`);
  res.json({ deleted: true });
});

// Admin kill switch: POST /admin/pause {paused:true|false} with header x-admin-token
app.post("/admin/pause", express.json(), async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) return res.status(401).end();
  await queue.setKV("swap:paused", req.body.paused ? "1" : "0");
  res.json({ paused: !!req.body.paused });
});

// Watch page for the link we email out. Serves the same single page app; the
// hash tells the front end which finished video to show.
app.get("/watch/:id", (req, res) => res.redirect(`/#job=${encodeURIComponent(req.params.id)}`));

// Outputs (production: replace with signed R2/S3 URLs), master loop for the background, and the site
app.use("/videos", express.static(config.outputsDir, { maxAge: "1h", index: false }));
app.get("/master.mp4", (_req, res) => res.sendFile(config.masterVideo));
app.use(express.static(webDir, { index: "index.html" }));

setInterval(async () => {
  const cutoff = Date.now() - config.retentionHours * 3600 * 1000;
  for (const f of await fs.readdir(config.outputsDir).catch(() => [])) {
    const p = path.join(config.outputsDir, f);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.rm(p, { force: true });
  }
}, 15 * 60 * 1000);

await prepareSegments();
app.listen(config.port, () => console.log(`site: http://localhost:${config.port}  queue=${queue.kind} provider=${config.provider}`));
