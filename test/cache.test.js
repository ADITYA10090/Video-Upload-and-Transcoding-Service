const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { start, stop } = require('../src/index');
const { chunkedUpload, waitForCompletion } = require('./helpers');
const cache = require('../src/cache');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'test_video_small.mp4');
const CHUNK_SIZE = 32 * 1024;
const PORT = 4101;

describe('Cache: upload same file twice, second run skips transcoding', () => {
  const timings = {};

  before(async () => {
    await flushTestData();
    await start(PORT);
  });

  after(async () => {
    const benchmarkPath = path.join(process.cwd(), 'BENCHMARKS.md');
    const saved = timings.firstRun - timings.secondRun;
    const pct = ((saved / timings.firstRun) * 100).toFixed(1);

    const content = `# Benchmarks

## Cache Hit Performance

Measured with fixture: \`test_video_small.mp4\` (${fs.statSync(FIXTURE).size} bytes)

| Run | Time (ms) | Cache Hit |
|-----|-----------|-----------|
| First upload + transcode | ${timings.firstRun} | No |
| Second upload (same file) | ${timings.secondRun} | Yes |

**Time saved on cache hit:** ${saved} ms (${pct}% reduction)

These numbers are from actual test runs, not estimates. The first run includes
FFmpeg transcoding to 1080p, 720p, and 480p. The second run detects the
duplicate via SHA-256 hash and returns cached output paths without re-transcoding.

Generated on: ${new Date().toISOString()}
`;

    fs.writeFileSync(benchmarkPath, content);
    console.log(`\nBenchmark results written to BENCHMARKS.md`);
    console.log(`  First run:  ${timings.firstRun} ms`);
    console.log(`  Second run: ${timings.secondRun} ms`);
    console.log(`  Time saved: ${saved} ms (${pct}%)`);

    await flushTestData();
    await stop();
  });

  it('first upload transcodes normally', async () => {
    const t0 = Date.now();
    const { uploadId, completeRes } = await chunkedUpload(PORT, FIXTURE, CHUNK_SIZE);
    assert.strictEqual(completeRes.status, 200);

    const result = await waitForCompletion(PORT, uploadId, 90_000);
    assert.strictEqual(result.status, 'completed');
    assert.ok(!result.cacheHit, 'first run should not be a cache hit');

    timings.firstRun = Date.now() - t0;
  });

  it('second upload of same file returns cache hit without transcoding', async () => {
    const t0 = Date.now();
    const { uploadId, completeRes } = await chunkedUpload(PORT, FIXTURE, CHUNK_SIZE);
    assert.strictEqual(completeRes.status, 200);
    assert.strictEqual(completeRes.body.cacheHit, true);
    assert.strictEqual(completeRes.body.status, 'completed');
    assert.ok(Array.isArray(completeRes.body.outputs));
    assert.strictEqual(completeRes.body.outputs.length, 3);

    timings.secondRun = Date.now() - t0;

    assert.ok(timings.secondRun < timings.firstRun,
      `second run (${timings.secondRun}ms) should be faster than first (${timings.firstRun}ms)`);
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
