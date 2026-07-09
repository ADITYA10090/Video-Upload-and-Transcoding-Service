const path = require('path');

const config = {
  port: process.env.PORT || 3000,
  uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'),
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), 'outputs'),
  chunkSize: 5 * 1024 * 1024, // 5 MB
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  },
  resolutions: [
    { name: '1080p', width: 1920, height: 1080, bitrate: '5000k' },
    { name: '720p',  width: 1280, height: 720,  bitrate: '2500k' },
    { name: '480p',  width: 854,  height: 480,  bitrate: '1000k' },
  ],
  queueName: 'transcode',
};

module.exports = config;
