const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const cache = require('../cache');
const { addTranscodeJob, getQueue } = require('../queue');

const router = express.Router();

const uploads = new Map();

function getUploadChunkDir(uploadId) {
  return path.join(config.uploadDir, uploadId, 'chunks');
}

function getAssembledPath(uploadId) {
  return path.join(config.uploadDir, uploadId, 'assembled.mp4');
}

router.post('/upload/init', express.json(), (req, res) => {
  const uploadId = uuidv4();
  const totalChunks = req.body.totalChunks;
  const checksum = req.body.checksum;
  const fileName = req.body.fileName || 'video.mp4';

  if (!totalChunks || totalChunks < 1) {
    return res.status(400).json({ error: 'totalChunks is required and must be >= 1' });
  }

  const chunkDir = getUploadChunkDir(uploadId);
  fs.mkdirSync(chunkDir, { recursive: true });

  uploads.set(uploadId, {
    totalChunks,
    checksum: checksum || null,
    fileName,
    receivedChunks: new Set(),
    status: 'uploading',
    createdAt: Date.now(),
  });

  res.json({ uploadId, totalChunks });
});

router.get('/upload/:id/status', (req, res) => {
  const upload = uploads.get(req.params.id);
  if (!upload) return res.status(404).json({ error: 'upload not found' });

  res.json({
    uploadId: req.params.id,
    status: upload.status,
    totalChunks: upload.totalChunks,
    receivedChunks: Array.from(upload.receivedChunks).sort((a, b) => a - b),
    missingChunks: getMissingChunks(upload),
  });
});

function getMissingChunks(upload) {
  const missing = [];
  for (let i = 0; i < upload.totalChunks; i++) {
    if (!upload.receivedChunks.has(i)) missing.push(i);
  }
  return missing;
}

router.post('/upload/:id/chunk/:index', (req, res) => {
  const { id, index } = req.params;
  const chunkIndex = parseInt(index, 10);
  const upload = uploads.get(id);

  if (!upload) return res.status(404).json({ error: 'upload not found' });
  if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.totalChunks) {
    return res.status(400).json({ error: 'invalid chunk index' });
  }
  if (upload.status !== 'uploading') {
    return res.status(409).json({ error: 'upload is not in uploading state' });
  }

  const chunkPath = path.join(getUploadChunkDir(id), `chunk_${chunkIndex}`);
  const writeStream = fs.createWriteStream(chunkPath);

  req.pipe(writeStream);
  writeStream.on('finish', () => {
    upload.receivedChunks.add(chunkIndex);
    res.json({ uploadId: id, chunkIndex, received: true });
  });
  writeStream.on('error', (err) => {
    res.status(500).json({ error: 'failed to write chunk', details: err.message });
  });
});

router.post('/upload/:id/complete', express.json(), async (req, res) => {
  const { id } = req.params;
  const upload = uploads.get(id);

  if (!upload) return res.status(404).json({ error: 'upload not found' });
  if (upload.status !== 'uploading') {
    return res.status(409).json({ error: 'upload is not in uploading state' });
  }

  const missing = getMissingChunks(upload);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'missing chunks',
      missingChunks: missing,
    });
  }

  upload.status = 'assembling';

  try {
    const assembledPath = getAssembledPath(id);
    const writeStream = fs.createWriteStream(assembledPath);

    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(getUploadChunkDir(id), `chunk_${i}`);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    if (upload.checksum) {
      const actualHash = await computeSha256(assembledPath);
      if (actualHash !== upload.checksum) {
        upload.status = 'checksum_mismatch';
        return res.status(400).json({
          error: 'checksum mismatch',
          expected: upload.checksum,
          actual: actualHash,
        });
      }
    }

    const fileHash = await cache.hashFile(assembledPath);
    const cached = await cache.getCachedOutputs(fileHash);

    if (cached) {
      upload.status = 'completed';
      upload.outputs = cached;
      upload.cacheHit = true;
      return res.json({
        uploadId: id,
        status: 'completed',
        cacheHit: true,
        outputs: cached,
      });
    }

    const gotLock = await cache.acquireTranscodeLock(fileHash);

    if (!gotLock) {
      upload.status = 'waiting';
      upload.fileHash = fileHash;
      return res.json({
        uploadId: id,
        status: 'waiting',
        message: 'identical file is already being transcoded, waiting for result',
      });
    }

    upload.status = 'queued';
    upload.fileHash = fileHash;

    const job = await addTranscodeJob({
      uploadId: id,
      inputPath: assembledPath,
      fileHash,
    });

    upload.jobId = job.id;

    res.json({ uploadId: id, status: 'queued', jobId: job.id });
  } catch (err) {
    upload.status = 'error';
    upload.error = err.message;
    res.status(500).json({ error: 'assembly failed', details: err.message });
  }
});

function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

router.get('/status/:id', async (req, res) => {
  const upload = uploads.get(req.params.id);
  if (!upload) return res.status(404).json({ error: 'upload not found' });

  if (upload.status === 'queued' && upload.jobId) {
    try {
      const q = getQueue();
      const job = await q.getJob(upload.jobId);
      if (job) {
        const state = await job.getState();
        if (state === 'completed') {
          upload.status = 'completed';
          upload.outputs = job.returnvalue;
        } else if (state === 'failed') {
          upload.status = 'failed';
          upload.error = job.failedReason;
        }
      }
    } catch {}
  }

  if (upload.status === 'waiting' && upload.fileHash) {
    try {
      const cached = await cache.getCachedOutputs(upload.fileHash);
      if (cached) {
        upload.status = 'completed';
        upload.outputs = cached;
        upload.cacheHit = true;
      }
    } catch {}
  }

  const response = {
    uploadId: req.params.id,
    status: upload.status,
  };

  if (upload.outputs) response.outputs = upload.outputs;
  if (upload.cacheHit) response.cacheHit = true;
  if (upload.error) response.error = upload.error;
  if (upload.jobId) response.jobId = upload.jobId;

  res.json(response);
});

router.getUploads = () => uploads;

module.exports = router;
