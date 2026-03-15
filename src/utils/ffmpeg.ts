/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg.ts: FFmpeg process management for WebM to fMP4 transcoding.
 */
import type { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { LOG } from "./logger.js";
import type { Nullable } from "../types/index.js";
import { existsSync } from "node:fs";
import ffmpegForHomebridge from "ffmpeg-for-homebridge";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// The ffmpeg-for-homebridge package has incorrect type definitions (declares named export but JS uses default export). Cast to the correct type.
const ffmpegPath = ffmpegForHomebridge as unknown as string | undefined;

/* When using WebM capture mode, Chrome's MediaRecorder outputs WebM container with H264 video and Opus audio. For HLS compatibility, we need fMP4 container with
 * H264 video and AAC audio. FFmpeg handles this conversion:
 *
 * - Video: Passed through unchanged (copy codec) - no quality loss, minimal CPU
 * - Audio: Transcoded from Opus to AAC - lightweight operation
 * - Container: Converted from WebM to fragmented MP4 with streaming-friendly flags
 *
 * The FFmpeg process runs for the lifetime of the stream, reading WebM from stdin and writing fMP4 to stdout. This output feeds directly into the existing fMP4
 * segmenter.
 */

/* FFmpeg can be located in several places depending on how it was installed. We check in order of preference:
 * 1. Channels DVR bundled FFmpeg:
 *    - macOS: ~/Library/Application Support/ChannelsDVR/latest/ffmpeg
 *    - Windows: C:\ProgramData\channelsdvr\latest\ffmpeg.exe
 *    - Linux: ~/channels-dvr/latest/ffmpeg, /usr/local/channels-dvr/latest/ffmpeg, /opt/channels-dvr/latest/ffmpeg
 * 2. Bundled FFmpeg from ffmpeg-for-homebridge package
 * 3. System PATH (standard installation via package manager or manual install)
 *
 * The resolved path is cached after the first successful lookup to avoid repeated filesystem checks.
 */

// Cached FFmpeg path after resolution. Null means not yet resolved, undefined means not found.
let cachedFFmpegPath: Nullable<string> | undefined = null;


/**
 * Checks if FFmpeg exists at a specific path by attempting to run it.
 * @param pathToCheck - Full path to the FFmpeg executable.
 * @returns Promise resolving to true if FFmpeg runs successfully at this path.
 */
async function checkFFmpegAtPath(pathToCheck: string): Promise<boolean> {

  return new Promise((resolve) => {

    const ffmpeg = spawn(pathToCheck, ["-version"], {

      stdio: [ "ignore", "ignore", "ignore" ]
    });

    ffmpeg.on("error", () => {

      resolve(false);
    });

    ffmpeg.on("exit", (code) => {

      resolve(code === 0);
    });
  });
}

/**
 * Resolves the FFmpeg executable path. Checks Channels DVR (macOS, Windows, Linux), then the bundled ffmpeg-for-homebridge, then system PATH. The resolved path is
 * cached for subsequent calls.
 * @returns Promise resolving to the FFmpeg path if found, or undefined if not available.
 */
export async function resolveFFmpegPath(): Promise<string | undefined> {

  // Return cached result if already resolved.
  if(cachedFFmpegPath !== null) {

    return cachedFFmpegPath;
  }

  // On macOS, check Channels DVR bundled FFmpeg first. Users of PrismCast with Channels DVR likely have this available.
  if(process.platform === "darwin") {

    const channelsDvrPath = join(homedir(), "Library", "Application Support", "ChannelsDVR", "latest", "ffmpeg");

    if(existsSync(channelsDvrPath) && (await checkFFmpegAtPath(channelsDvrPath))) {

      cachedFFmpegPath = channelsDvrPath;

      return cachedFFmpegPath;
    }
  }

  // On Windows, check Channels DVR bundled FFmpeg. Users of PrismCast with Channels DVR likely have this available.
  if(process.platform === "win32") {

    const channelsDvrPath = join("C:", "ProgramData", "channelsdvr", "latest", "ffmpeg.exe");

    if(existsSync(channelsDvrPath) && (await checkFFmpegAtPath(channelsDvrPath))) {

      cachedFFmpegPath = channelsDvrPath;

      return cachedFFmpegPath;
    }
  }

  // On Linux, check common Channels DVR installation paths. The Channels DVR setup script creates a channels-dvr directory in the current working directory when
  // run. The official recommendation is ~/channels-dvr, but users also install to /usr/local/channels-dvr and /opt/channels-dvr.
  if(process.platform === "linux") {

    const linuxChannelsDvrPaths = [
      join(homedir(), "channels-dvr", "latest", "ffmpeg"),
      join("/usr", "local", "channels-dvr", "latest", "ffmpeg"),
      join("/opt", "channels-dvr", "latest", "ffmpeg")
    ];

    for(const channelsDvrPath of linuxChannelsDvrPaths) {

      // eslint-disable-next-line no-await-in-loop
      if(existsSync(channelsDvrPath) && (await checkFFmpegAtPath(channelsDvrPath))) {

        cachedFFmpegPath = channelsDvrPath;

        return cachedFFmpegPath;
      }
    }
  }

  // Check ffmpeg-for-homebridge bundled FFmpeg. This provides a reliable fallback without requiring manual FFmpeg installation.
  if(ffmpegPath && existsSync(ffmpegPath) && (await checkFFmpegAtPath(ffmpegPath))) {

    cachedFFmpegPath = ffmpegPath;

    return cachedFFmpegPath;
  }

  // Finally, check if ffmpeg is available in the system PATH.
  if(await checkFFmpegAtPath("ffmpeg")) {

    cachedFFmpegPath = "ffmpeg";

    return cachedFFmpegPath;
  }

  // FFmpeg not found anywhere.
  cachedFFmpegPath = undefined;

  return undefined;
}

/**
 * Result from spawning an FFmpeg process.
 */
export interface FFmpegProcess {

  // Writable stream for piping audio to FFmpeg. Only present in x11grab mode.
  audioPipe?: Writable;

  // Function to gracefully terminate the FFmpeg process.
  kill: () => void;

  // The underlying child process for lifecycle tracking.
  process: ChildProcess;

  // Writable stream for piping WebM input to FFmpeg.
  stdin: Writable;

  // Readable stream for receiving fMP4 output from FFmpeg.
  stdout: Readable;
}

/**
 * Spawns an FFmpeg process configured to remux WebM (H264+Opus) to fMP4 (H264+AAC). The process reads from stdin and writes to stdout, allowing it to be
 * integrated into a Node.js stream pipeline. Video is passed through unchanged (copy codec); audio is transcoded from Opus to AAC for HLS compatibility.
 * @param audioBitrate - Audio bitrate in bits per second (e.g., 256000 for 256 kbps).
 * @param onError - Callback invoked when FFmpeg exits unexpectedly or encounters an error.
 * @param streamId - Stream identifier for logging.
 * @param comment - Optional comment metadata (channel name or domain) to embed in the output.
 * @returns FFmpeg process wrapper with stdin, stdout, and kill function.
 */
export function spawnFFmpeg(audioBitrate: number, videoBitrate: number, frameRate: number,
  onError: (error: Error) => void, streamId?: string, comment?: string): FFmpegProcess {

  // On Linux with VA-API hardware, use the system FFmpeg (which has VA-API compiled in) for hardware re-encoding. The bundled ffmpeg-for-homebridge doesn't
  // have VA-API support. On macOS (VideoToolbox MediaRecorder = perfect 60fps), just copy the video through — no re-encode needed.
  const useVaapi = (process.platform === "linux") && existsSync("/dev/dri/renderD128");
  const ffmpegPath = useVaapi ? "ffmpeg" : (cachedFFmpegPath ?? "ffmpeg");

  const aacEncoder = process.platform === "darwin" ? "aac_at" : "aac";

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-progress", "pipe:2",
    "-probesize", "16384",
    "-i", "pipe:0"
  ];

  if(useVaapi) {

    // VA-API hardware re-encode: decode the WebM H264, re-encode via Quick Sync at the target frame rate and bitrate. This converts Chrome's VFR output with
    // dropped frames into perfect CFR output — the hardware encoder is fast enough that speed is never a concern.
    ffmpegArgs.push(
      "-vaapi_device", "/dev/dri/renderD128",
      "-vf", "format=nv12,hwupload",
      "-c:v", "h264_vaapi",
      "-bf", "0",
      "-r", String(frameRate),
      "-b:v", String(videoBitrate),
      "-maxrate", String(videoBitrate),
      "-bufsize", String(videoBitrate * 2)
    );
  } else {

    // macOS or no GPU: copy video through unchanged. macOS MediaRecorder uses VideoToolbox which already produces perfect CFR.
    ffmpegArgs.push("-c:v", "copy");
  }

  ffmpegArgs.push(
    "-c:a", aacEncoder,
    "-b:a", String(audioBitrate),
    "-af", "aresample=async=1",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer",
    "-flush_packets", "1",
    "-max_muxing_queue_size", "1024"
  );

  // Add metadata comment if provided. This embeds "PrismCast - <channel>" in the output for identification.
  if(comment) {

    ffmpegArgs.push("-metadata", "comment=PrismCast - " + comment);
  }

  ffmpegArgs.push("pipe:1");

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {

    stdio: [ "pipe", "pipe", "pipe" ]
  });

  const logPrefix = streamId ? "[" + streamId + "] " : "";

  // Track whether graceful shutdown has been initiated. When true, we suppress error callbacks because any exit (whether from SIGTERM or stdin close) is expected.
  let shuttingDown = false;

  // Parse FFmpeg progress stats from stderr. With -progress pipe:2, FFmpeg writes key=value pairs. We extract frame count, fps, speed, and bitrate and log them
  // every 5 seconds to diagnose encoding performance and frame delivery issues.
  let lastProgressLog = Date.now();
  const progressStats: Record<string, string> = {};

  ffmpeg.stderr.on("data", (data: Buffer) => {

    if(shuttingDown) {

      return;
    }

    const message = data.toString().trim();

    // Parse progress key=value pairs from -progress pipe:2.
    for(const line of message.split("\n")) {

      const eqIdx = line.indexOf("=");

      if(eqIdx > 0) {

        progressStats[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim();
      }
    }

    // Log progress every 5 seconds.
    const now = Date.now();

    if((now - lastProgressLog) >= 5000) {

      const frame = progressStats.frame || "?";
      const fps = progressStats.fps || "?";
      const speed = progressStats.speed || "?";
      const bitrate = progressStats.bitrate || "?";
      const drop = progressStats.drop_frames || "0";

      LOG.info("%sFFmpeg: frame=%s fps=%s speed=%s bitrate=%s dropped=%s", logPrefix, frame, fps, speed, bitrate, drop);
      lastProgressLog = now;
    }

    // Still log warnings/errors that aren't progress data.
    const noisePatterns = [ "Press [q] to stop", "frame=", "size=", "time=", "bitrate=", "speed=", "progress=" ];

    for(const line of message.split("\n")) {

      const trimmed = line.trim();

      if((trimmed.length === 0) || trimmed.includes("=") || noisePatterns.some((p) => trimmed.includes(p))) {

        continue;
      }

      LOG.debug("streaming:ffmpeg", "%sFFmpeg: %s", logPrefix, trimmed);
    }
  });

  // Handle FFmpeg process exit.
  ffmpeg.on("exit", (code, signal) => {

    // During graceful shutdown, any exit is expected (whether from SIGTERM or stdin closing).
    if(shuttingDown) {

      return;
    }

    if(signal === "SIGTERM") {

      // Normal termination via kill() - don't treat as error.
      return;
    }

    if((code !== null) && (code !== 0)) {

      onError(new Error("FFmpeg exited with code " + String(code) + "."));
    } else if(signal) {

      onError(new Error("FFmpeg killed by signal " + signal + "."));
    }
  });

  // Handle spawn errors (e.g., FFmpeg not found).
  ffmpeg.on("error", (error) => {

    // During graceful shutdown, suppress errors from stdin pipe closing.
    if(shuttingDown) {

      return;
    }

    onError(error);
  });

  // Kill function for graceful shutdown. Sets the shuttingDown flag before sending SIGTERM so that any exit (whether from SIGTERM or stdin closing due to capture
  // stream ending) is treated as normal termination.
  const kill = (): void => {

    shuttingDown = true;

    if(!ffmpeg.killed) {

      ffmpeg.kill("SIGTERM");
    }
  };

  return {

    kill,
    process: ffmpeg,
    stdin: ffmpeg.stdin,
    stdout: ffmpeg.stdout
  };
}

