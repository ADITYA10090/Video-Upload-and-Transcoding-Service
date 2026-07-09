const crypto = require('crypto');
const fs = require('fs');
const Redis = require('ioredis');
const config = require('../config');

const CACHE_PREFIX = 'transcode:cache:';
const LOCK_PREFIX = 'transcode:lock:';
const LOCK_TTL_SECONDS = 600; // 10 min — long enough for a transcode

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis(config.redis);
  }
  return redis;
}

function setRedis(client) {
  redis = client;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function getCachedOutputs(fileHash) {
  const r = getRedis();
  const raw = await r.get(`${CACHE_PREFIX}${fileHash}`);
  if (!raw) return null;
  const outputs = JSON.parse(raw);
  for (const entry of outputs) {
    if (!fs.existsSync(entry.path)) return null;
  }
  return outputs;
}

async function setCachedOutputs(fileHash, outputs) {
  const r = getRedis();
  await r.set(`${CACHE_PREFIX}${fileHash}`, JSON.stringify(outputs));
}

async function acquireTranscodeLock(fileHash) {
  const r = getRedis();
  const key = `${LOCK_PREFIX}${fileHash}`;
  const result = await r.set(key, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  return result === 'OK';
}

async function releaseTranscodeLock(fileHash) {
  const r = getRedis();
  await r.del(`${LOCK_PREFIX}${fileHash}`);
}

async function shutdown() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  hashFile,
  getCachedOutputs,
  setCachedOutputs,
  acquireTranscodeLock,
  releaseTranscodeLock,
  getRedis,
  setRedis,
  shutdown,
};
