const { Queue, Worker } = require('bullmq');
const config = require('../config');
const { transcodeAll } = require('../transcode');
const cache = require('../cache');

let queue = null;
let worker = null;

function getQueue() {
  if (!queue) {
    queue = new Queue(config.queueName, { connection: config.redis });
  }
  return queue;
}

function setQueue(q) {
  queue = q;
}

async function addTranscodeJob(data) {
  const q = getQueue();
  const job = await q.add('transcode', data, {
    jobId: data.uploadId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
  return job;
}

function startWorker() {
  worker = new Worker(
    config.queueName,
    async (job) => {
      const { inputPath, uploadId, fileHash } = job.data;

      await job.updateProgress(10);

      const outputs = await transcodeAll(inputPath, uploadId);

      await cache.setCachedOutputs(fileHash, outputs);
      await cache.releaseTranscodeLock(fileHash);

      await job.updateProgress(100);
      return outputs;
    },
    {
      connection: config.redis,
      concurrency: 2,
    },
  );

  worker.on('failed', async (job, err) => {
    if (job) {
      await cache.releaseTranscodeLock(job.data.fileHash).catch(() => {});
    }
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function shutdown() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

module.exports = { getQueue, setQueue, addTranscodeJob, startWorker, shutdown };
