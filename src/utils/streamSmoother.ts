/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * streamSmoother.ts: Transform stream that smooths bursty data delivery from puppeteer-stream's WebSocket capture pipeline.
 */
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

/* puppeteer-stream delivers captured video data via WebSocket from Chrome's MediaRecorder extension. The default 20ms timeslice causes 50 micro-bursts per second,
 * and the library's WebSocket handler has no backpressure control — it calls stream.write() without checking the return value. This creates irregular, bursty delivery
 * that causes frame pacing issues downstream.
 *
 * This Transform stream absorbs those bursts into an internal buffer and drains them at a consistent interval, converting bursty delivery into smooth, evenly-paced
 * output. The drain interval and buffer size are tuned for real-time video streaming: fast enough to maintain low latency, but buffered enough to absorb jitter.
 */

/**
 * Creates a Transform stream that smooths bursty input data into evenly-paced output. Incoming chunks are queued internally and drained at a fixed interval,
 * converting puppeteer-stream's irregular WebSocket delivery into consistent output for FFmpeg.
 *
 * @param drainIntervalMs - How often to flush buffered data downstream (default: 50ms = 20 flushes/sec).
 * @returns A Transform stream that can be placed between the capture stream and FFmpeg stdin.
 */
export function createStreamSmoother(drainIntervalMs = 50): Transform {

  const pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const smoother = new Transform({

    // Match puppeteer-stream's default highWaterMark (8 MB) for consistent backpressure behavior.
    highWaterMark: 8 * 1024 * 1024,

    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {

      if(destroyed) {

        callback();

        return;
      }

      pendingChunks.push(chunk);
      pendingBytes += chunk.length;

      // Start the drain timer on first data arrival.
      if(!drainTimer) {

        drainTimer = setInterval(() => {

          drainPending();
        }, drainIntervalMs);

        // Ensure the timer doesn't prevent Node.js from exiting.
        drainTimer.unref();
      }

      callback();
    },

    flush(callback: TransformCallback): void {

      // Final flush: push all remaining data.
      drainPending();
      stopTimer();
      callback();
    }
  });

  /**
   * Pushes all pending chunks downstream as a single concatenated buffer. Batching reduces the number of write() calls to FFmpeg's stdin, which reduces system call
   * overhead and improves throughput.
   */
  function drainPending(): void {

    if(pendingChunks.length === 0 || destroyed) {

      return;
    }

    const batch = (pendingChunks.length === 1) ? pendingChunks[0] : Buffer.concat(pendingChunks, pendingBytes);

    pendingChunks.length = 0;
    pendingBytes = 0;

    smoother.push(batch);
  }

  function stopTimer(): void {

    if(drainTimer) {

      clearInterval(drainTimer);
      drainTimer = null;
    }
  }

  smoother.on("close", () => {

    destroyed = true;
    stopTimer();
    pendingChunks.length = 0;
    pendingBytes = 0;
  });

  return smoother;
}