/**
 * Spawns an FFmpeg process that captures video directly from the X11 display via x11grab and receives audio via pipe. This bypasses Chrome's MediaRecorder entirely
 * for video — x11grab reads pixels from the Xvfb framebuffer at an exact constant frame rate, then h264_vaapi hardware-encodes them. Audio comes from puppeteer-stream's
 * MediaRecorder (audio-only WebM/Opus) piped to fd 3. The result is perfectly constant frame rate video with no dropped or duplicated frames.
 *
 * @param display - X11 display identifier (e.g., ":99").
 * @param width - Capture width in pixels.
 * @param height - Capture height in pixels.
 * @param frameRate - Target frame rate (e.g., 60).
 * @param videoBitrate - Video bitrate in bits per second.
 * @param audioBitrate - Audio bitrate in bits per second.
 * @param onError - Callback invoked when FFmpeg exits unexpectedly.
 * @param streamId - Stream identifier for logging.
 * @param comment - Optional metadata comment.
 * @returns FFmpeg process with audioPipe (fd 3) for audio input, stdout for fMP4 output.
 */
export function spawnX11GrabFFmpeg(display: string, width: number, height: number, frameRate: number,
  videoBitrate: number, audioBitrate: number, onError: (error: Error) => void, streamId?: string,
  comment?: string): FFmpegProcess {

  // Use system FFmpeg for VA-API support. Fall back to bundled FFmpeg with software encoding.
  const useVaapi = existsSync("/dev/dri/renderD128") && existsSync("/usr/bin/ffmpeg");
  const ffmpegPath = useVaapi ? "/usr/bin/ffmpeg" : (cachedFFmpegPath ?? "ffmpeg");

  LOG.info("x11grab using %s (VA-API: %s).", ffmpegPath, useVaapi ? "yes" : "no");
  const aacEncoder = "aac";

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-progress", "pipe:2",
    // Input 0: x11grab captures the full Xvfb screen. thread_queue_size prevents frame drops from input buffering.
    "-thread_queue_size", "512",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", String(frameRate),
    "-i", display,
    // Input 1: WebM from puppeteer-stream via fd 3 (contains video+audio, we only use audio).
    "-thread_queue_size", "512",
    "-f", "webm",
    "-i", "pipe:3",
    // Explicit mapping: video from x11grab, audio from WebM. Without this, FFmpeg might pick the wrong video stream.
    "-map", "0:v",
    "-map", "1:a"
  ];

  // Video encoding. Upload raw pixels to GPU first, then scale on GPU — avoids CPU-side crop/resize
  // which bottlenecks at ~50fps on 2160x1440 input. scale_vaapi runs entirely on the iGPU.
  if(useVaapi) {

    ffmpegArgs.push(
      "-vaapi_device", "/dev/dri/renderD128",
      "-vf", "hwmap=derive_device=vaapi,scale_vaapi=w=" + String(width) + ":h=" + String(height) + ":format=nv12",
      "-c:v", "h264_vaapi",
      "-bf", "4",
      "-threads", "4",
      "-b:v", String(videoBitrate),
      "-maxrate", String(videoBitrate),
      "-bufsize", String(videoBitrate * 2)
    );
  } else {

    ffmpegArgs.push(
      "-vf", "scale=" + String(width) + ":" + String(height),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-bf", "0",
      "-b:v", String(videoBitrate),
      "-maxrate", String(videoBitrate),
      "-bufsize", String(videoBitrate * 2)
    );
  }

  // Audio encoding + output.
  ffmpegArgs.push(
    "-c:a", aacEncoder,
    "-b:a", String(audioBitrate),
    "-af", "aresample=async=1",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer",
    "-frag_duration", "1000000",
    "-flush_packets", "1",
    "-max_muxing_queue_size", "4096"
  );

  if(comment) {

    ffmpegArgs.push("-metadata", "comment=PrismCast - " + comment);
  }

  ffmpegArgs.push("pipe:1");

  // fd 3 = audio pipe input.
  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {

    stdio: [ "ignore", "pipe", "pipe", "pipe" ]
  });

  const logPrefix = streamId ? "[" + streamId + "] " : "";
  let shuttingDown = false;
  let lastProgressLog = Date.now();
  const progressStats: Record<string, string> = {};

  // Log FFmpeg stderr output. stderr is guaranteed non-null since stdio[2] is "pipe".
  ffmpeg.stderr!.on("data", (data: Buffer) => {

    if(shuttingDown) {

      return;
    }

    const message = data.toString().trim();

    for(const line of message.split("\n")) {

      const eqIdx = line.indexOf("=");

      if(eqIdx > 0) {

        progressStats[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim();
      }
    }

    const now = Date.now();

    if((now - lastProgressLog) >= 5000) {

      const frame = progressStats.frame || "?";
      const fps = progressStats.fps || "?";
      const speed = progressStats.speed || "?";
      const bitrate = progressStats.bitrate || "?";
      const drop = progressStats.drop_frames || "0";

      LOG.info("%sx11grab: frame=%s fps=%s speed=%s bitrate=%s dropped=%s", logPrefix, frame, fps, speed, bitrate, drop);
      lastProgressLog = now;
    }

    const noisePatterns = [ "Press [q] to stop", "frame=", "size=", "time=", "bitrate=", "speed=", "progress=" ];

    for(const line of message.split("\n")) {

      const trimmed = line.trim();

      if((trimmed.length === 0) || trimmed.includes("=") || noisePatterns.some((p) => trimmed.includes(p))) {

        continue;
      }

      LOG.debug("streaming:ffmpeg", "%sx11grab: %s", logPrefix, trimmed);
    }
  });

  ffmpeg.on("exit", (code, signal) => {

    if(shuttingDown || (signal === "SIGTERM")) {

      return;
    }

    if((code !== null) && (code !== 0)) {

      onError(new Error("x11grab FFmpeg exited with code " + String(code) + "."));
    } else if(signal) {

      onError(new Error("x11grab FFmpeg killed by signal " + signal + "."));
    }
  });

  ffmpeg.on("error", (error) => {

    if(shuttingDown) {

      return;
    }

    onError(error);
  });

  const kill = (): void => {

    shuttingDown = true;

    if(!ffmpeg.killed) {

      ffmpeg.kill("SIGTERM");
    }
  };

  const audioPipe = ffmpeg.stdio[3] as Writable;

  return {

    audioPipe,
    kill,
    process: ffmpeg,
    stdin: ffmpeg.stdin as unknown as Writable,
    stdout: ffmpeg.stdout!
  };
}

