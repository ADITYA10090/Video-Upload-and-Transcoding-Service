# Video Upload & Transcoding Service

A Node.js service that handles chunked video uploads and transcodes them into
multiple resolutions using FFmpeg, with a Redis-backed job queue (BullMQ) and
a SHA-256 caching layer to skip duplicate transcodes.

## Prerequisites

- **Node.js** >= 20
- **Redis** >= 6 (running on localhost:6379 by default)
- **FFmpeg** and **ffprobe** installed and on PATH

## Setup

```bash
npm install
```

## Generate Test Fixtures

Creates small synthetic test videos using FFmpeg's `testsrc` filter:

```bash
npm run generate-fixtures
```

## Run the Service

```bash
npm start
```

The server starts on port 3000 (override with `PORT` env var).

## API

### `POST /upload/init`

Initialize a chunked upload.

```json
{
  "totalChunks": 4,
  "checksum": "<sha256 of complete file, optional>",
  "fileName": "video.mp4"
}
```

Returns `{ "uploadId": "...", "totalChunks": 4 }`.

### `POST /upload/:id/chunk/:index`

Upload a single chunk. Send raw bytes as the request body.
Chunks can be uploaded in any order and re-uploaded to resume a failed upload.

### `GET /upload/:id/status`

Check which chunks have been received and which are missing. Use this to
resume a partial upload — re-send only the missing chunks.

### `POST /upload/:id/complete`

Reassemble chunks, verify the checksum (if provided), and enqueue a transcode
job. If the file has already been transcoded (cache hit), returns immediately
with the cached output paths.

### `GET /status/:id`

Poll for transcoding progress. Returns `queued`, `waiting`, `completed`, or
`failed`, along with output file paths on completion.

## Run Tests

All tests require Redis running locally.

```bash
# All tests
npm test

# Individual suites
npm run test:integration   # Full upload → transcode → verify pipeline
npm run test:cache         # Cache hit validation + timing benchmark
npm run test:concurrency   # Simultaneous uploads without cross-contamination
```

The cache test writes measured timing results to `BENCHMARKS.md`.

## Configuration

Environment variables:

| Variable     | Default              | Description                    |
|-------------|----------------------|--------------------------------|
| `PORT`      | `3000`               | HTTP server port               |
| `REDIS_HOST`| `127.0.0.1`          | Redis host                     |
| `REDIS_PORT`| `6379`               | Redis port                     |
| `UPLOAD_DIR`| `./uploads`          | Chunk and assembled file storage |
| `OUTPUT_DIR`| `./outputs`          | Transcoded output storage      |
