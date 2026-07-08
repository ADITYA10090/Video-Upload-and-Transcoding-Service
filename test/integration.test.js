const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { start, stop } = require('../src/index');
const { probeResolution } = require('../src/transcode');
const { request, chunkedUpload, waitForCompletion, sha256 } = require('./helpers');
const cache = require('../src/cache');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'test_video_small.mp4');
const CHUNK_SIZE = 32 * 1024; // 32 KB for testing
const PORT = 4100;

describe('Integration: chunked upload → reassembly → transcode → verify', () => {
  before(async () => {
    await flushTestData();
    await start(PORT);
  });

  after(async () => {
    await flushTestData();
    await stop();
  });

  it('uploads a video in chunks, transcodes to 3 resolutions, and produces valid outputs', async () => {
    const { uploadId, completeRes } = await chunkedUpload(PORT, FIXTURE, CHUNK_SIZE);

    assert.strictEqual(completeRes.status, 200);
    const status = completeRes.body.status;
    assert.ok(status === 'queued' || status === 'completed', `expected queued or completed, got ${status}`);

    const result = await waitForCompletion(PORT, uploadId, 90_000);
    assert.strictEqual(result.status, 'completed');
    assert.ok(Array.isArray(result.outputs));
    assert.strictEqual(result.outputs.length, 3);

    const expectedResolutions = {
      '1080p': { width: 1920, height: 1080 },
      '720p':  { width: 1280, height: 720 },
      '480p':  { width: 854,  height: 480 },
    };

    for (const output of result.outputs) {
      assert.ok(fs.existsSync(output.path), `output file missing: ${output.path}`);
      const stat = fs.statSync(output.path);
      assert.ok(stat.size > 0, `output file is empty: ${output.path}`);

      const res = await probeResolution(output.path);
      const expected = expectedResolutions[output.resolution];
      assert.ok(expected, `unexpected resolution label: ${output.resolution}`);
      assert.strictEqual(res.width, expected.width, `${output.resolution} width mismatch`);
      assert.strictEqual(res.height, expected.height, `${output.resolution} height mismatch`);
    }
  });

  it('rejects /complete when chunks are missing', async () => {
    const initRes = await request(PORT, 'POST', '/upload/init', {
      totalChunks: 3,
      fileName: 'test.mp4',
    });
    const { uploadId } = initRes.body;

    const chunk = Buffer.from('test data');
    await request(PORT, 'POST', `/upload/${uploadId}/chunk/0`, chunk);

    const completeRes = await request(PORT, 'POST', `/upload/${uploadId}/complete`, {});
    assert.strictEqual(completeRes.status, 400);
    assert.deepStrictEqual(completeRes.body.missingChunks, [1, 2]);
  });

  it('verifies checksum and rejects mismatched uploads', async () => {
    const initRes = await request(PORT, 'POST', '/upload/init', {
      totalChunks: 1,
      checksum: 'deadbeef',
      fileName: 'test.mp4',
    });
    const { uploadId } = initRes.body;

    const chunk = Buffer.from('some video data');
    await request(PORT, 'POST', `/upload/${uploadId}/chunk/0`, chunk);

    const completeRes = await request(PORT, 'POST', `/upload/${uploadId}/complete`, {});
    assert.strictEqual(completeRes.status, 400);
    assert.strictEqual(completeRes.body.error, 'checksum mismatch');
  });

  it('supports resuming a partial upload', async () => {
    const fileData = fs.readFileSync(FIXTURE);
    const checksum = sha256(FIXTURE);
    const totalChunks = Math.ceil(fileData.length / CHUNK_SIZE);

    const initRes = await request(PORT, 'POST', '/upload/init', {
      totalChunks,
      checksum,
      fileName: 'resume_test.mp4',
    });
    const { uploadId } = initRes.body;

    const halfChunks = Math.floor(totalChunks / 2);
    for (let i = 0; i < halfChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileData.length);
      await request(PORT, 'POST', `/upload/${uploadId}/chunk/${i}`, fileData.subarray(start, end));
    }

    const statusRes = await request(PORT, 'GET', `/upload/${uploadId}/status`);
    assert.strictEqual(statusRes.body.receivedChunks.length, halfChunks);
    const missing = statusRes.body.missingChunks;
    assert.ok(missing.length > 0);

    for (const idx of missing) {
      const start = idx * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileData.length);
      await request(PORT, 'POST', `/upload/${uploadId}/chunk/${idx}`, fileData.subarray(start, end));
    }

    const completeRes = await request(PORT, 'POST', `/upload/${uploadId}/complete`, {});
    assert.strictEqual(completeRes.status, 200);

    const result = await waitForCompletion(PORT, uploadId, 90_000);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.outputs.length, 3);
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
