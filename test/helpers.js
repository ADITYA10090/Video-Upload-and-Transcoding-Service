const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { ...headers },
    };

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      const json = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(json);
      const req = http.request(opts, handleResponse(resolve));
      req.on('error', reject);
      req.end(json);
    } else if (body instanceof Buffer) {
      opts.headers['content-type'] = 'application/octet-stream';
      opts.headers['content-length'] = body.length;
      const req = http.request(opts, handleResponse(resolve));
      req.on('error', reject);
      req.end(body);
    } else {
      const req = http.request(opts, handleResponse(resolve));
      req.on('error', reject);
      req.end();
    }
  });
}

function handleResponse(resolve) {
  return (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      resolve({ status: res.statusCode, body: parsed });
    });
  };
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

async function chunkedUpload(port, filePath, chunkSize) {
  const fileData = fs.readFileSync(filePath);
  const checksum = crypto.createHash('sha256').update(fileData).digest('hex');
  const totalChunks = Math.ceil(fileData.length / chunkSize);

  const initRes = await request(port, 'POST', '/upload/init', {
    totalChunks,
    checksum,
    fileName: path.basename(filePath),
  });

  if (initRes.status !== 200) throw new Error(`init failed: ${JSON.stringify(initRes.body)}`);
  const { uploadId } = initRes.body;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileData.length);
    const chunk = fileData.subarray(start, end);
    const chunkRes = await request(port, 'POST', `/upload/${uploadId}/chunk/${i}`, chunk);
    if (chunkRes.status !== 200) throw new Error(`chunk ${i} failed: ${JSON.stringify(chunkRes.body)}`);
  }

  const completeRes = await request(port, 'POST', `/upload/${uploadId}/complete`, {});
  return { uploadId, initRes, completeRes };
}

async function waitForCompletion(port, uploadId, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(port, 'GET', `/status/${uploadId}`);
    if (res.body.status === 'completed') return res.body;
    if (res.body.status === 'failed' || res.body.status === 'error') {
      throw new Error(`Job failed: ${res.body.error || 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for completion');
}

module.exports = { request, sha256, chunkedUpload, waitForCompletion };
