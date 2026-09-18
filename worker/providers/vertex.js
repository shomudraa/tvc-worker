import fs from "node:fs/promises";
import { createSign } from "node:crypto";
import { duration } from "../ffmpeg.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_MODEL = "gemini-omni-1.1-flash-preview";
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

// Render secret file, never a file committed to this repository.
async function credentials() {
  const filename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!filename) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to your Render service-account secret file path");
  let account;
  try { account = JSON.parse(await fs.readFile(filename, "utf8")); }
  catch { throw new Error("Cannot read service-account JSON from the Render secret file"); }
  if (account.type !== "service_account" || !account.client_email || !account.private_key) {
    throw new Error("Vertex requires a service-account JSON file, not an AI Studio API key");
  }
  return account;
}

// Google OAuth service-account JWT exchange. All destinations are fixed.
async function accessToken(account, signal) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  });
  const signature = createSign("RSA-SHA256").update(unsigned).end()
    .sign(account.private_key).toString("base64url");
  const response = await fetch(TOKEN_URL, {
    method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + signature }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Vertex authentication failed (HTTP ${response.status}); check that the service-account key is active`);
  }
  return data.access_token;
}

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  const account = await credentials();
  const project = (process.env.GOOGLE_CLOUD_PROJECT || account.project_id || "").trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) {
    throw new Error("Set GOOGLE_CLOUD_PROJECT to your Google Cloud project ID (not its display name)");
  }
  const seconds = await duration(videoPath);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) {
    throw new Error("Vertex Omni editing requires a clip of 10 seconds or less");
  }
  const sizes = await Promise.all([videoPath, facePath].map(p => fs.stat(p)));
  if (sizes.reduce((n, s) => n + s.size, 0) > 14 * 1024 * 1024) {
    throw new Error("Vertex inline input limit: reduce clip and selfie below 14 MB combined");
  }
  const [video, face] = await Promise.all([fs.readFile(videoPath), fs.readFile(facePath)]);
  const model = (process.env.VERTEX_MODEL || DEFAULT_MODEL).trim();
  const prompt = (process.env.VERTEX_PROMPT || "").trim() ||
    "Edit the supplied video: replace the person's face with the face in the supplied image. " +
    "Use the image only as an identity reference, not a starting frame. " +
    "Keep everything else the same, including duration, motion, clothing, camera framing and lighting.";
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  let stage = "authentication";
  let token;
  try {
    token = await accessToken(account, signal);
    const endpoint = `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`;
    async function request(url, options = {}) {
      const response = await fetch(url, {
        ...options, signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = String(data.error?.message || response.statusText).replaceAll(token, "[redacted]").slice(0, 400);
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      return data;
    }
    stage = "generation";
    log(`vertex: ${model}, project=${project}, editing ${seconds.toFixed(2)}s`);
    // Inline input/output avoids a Cloud Storage bucket and extra storage permissions.
    let result = await request(endpoint, {
      method: "POST",
      body: JSON.stringify({
        model, background: false,
        input: [
          { type: "text", text: prompt },
          { type: "video", mime_type: "video/mp4", data: video.toString("base64") },
          { type: "image", mime_type: "image/png", data: face.toString("base64") },
        ],
        response_format: [{ type: "video" }],
        generation_config: { video_config: { task: "edit" } },
      }),
    });
    while (["in_progress", "queued"].includes(result.status)) {
      if (!result.id) throw new Error("Vertex returned a pending result without an interaction ID");
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 5000));
      result = await request(`${endpoint}/${encodeURIComponent(result.id)}`);
    }
    const output = (result.steps || []).filter(s => s.type === "model_output")
      .flatMap(s => s.content || []).find(c => c.type === "video" && c.data);
    if (!output) throw new Error(`No inline video returned (status=${result.status || "unknown"}); inspect Vertex generation logs`);
    stage = "saving video";
    const bytes = Buffer.from(output.data, "base64");
    if (!bytes.length) throw new Error("Vertex returned an empty video");
    await fs.writeFile(outPath, bytes);
    log("vertex: video saved; continuing FFmpeg pipeline");
    return outPath;
  } catch (error) {
    let message = signal.aborted ? "Timed out after 15 minutes; check Vertex before retrying" : String(error.message);
    if (token) message = message.replaceAll(token, "[redacted]");
    throw new Error(`Vertex ${stage} failed: ${message}`, { cause: error });
  }
}