/**
 * Spawns an FFmpeg process configured to remux fMP4 input to MPEG-TS output with codec copy. The process reads a continuous fMP4 stream (init segment followed by
 * media segments) from stdin and writes MPEG-TS to stdout. No transcoding occurs — both video (H264) and audio (AAC) are copied unchanged — so CPU usage is minimal.
 *
 * FFmpeg arguments:
 * - `-hide_banner -loglevel warning`: Reduce noise, only show warnings/errors
 * - `-probesize 16384`: Limit input probing to 16KB (fMP4 init segment is ~1.3KB) to minimize startup delay
 * - `-f mp4 -i pipe:0`: Read fragmented MP4 from stdin
 * - `-c copy`: Copy both video and audio codecs without transcoding
 * - `-f mpegts`: Output MPEG-TS container format
 * - `-mpegts_pmt_start_pid 0x0020`: Use ATSC-conventional PMT PID range instead of FFmpeg's default (0x1000). Minimum allowed value is 0x0020 (32).
 * - `-mpegts_start_pid 0x0031`: Use ATSC-conventional elementary stream PIDs instead of FFmpeg's defaults (0x100+)
 * - `-mpegts_service_type digital_tv`: Label the service as digital TV in the PMT service descriptor
 * - `-pat_period 0.1`: Repeat PAT/PMT tables every 100ms, matching ATSC broadcast frequency
 * - `-pcr_period 40`: Insert PCR timestamps every 40ms, matching ATSC broadcast convention
 * - `-flush_packets 1`: Flush output immediately after each packet to minimize latency
 * - `pipe:1`: Write output to stdout
 * @param onError - Callback invoked when FFmpeg exits unexpectedly or encounters an error.
 * @param streamId - Optional stream identifier for logging.
 * @returns FFmpeg process wrapper with stdin, stdout, and kill function.
 */
