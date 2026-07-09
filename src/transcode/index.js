const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function transcodeToResolution(inputPath, outputPath, resolution) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vf', `scale=${resolution.width}:${resolution.height}`,
      '-b:v', resolution.bitrate,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-y',
      outputPath,
    ];
    execFile('ffmpeg', args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed for ${resolution.name}: ${err.message}\n${stderr}`));
      resolve(outputPath);
    });
  });
}

async function transcodeAll(inputPath, uploadId) {
  const outputBase = path.join(config.outputDir, uploadId);
  ensureDir(outputBase);

  const outputs = [];
  for (const res of config.resolutions) {
    const outputPath = path.join(outputBase, `${res.name}.mp4`);
    await transcodeToResolution(inputPath, outputPath, res);
    outputs.push({ resolution: res.name, path: outputPath });
  }
  return outputs;
}

function probeResolution(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath,
    ];
    execFile('ffprobe', args, (err, stdout) => {
      if (err) return reject(err);
      const data = JSON.parse(stdout);
      const stream = data.streams && data.streams[0];
      if (!stream) return reject(new Error('no video stream found'));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

module.exports = { transcodeAll, transcodeToResolution, probeResolution };
