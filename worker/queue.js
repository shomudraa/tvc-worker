import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { runSwapJob } from "./pipeline.js";
import { sendReadyEmail } from "./notify.js";

/**
 * Two queue backends behind one interface:
 *   add(jobId, data) / get(jobId) -> { state, failedReason? }
 * QUEUE=memory (default) runs jobs in-process, one at a time. Good for local
 * testing. QUEUE=redis uses BullMQ and is what production runs.
 */
export async function createQueue() {
  if ((process.env.QUEUE || "memory") === "redis") return redisQueue();
  return memoryQueue();
}

/**
 * The selfie travels inside the job as base64, not as a path on disk. The
 * container that accepts the upload is not always the one that processes the
 * job (Render runs old and new containers together during a deploy, and both
 * share the same Redis), and disks are wiped on restart. Writing it out here
 * means whichever container picks the job up can always read it.
 */
async function materialiseFace(jobId, data) {
  if (data.facePath) return data.facePath; // jobs queued by an older build
  if (!data.faceB64) throw new Error("job has no selfie attached");
  await fs.mkdir(config.tmpDir, { recursive: true });
  const p = path.join(config.tmpDir, `${jobId}_face.png`);
  await fs.writeFile(p, Buffer.from(data.faceB64, "base64"));
  return p;
}

/** Shared job body, so both backends behave identically. */
async function processJob(jobId, data, log) {
  const facePath = await materialiseFace(jobId, data);
  const r = await runSwapJob({ jobId, facePath, log });
  if (data.email) {
    await sendReadyEmail({ to: data.email, jobId, log }).catch((e) => log(`email error: ${e.message}`));
  }
  return r;
}

function memoryQueue() {
  const jobs = new Map();
  let chain = Promise.resolve();
  return {
    kind: "memory",
    kv: new Map(),
    async add(jobId, data) {
      jobs.set(jobId, { state: "waiting", data, logs: [] });
      chain = chain.then(async () => {
        const j = jobs.get(jobId);
        const tag = String(jobId).slice(0, 8);
        const log = (m) => { console.log(`[${tag}] ${m}`); j.logs.push(m); };
        j.state = "active";
        try {
          const r = await processJob(jobId, data, log);
          j.state = "completed";
          j.timings = r.timings;
          console.log(`[${tag}] done`, JSON.stringify(r.timings));
        } catch (e) {
          console.error(`[${tag}] FAILED: ${e.message}`);
          j.state = "failed";
          j.failedReason = e.message;
        }
      });
    },
    async get(jobId) {
      return jobs.get(jobId) || null;
    },
    async getKV(k) { return this.kv.get(k) ?? null; },
    async setKV(k, v) { this.kv.set(k, v); },
    async delKV(k) { this.kv.delete(k); },
    async incrKV(k) { const v = Number(this.kv.get(k) || 0) + 1; this.kv.set(k, String(v)); return v; },
  };
}

async function redisQueue() {
  const { Queue, Worker } = await import("bullmq");
  const IORedis = (await import("ioredis")).default;
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("swap", { connection: redis });

  new Worker(
    "swap",
    async (job) => {
      const jobId = job.data.jobId || job.id;
      const tag = String(jobId).slice(0, 8);
      const log = (m) => {
        console.log(`[${tag}] ${m}`);
        job.log(m).catch(() => {});
      };
      try {
        const r = await processJob(jobId, job.data, log);
        console.log(`[${tag}] done`, JSON.stringify(r.timings));
        return r.timings;
      } catch (e) {
        console.error(`[${tag}] FAILED: ${e.message}`);
        throw e;
      }
    },
    { connection: redis, concurrency: Number(process.env.CONCURRENCY || 2) },
  );

  // Clear anything left over from a container that died mid-job. Those jobs can
  // never succeed and would otherwise fail noisily on every boot.
  try {
    const stale = await queue.getJobs(["waiting", "active", "delayed", "paused"]);
    for (const j of stale) await j.remove().catch(() => {});
    if (stale.length) console.log(`cleared ${stale.length} stale job(s) from a previous container`);
  } catch (e) {
    console.log(`stale job cleanup skipped: ${e.message}`);
  }

  return {
    kind: "redis",
    async add(jobId, data) {
      // attempts defaults to 1: a retry re-runs the whole job, including a
      // second paid generation call, so a failure must not double the bill.
      await queue.add("swap", { jobId, ...data }, {
        jobId,
        removeOnComplete: 1000,
        removeOnFail: 1000,
        attempts: Number(process.env.JOB_ATTEMPTS || 1),
      });
    },
    async get(jobId) {
      const j = await queue.getJob(jobId);
      if (!j) return null;
      return { state: await j.getState(), failedReason: j.failedReason };
    },
    async getKV(k) { return redis.get(k); },
    async setKV(k, v, ttl) { return ttl ? redis.set(k, v, "EX", ttl) : redis.set(k, v); },
    async delKV(k) { return redis.del(k); },
    async incrKV(k, ttl) { const v = await redis.incr(k); if (ttl) await redis.expire(k, ttl); return v; },
  };
}