export function spawnMpegTsRemuxer(onError: (error: Error) => void, streamId?: string): FFmpegProcess {

  const ffmpegBin = cachedFFmpegPath ?? "ffmpeg";

  // MPEG-TS muxer flags are tuned to produce output resembling a real HDHomeRun CONNECT DUO (HDTC-2US) ATSC transport stream. Plex's transcoder may make
  // assumptions about stream structure based on the reported device model (PID assignments, PAT/PMT frequency). Using ATSC-conventional values avoids "Invalid
  // argument" failures when Plex tries to transcode the live session for remote clients. These are pure container metadata changes — the actual A/V data is
  // untouched by -c copy.
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "warning",
    "-probesize", "16384",
    "-f", "mp4",
    "-i", "pipe:0",
    "-c", "copy",
    "-f", "mpegts",
    "-mpegts_pmt_start_pid", "0x0020",
    "-mpegts_start_pid", "0x0031",
    "-mpegts_service_type", "digital_tv",
    "-pat_period", "0.1",
    "-pcr_period", "40",
    "-flush_packets", "1",
    "-max_muxing_queue_size", "1024",
    "pipe:1"
  ];

  const ffmpeg = spawn(ffmpegBin, ffmpegArgs, {

    stdio: [ "pipe", "pipe", "pipe" ]
  });

  const logPrefix = streamId ? "[" + streamId + "] " : "";

  // Track whether graceful shutdown has been initiated. When true, we suppress error callbacks because any exit is expected.
  let shuttingDown = false;

  // Log FFmpeg stderr output (warnings and errors).
  ffmpeg.stderr.on("data", (data: Buffer) => {

    if(shuttingDown) {

      return;
    }

    const message = data.toString().trim();
    const noisePatterns = [ "Press [q] to stop", "frame=", "size=", "time=", "bitrate=", "speed=" ];

    if(noisePatterns.some((pattern) => message.includes(pattern))) {

      return;
    }

    if(message.length > 0) {

      LOG.debug("streaming:ffmpeg", "%sMPEG-TS remuxer: %s", logPrefix, message);
    }
  });

  // Handle FFmpeg process exit.
  ffmpeg.on("exit", (code, signal) => {

    if(shuttingDown) {

      return;
    }

    if(signal === "SIGTERM") {

      return;
    }

    if((code !== null) && (code !== 0)) {

      onError(new Error("MPEG-TS remuxer exited with code " + String(code) + "."));
    } else if(signal) {

      onError(new Error("MPEG-TS remuxer killed by signal " + signal + "."));
    }
  });

  // Handle spawn errors (e.g., FFmpeg not found).
  ffmpeg.on("error", (error) => {

    if(shuttingDown) {

      return;
    }

    onError(error);
  });

  // Kill function for graceful shutdown.
  const kill = (): void => {

    shuttingDown = true;

    if(!ffmpeg.killed) {

      ffmpeg.kill("SIGTERM");
    }
  };

  return {

    kill,
    process: ffmpeg,
    stdin: ffmpeg.stdin,
    stdout: ffmpeg.stdout
  };
}

/**
 * Checks if FFmpeg is available on the system. This resolves the FFmpeg path and caches it for use by spawnFFmpeg().
 * @returns Promise resolving to true if FFmpeg is available, false otherwise.
 */
export async function isFFmpegAvailable(): Promise<boolean> {

  const ffmpegPath = await resolveFFmpegPath();

  return ffmpegPath !== undefined;
}
