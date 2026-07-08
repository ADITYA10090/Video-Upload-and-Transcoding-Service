const express = require('express');
const fs = require('fs');
const config = require('./config');
const uploadRouter = require('./routes/upload');
const { startWorker, shutdown: shutdownQueue } = require('./queue');
const { shutdown: shutdownCache } = require('./cache');

const app = express();

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

app.use(uploadRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

let server;

function start(port) {
  const p = port || config.port;
  startWorker();
  return new Promise((resolve) => {
    server = app.listen(p, () => {
      console.log(`Server listening on port ${p}`);
      resolve(server);
    });
  });
}

async function stop() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await shutdownQueue();
  await shutdownCache();
}

if (require.main === module) {
  start();
}

module.exports = { app, start, stop };
