import { config } from "./config.js";
import { runSwapJob } from "./pipeline.js";
import { sendReadyEmail } from "./notify.js";

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
  return {
    kind: "redis",
    async add(jobId, data) {
      await queue.add("swap", { jobId, ...data }, { jobId, removeOnComplete: 1000, removeOnFail: 1000, attempts: 2 });
    },
    async get(jobId) {
      const j = await queue.getJob(jobId);
      return j ? { state: await j.getState() } : null;
    },
    async getKV(k) { return redis.get(k); },
    async setKV(k, v, ttl) { return ttl ? redis.set(k, v, "EX", ttl) : redis.set(k, v); },
    async delKV(k) { return redis.del(k); },
    async incrKV(k, ttl) { const v = await redis.incr(k); if (ttl) await redis.expire(k, ttl); return v; },
  };
}
