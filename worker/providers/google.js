import fs from "node:fs/promises";
import { duration } from "../ffmpeg.js";

// Render: PROVIDER=google, GEMINI_API_KEY=<your key>.
// Optional: GOOGLE_MODEL, GOOGLE_PROMPT. No additional npm dependency.
const API = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-omni-1.1-flash";

export async function swapVideo({ videoPath, facePath, outPath, log = () => {} }) {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("Google: GEMINI_API_KEY is missing in Render");
  const seconds = await duration(videoPath);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) {
    throw new Error("Google Omni editing requires a clip of 10 seconds or less");
  }
  const sizes = await Promise.all([videoPath, facePath].map(p => fs.stat(p)));
  // Conservative limit for this inline-media adapter, including base64 overhead.
  if (sizes.reduce((n, s) => n + s.size, 0) > 14 * 1024 * 1024) {
    throw new Error("Google input is too large: reduce the segment or image size below 14 MB combined");
  }
  const [video, face] = await Promise.all([fs.readFile(videoPath), fs.readFile(facePath)]);
  const model = (process.env.GOOGLE_MODEL || MODEL).trim();
  const prompt = (process.env.GOOGLE_PROMPT || "").trim() ||
    "Edit the supplied video: replace the person's face with the face in the supplied reference image. " +
    "Use the image only as an identity reference, not as a starting frame. " +
    "Keep everything else the same, including duration, motion, clothing, lighting and camera framing.";
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  const headers = { "x-goog-api-key": key };
  let stage = "generation";
  let outputName;
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const detail = String(data.error?.message || response.statusText)
        .replaceAll(key, "[redacted]").slice(0, 400);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return response;
  }
  try {
    log(`google: ${model}, editing ${seconds.toFixed(2)}s`);
    const response = await request(`${API}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, background: false, store: true, stream: false,
        input: [{ type: "user_input", content: [
          { type: "video", mime_type: "video/mp4", data: video.toString("base64") },
          { type: "image", mime_type: "image/png", data: face.toString("base64") },
          { type: "text", text: prompt },
        ] }],
        response_format: { type: "video", delivery: "uri", resolution: "720p" },
      }),
    });
    const interaction = await response.json();
    const output = (interaction.steps || [])
      .filter(s => s.type === "model_output")
      .flatMap(s => s.content || [])
      .find(c => c.type === "video");
    if (!output) throw new Error("No video returned; check model access and Google's generation logs");
    if (output.data) {
      await fs.writeFile(outPath, Buffer.from(output.data, "base64"));
    } else {
      const uri = new URL(output.uri, `${API}/`);
      if (uri.origin !== new URL(API).origin) throw new Error("Unexpected Google output host");
      const match = uri.pathname.match(/\/files\/([a-zA-Z0-9_-]+)(?::download)?$/);
      if (!match) throw new Error("Unrecognized Google output file URI");
      outputName = `files/${match[1]}`;
      stage = "output processing";
      log("google: waiting for output video");
      while (true) {
        const file = await (await request(`${API}/${outputName}`)).json();
        if (file.state === "ACTIVE") break;
        if (file.state === "FAILED") throw new Error("Google could not process the output video");
        signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      stage = "download";
      const download = await request(`${API}/${outputName}:download?alt=media`);
      await fs.writeFile(outPath, Buffer.from(await download.arrayBuffer()));
    }
    log("google: video saved; returning to FFmpeg pipeline");
    return outPath;
  } catch (error) {
    const message = signal.aborted ? "Timed out after 15 minutes; check Google before retrying" : error.message;
    throw new Error(`Google ${stage} failed: ${message}`, { cause: error });
  } finally {
    if (outputName) {
      await fetch(`${API}/${outputName}`, {
        method: "DELETE", headers, signal: AbortSignal.timeout(10000),
      }).then(r => { if (!r.ok) log("google: output cleanup failed"); })
        .catch(() => log("google: output cleanup failed"));
    }
  }
}
