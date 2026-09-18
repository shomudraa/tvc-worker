import { config } from "./config.js";
import { runSwapJob } from "./pipeline.js";
import { sendReadyEmail } from "./notify.js";
import fs from "node:fs/promises";
import path from "node:path";

/** Write the job's selfie to this container's disk so the pipeline can read it. */
async function materialiseFace(jobId, data) {
  if (data.facePath) return data.facePath;           // legacy jobs
  await fs.mkdir(config.tmpDir, { recursive: true });
  const p = path.join(config.tmpDir, `${jobId}_face.png`);
  await fs.writeFile(p, Buffer.from(data.faceB64, "base64"));
  return p;
}

/**
 * Two queue backends with one interface:
 *   add(jobId, data) / get(jobId) -> {state:'waiting'|'active'|'completed'|'failed'}
 * QUEUE=memory (default for local testing) runs jobs in-process, one at a time.
 * QUEUE=redis uses BullMQ (set REDIS_URL). Production should use redis.
 */
export async function createQueue() {
  if ((process.env.QUEUE || "memory") === "redis") return redisQueue();
  return memoryQueue();
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
        j.state = "active";
        try {
          const r = await runSwapJob({ jobId, facePath: data.facePath, log: (m) => j.logs.push(m) });
          j.state = "completed";
          j.timings = r.timings;
        } catch (e) {
          console.error("job failed", jobId, e);
          j.state = "failed";
        }
      });
    },
    async get(jobId) {
      return jobs.get(jobId) || null;
    },
    async getKV(k) { return this.kv.get(k) ?? null; },
    async setKV(k, v) { this.kv.set(k, v); },
    async delKV(k) { this.kv.delete(k); },
    async incrKV(k) { const v = (Number(this.kv.get(k) || 0) + 1); this.kv.set(k, String(v)); return v; },
  };
}

async function redisQueue() {
  const { Queue, Worker } = await import("bullmq");
  const IORedis = (await import("ioredis")).default;
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("swap", { connection: redis });
  new Worker(
    "swap",
    async (job) => (await runSwapJob({ jobId: job.data.jobId, facePath: job.data.facePath, log: (m) => job.log(m) })).timings,
    { connection: redis, concurrency: Number(process.env.CONCURRENCY || 2) },
  );
  // Jobs live in Redis but the uploaded selfie lives on the container's disk,
  // which Render wipes on every restart. Any job still queued or running when
  // the container went down can never succeed, so clear those on boot instead
  // of letting them fail with "no such file or directory".
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
      // attempts: 1 by default. A retry re-runs the whole job, including a
      // second paid generation call, so failures must not silently double the
      // bill. Raise JOB_ATTEMPTS only if the provider is free.
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
