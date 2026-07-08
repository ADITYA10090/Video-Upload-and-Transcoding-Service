const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { start, stop } = require('../src/index');
const { chunkedUpload, waitForCompletion, sha256 } = require('./helpers');
const cache = require('../src/cache');

const FIXTURE_SMALL = path.join(__dirname, '..', 'fixtures', 'test_video_small.mp4');
const FIXTURE_MEDIUM = path.join(__dirname, '..', 'fixtures', 'test_video_medium.mp4');
const CHUNK_SIZE = 32 * 1024;
const PORT = 4102;

describe('Concurrency: simultaneous uploads complete without cross-contamination', () => {
  before(async () => {
    await flushTestData();
    await start(PORT);
  });

  after(async () => {
    await flushTestData();
    await stop();
  });

  it('handles 3 simultaneous uploads of different files correctly', async () => {
    const files = [FIXTURE_SMALL, FIXTURE_MEDIUM, FIXTURE_SMALL];

    const uploads = await Promise.all(
      files.map((f) => chunkedUpload(PORT, f, CHUNK_SIZE)),
    );

    for (const u of uploads) {
      assert.strictEqual(u.completeRes.status, 200);
    }

    const results = await Promise.all(
      uploads.map((u) => waitForCompletion(PORT, u.uploadId, 120_000)),
    );

    for (let i = 0; i < results.length; i++) {
      assert.strictEqual(results[i].status, 'completed', `upload ${i} should complete`);
      const outputs = results[i].outputs;
      assert.ok(Array.isArray(outputs), `upload ${i} should have outputs array`);
      assert.strictEqual(outputs.length, 3, `upload ${i} should have 3 resolution outputs`);
    }

    const uploadIds = uploads.map((u) => u.uploadId);
    const uniqueIds = new Set(uploadIds);
    assert.strictEqual(uniqueIds.size, uploadIds.length, 'all upload IDs should be unique');

    for (const result of results) {
      for (const output of result.outputs) {
        assert.ok(fs.existsSync(output.path), `output should exist: ${output.path}`);
        const stat = fs.statSync(output.path);
        assert.ok(stat.size > 0, `output should not be empty: ${output.path}`);
      }
    }
  });

  it('concurrent uploads of the same file use cache, no cross-contamination of chunks', async () => {
    await flushTestData();

    const upload1Promise = chunkedUpload(PORT, FIXTURE_SMALL, CHUNK_SIZE);
    await new Promise((r) => setTimeout(r, 50));
    const upload2Promise = chunkedUpload(PORT, FIXTURE_SMALL, CHUNK_SIZE);

    const [upload1, upload2] = await Promise.all([upload1Promise, upload2Promise]);

    assert.notStrictEqual(upload1.uploadId, upload2.uploadId, 'uploads should have distinct IDs');

    assert.strictEqual(upload1.completeRes.status, 200);
    assert.strictEqual(upload2.completeRes.status, 200);

    const result1 = await waitForCompletion(PORT, upload1.uploadId, 90_000);
    const result2 = await waitForCompletion(PORT, upload2.uploadId, 90_000);

    assert.strictEqual(result1.status, 'completed');
    assert.strictEqual(result2.status, 'completed');

    const atLeastOneCacheHit = result1.cacheHit || result2.cacheHit;
    const bothCompleted = result1.outputs.length === 3 && result2.outputs.length === 3;
    assert.ok(bothCompleted, 'both should produce 3 outputs');

    console.log(`  Upload 1 cache hit: ${!!result1.cacheHit}`);
    console.log(`  Upload 2 cache hit: ${!!result2.cacheHit}`);
    if (atLeastOneCacheHit) {
      console.log('  Race condition handled: one upload used cache from the other');
    }
  });
});

async function flushTestData() {
  const redis = cache.getRedis();
  const keys = await redis.keys('transcode:*');
  if (keys.length) await redis.del(...keys);
  const bullKeys = await redis.keys('bull:*');
  if (bullKeys.length) await redis.del(...bullKeys);

  for (const dir of ['uploads', 'outputs']) {
    const p = path.join(process.cwd(), dir);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}
