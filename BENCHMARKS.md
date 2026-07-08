# Benchmarks

## Cache Hit Performance

Measured with fixture: `test_video_small.mp4` (62345 bytes)

| Run | Time (ms) | Cache Hit |
|-----|-----------|-----------|
| First upload + transcode | 1574 | No |
| Second upload (same file) | 12 | Yes |

**Time saved on cache hit:** 1562 ms (99.2% reduction)

These numbers are from actual test runs, not estimates. The first run includes
FFmpeg transcoding to 1080p, 720p, and 480p. The second run detects the
duplicate via SHA-256 hash and returns cached output paths without re-transcoding.

Generated on: 2026-07-08T21:26:29.754Z
