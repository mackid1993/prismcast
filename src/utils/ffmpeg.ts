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
export function spawnFFmpeg(audioBitrate: number, onError: (error: Error) => void, streamId?: string, comment?: string): FFmpegProcess {

  const ffmpegPath = cachedFFmpegPath ?? "ffmpeg";
  const aacEncoder = process.platform === "darwin" ? "aac_at" : "aac";
  const isDocker = process.env.PRISMCAST_CONTAINER === "1";

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "warning",
    "-probesize", "16384",
    "-i", "pipe:0",
    "-c:v", "copy",
    "-c:a", aacEncoder,
    "-b:a", String(audioBitrate),
    // Docker: A/V sync fix and fragment duration cap. Gated to avoid changing behavior on other platforms.
    ...(isDocker ? [ "-af", "aresample=async=1", "-max_interleave_delta", "0" ] : []),
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer",
    ...(isDocker ? [ "-frag_duration", "1000000" ] : []),
    "-flush_packets", "1"
  ];

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

  // Log FFmpeg stderr output (warnings and errors). stderr is guaranteed to be a Readable since we set stdio: ["pipe", "pipe", "pipe"].
  ffmpeg.stderr.on("data", (data: Buffer) => {

    // Suppress warnings during shutdown - truncated input warnings are expected when the capture stream closes.
    if(shuttingDown) {

      return;
    }

    const message = data.toString().trim();

    // Filter out common noise that isn't actionable.
    const noisePatterns = [ "Press [q] to stop", "frame=", "size=", "time=", "bitrate=", "speed=" ];

    if(noisePatterns.some((pattern) => message.includes(pattern))) {

      return;
    }

    if(message.length > 0) {

      LOG.debug("streaming:ffmpeg", "%sFFmpeg: %s", logPrefix, message);
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
export function spawnGstreamerCapture(display: string, width: number, height: number, frameRate: number,
  videoBitrate: number, audioBitrate: number, onError: (error: Error) => void, streamId?: string,
  comment?: string): FFmpegProcess {

  const ffmpegPath = existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : (cachedFFmpegPath ?? "ffmpeg");
  const logPrefix = streamId ? "[" + streamId + "] " : "";
  let shuttingDown = false;

  // GStreamer pipeline: ximagesrc captures Xvfb, vaapipostproc converts to VA surface, vaapih264enc encodes on GPU.
  // Output MPEG-TS to stdout — FFmpeg reads this for audio muxing.
  const gstPipeline = [
    "ximagesrc", "display-name=" + display, "remote=true", "use-damage=false", "show-pointer=false",
    "!", "video/x-raw,framerate=" + String(frameRate) + "/1",
    "!", "vaapipostproc",
    "!", "vaapih264enc",
    "bitrate=" + String(Math.round(videoBitrate / 1000)),
    "keyframe-period=" + String(frameRate * 2),
    "!", "video/x-h264,profile=main",
    "!", "h264parse",
    "!", "mpegtsmux",
    "!", "fdsink", "fd=1"
  ];

  LOG.info("%sGStreamer capture: %dx%d@%dfps, bitrate=%dk.", logPrefix, width, height, frameRate, Math.round(videoBitrate / 1000));

  // Spawn gst-launch-1.0 for video capture. stdout = MPEG-TS H264 stream.
  const gst = spawn("gst-launch-1.0", gstPipeline, {

    env: { ...process.env, DISPLAY: display },
    stdio: [ "ignore", "pipe", "pipe" ]
  });

  // Spawn FFmpeg to mux GStreamer's MPEG-TS video with MediaRecorder's WebM audio.
  // Input 0: MPEG-TS from GStreamer (pipe:0). Input 1: WebM audio from MediaRecorder (pipe:3).
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-progress", "pipe:2",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-thread_queue_size", "512",
    "-use_wallclock_as_timestamps", "1",
    "-f", "webm",
    "-i", "pipe:3",
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", String(audioBitrate),
    "-af", "aresample=async=1",
    "-max_interleave_delta", "0",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer",
    "-frag_duration", "1000000",
    "-flush_packets", "1"
  ];

  if(comment) {

    ffmpegArgs.push("-metadata", "comment=PrismCast - " + comment);
  }

  ffmpegArgs.push("pipe:1");

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {

    stdio: [ "pipe", "pipe", "pipe", "pipe" ]
  });

  // Pipe GStreamer MPEG-TS output to FFmpeg stdin.
  gst.stdout.pipe(ffmpeg.stdin);

  // Log GStreamer stderr.
  gst.stderr.on("data", (data: Buffer) => {

    if(shuttingDown) {

      return;
    }

    const message = data.toString().trim();

    if(message.length > 0) {

      LOG.debug("streaming:gstreamer", "%sGStreamer: %s", logPrefix, message);
    }
  });

  // Log FFmpeg stderr (progress stats).
  let lastProgressLog = Date.now();
  const progressStats: Record<string, string> = {};

  ffmpeg.stderr.on("data", (data: Buffer) => {

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

      LOG.info("%sGStreamer capture: frame=%s fps=%s speed=%s bitrate=%s dropped=%s",
        logPrefix, progressStats.frame || "?", progressStats.fps || "?",
        progressStats.speed || "?", progressStats.bitrate || "?", progressStats.drop_frames || "0");

      lastProgressLog = now;
    }
  });

  gst.on("exit", (code, signal) => {

    if(shuttingDown || (signal === "SIGTERM")) {

      return;
    }

    if((code !== null) && (code !== 0)) {

      onError(new Error("GStreamer exited with code " + String(code) + "."));
    }
  });

  ffmpeg.on("exit", (code, signal) => {

    if(shuttingDown || (signal === "SIGTERM")) {

      return;
    }

    if((code !== null) && (code !== 0)) {

      onError(new Error("GStreamer FFmpeg muxer exited with code " + String(code) + "."));
    }
  });

  gst.on("error", (error) => {

    if(!shuttingDown) {

      onError(error);
    }
  });

  ffmpeg.on("error", (error) => {

    if(!shuttingDown) {

      onError(error);
    }
  });

  const kill = (): void => {

    shuttingDown = true;

    if(!gst.killed) {

      gst.kill("SIGTERM");
    }

    if(!ffmpeg.killed) {

      ffmpeg.kill("SIGTERM");
    }
  };

  const audioPipe = ffmpeg.stdio[3] as Writable;

  return {

    audioPipe,
    kill,
    process: ffmpeg,
    stdin: ffmpeg.stdin,
    stdout: ffmpeg.stdout
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
