# Design Decisions

## 1. Why chunked upload instead of a single multipart upload?

A single multipart upload buffers the entire file in memory (or at least
requires the server to receive the complete body before processing). For large
video files (1 GB+), this creates three problems:

**Memory footprint**: Express/multer multipart parsing holds the entire file
in memory or writes it to a temp file as one atomic operation. With chunked
uploads, each chunk is a small fixed-size piece (5 MB by default), so the
server's peak memory usage stays constant regardless of file size.

**Resumability**: If a network connection drops at 90% of a 2 GB upload, a
single multipart upload must restart from zero. With chunks, the client can
query `GET /upload/:id/status` to see which chunk indices were received, then
resume by re-sending only the missing ones. This is the same approach used by
services like YouTube, Google Drive, and Tus.

**Parallelism**: Chunks can be uploaded concurrently from the client side
(multiple HTTP requests in flight), which can saturate the available bandwidth
better than a single sequential stream on high-latency connections.

The tradeoff is added complexity — the server must track chunk state, handle
reassembly, and deal with the case where a client abandons an upload
mid-stream. In this implementation, each upload gets a UUID-named directory
and chunks are stored as numbered files (`chunk_0`, `chunk_1`, ...), then
concatenated in order during the `/complete` call.

## 2. Why BullMQ/Redis instead of an in-memory queue?

An in-memory queue (e.g., a plain array or `async-mutex`-guarded list) loses
all pending jobs when the process restarts. For transcoding, a single job can
take minutes. If the server crashes or deploys mid-transcode, every in-flight
and pending job is gone with no record they existed.

BullMQ on Redis provides:

- **Durability**: Jobs survive process restarts. When the worker comes back,
  it picks up where it left off.
- **Visibility**: You can inspect the queue (pending, active, completed,
  failed counts) without custom instrumentation.
- **Retry with backoff**: Failed jobs are retried automatically with
  configurable exponential backoff, rather than requiring the client to
  re-submit.
- **Horizontal scaling**: Multiple worker processes (or machines) can consume
  from the same Redis-backed queue. This is the natural path to scaling
  transcoding — add more workers. An in-memory queue is locked to a single
  process.
- **Rate limiting and concurrency control**: BullMQ supports per-worker
  concurrency limits, global rate limits, and job priorities out of the box.

The cost is a Redis dependency, which adds operational complexity. For a
service that already needs Redis for caching, this is a marginal cost.

## 3. How is the cache key derived, and what's the collision risk?

The cache key is the SHA-256 hash of the fully reassembled source file. After
chunks are concatenated, the complete file is streamed through
`crypto.createHash('sha256')` to produce a 256-bit digest.

**Collision risk**: SHA-256 has a 256-bit output space (2^256 possible hashes).
The birthday bound for a 50% collision probability is approximately 2^128
operations — roughly 3.4 × 10^38 files. For any practical corpus of video
files (even billions), the probability of two distinct files producing the same
hash is negligible. SHA-256 is also collision-resistant in the cryptographic
sense (no known practical attack produces collisions), unlike MD5 or SHA-1.

The cache stores a JSON manifest in Redis under the key
`transcode:cache:<sha256>`, mapping to an array of `{resolution, path}` objects.
On a cache lookup, we also verify that each output file still exists on disk —
if any file was deleted, the cache entry is treated as a miss.

## 4. Two requests for the same file arrive before the first transcode finishes — how do you avoid a duplicate/racing transcode job?

This is handled with a Redis-based distributed lock using `SET key NX EX`:

1. After reassembly, the server computes the file's SHA-256 hash.
2. It first checks the cache (`transcode:cache:<hash>`). If a completed
   transcode exists, it returns immediately (cache hit).
3. If no cache entry exists, it attempts to acquire a lock:
   `SET transcode:lock:<hash> 1 EX 600 NX`. The `NX` flag means "only set if
   not exists" — this is atomic in Redis.
4. If the lock is acquired, this request enqueues the transcode job.
5. If the lock fails (another request already holds it), this request enters
   a `waiting` state. The client polls `GET /status/:id`, which checks the
   cache on each poll. When the first transcode completes, it writes to the
   cache and releases the lock. The waiting request's next poll sees the cache
   entry and returns the result.

The lock has a 10-minute TTL as a safety net — if the worker crashes without
releasing the lock, it auto-expires and a subsequent request can retry. The
worker also releases the lock in its error handler to avoid unnecessary waits
on job failure.

This approach avoids both duplicate transcodes and a "thundering herd" problem
where N identical uploads all spawn N FFmpeg processes.

## 5. How would this extend to a distributed pool of transcode workers across machines?

The architecture already supports this because BullMQ's distribution model is
"shared nothing" between workers:

1. **Queue is centralized in Redis**: Any number of worker processes, on any
   machines, can connect to the same Redis instance and consume jobs. BullMQ
   handles job locking so two workers never process the same job.

2. **What needs to change for multiple machines**:
   - **Shared storage**: The current implementation stores uploaded files and
     transcoded outputs on the local filesystem. In a multi-machine setup,
     this would need to be a shared filesystem (NFS, EFS) or object storage
     (S3). The worker reads the input file path from the job payload and
     writes outputs to a path — swapping local paths for S3 keys is a
     localized change.
   - **Redis accessibility**: Redis must be network-accessible to all workers
     (not just localhost). In production, this would be a managed Redis
     instance (ElastiCache, etc.).
   - **Cache consistency**: The cache already lives in Redis, so it's
     automatically shared across workers. The file-existence check in
     `getCachedOutputs` would need to be adapted for remote storage (e.g.,
     an S3 HEAD request instead of `fs.existsSync`).

3. **Scaling strategy**: Start with vertical scaling (increase worker
   concurrency on a single machine). When CPU-bound FFmpeg jobs saturate one
   machine, add more worker machines pointing at the same Redis. BullMQ's
   built-in concurrency control (`concurrency: N` per worker) prevents any
   single machine from being overloaded.

4. **Monitoring**: BullMQ exposes queue metrics (active, waiting, completed,
   failed counts) that can be scraped for alerting. Bull Board is a drop-in
   admin UI for inspecting queue state in real time.
