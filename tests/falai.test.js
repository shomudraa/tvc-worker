import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let uploads = [], requests = [], rejectUpload = false;
mock.module("../worker/ffmpeg.js", { namedExports: {
  duration: async () => 3,
  ffmpeg: async (args) => fs.writeFile(args.at(-1), "wav bytes"),
} });
mock.module("@fal-ai/client", { namedExports: {
  createFalClient: ({ credentials }) => {
    assert.equal(credentials, "test-only-key");
    return {
      storage: { upload: async (blob) => {
        uploads.push(blob.type);
        if (rejectUpload) throw new Error("No user found for Key ID and Secret");
        return `https://example.test/ref/${blob.type}`;
      } },
      subscribe: async (model, options) => {
        requests.push({ model, input: options.input });
        return { data: { video: { url: "https://example.test/output.mp4" } } };
      },
    };
  },
} });
const { settings, referenceInput, falError, swapVideo, MODEL, DEFAULT_PROMPT } = await import("../worker/providers/falai.js");
const { getProvider } = await import("../worker/providers/index.js");

test("approved prompt and generation settings are preserved", () => {
  const input = referenceInput(3, settings({}), { imageUrl: "image", videoUrl: "video", audioUrl: "audio" });
  assert.equal(input.prompt, DEFAULT_PROMPT);
  assert.equal(input.duration, 5);
  assert.equal(input.resolution, "2K");
  assert.equal(input.aspect_ratio, "adaptive");
  assert.deepEqual(input.reference_audio_urls, ["audio"]);
  assert.equal(referenceInput(10, settings({}), { imageUrl: "image" }).duration, 10);
});
test("stale model settings are ignored and unsupported references are rejected", () => {
  assert.deepEqual(settings({ FAL_MODEL: "minimax/h3-max/reference-to-video" }), settings({}));
  assert.throws(() => settings({ FAL_RESOLUTION: "1080P" }));
  assert.throws(() => referenceInput(16, settings({}), { imageUrl: "image", videoUrl: "video" }), /2–15 seconds/);
  assert.throws(() => referenceInput(10, settings({}), {}), /Selfie reference is required/);
  assert.throws(() => getProvider("higgsfield"));
  assert.equal(getProvider().swapVideo, swapVideo);
});
test("approved prompt overrides stale deployment prompts while preserving aspect", () => {
  const options = settings({ FAL_PROMPT: "stale", HF_PROMPT: "custom", HF_ASPECT_RATIO: "auto", HF_AUDIO_REF: "0" });
  assert.equal(options.prompt, DEFAULT_PROMPT);
  assert.equal(options.aspect_ratio, "adaptive");
  assert.equal(options.audioRef, false);
  const input = referenceInput(10, options, { imageUrl: "selfie" });
  assert.equal(input.prompt, DEFAULT_PROMPT);
});
test("authentication failures identify the server key", () => {
  assert.match(falError(new Error("No user found for Key ID and Secret")), /Check FAL_KEY/);
  assert.match(falError({ status: 401 }), /authentication failed/);
});
test("adapter uploads correct types, sends audio, downloads, and cleans failed uploads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fal-adapter-"));
  const oldKey = process.env.FAL_KEY;
  const oldModel = process.env.FAL_MODEL;
  process.env.FAL_MODEL = "minimax/h3-max/reference-to-video";
  process.env.FAL_KEY = "test-only-key";
  mock.method(globalThis, "fetch", async () => new Response("video bytes"));
  try {
    const facePath = path.join(dir, "face.png"), videoPath = path.join(dir, "segment.mp4"), outPath = path.join(dir, "output.mp4");
    await fs.writeFile(facePath, "png bytes"); await fs.writeFile(videoPath, "mp4 bytes");
    const args = { facePath, videoPath, outPath, start: 26, end: 29 };
    await swapVideo(args);
    assert.deepEqual(uploads.sort(), ["audio/wav", "image/png", "video/mp4"]);
    assert.equal(requests[0].model, "minimax/h3/reference-to-video");
    assert.equal(requests[0].input.resolution, "2K");
    assert.equal(requests[0].input.prompt_expansion_mode, "disabled");
    assert.deepEqual(requests[0].input.reference_image_urls, ["https://example.test/ref/image/png"]);
    assert.deepEqual(requests[0].input.reference_video_urls, ["https://example.test/ref/video/mp4"]);
    assert.equal(requests[0].input.prompt, DEFAULT_PROMPT);
    assert.equal(requests[0].input.duration, 5);
    assert.equal(requests[0].input.reference_audio_urls.length, 1);
    assert.equal(await fs.readFile(outPath, "utf8"), "video bytes");
    assert.equal((await fs.readdir(dir)).some(x => x.endsWith(".wav")), false);
    rejectUpload = true;
    await assert.rejects(swapVideo(args), /Check FAL_KEY/);
    assert.equal(requests.length, 1);
    assert.equal((await fs.readdir(dir)).some(x => x.endsWith(".wav")), false);
  } finally {
    if (oldKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = oldKey;
    if (oldModel === undefined) delete process.env.FAL_MODEL; else process.env.FAL_MODEL = oldModel;
    mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true });
  }
});
