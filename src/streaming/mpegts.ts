/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mpegts.ts: MPEG-TS streaming handler for PrismCast.
 */
import type { Channel, Nullable } from "../types/index.js";
import { LOG, formatError } from "../utils/index.js";
import type { Request, Response } from "express";
import { awaitStreamReadySilent, initializeStream, sendValidationError, validateChannel } from "./hls.js";
import { getStream, updateLastAccess } from "./registry.js";
import { registerClient, unregisterClient } from "./clients.js";
// import { CONFIG } from "../config/index.js";
import { StreamSetupError } from "./setup.js";
import { getChannelStreamId } from "./lifecycle.js";

/* This module provides a continuous MPEG-TS byte stream from the same capture pipeline used for HLS. It is designed for HDHomeRun-compatible clients (such as Plex)
 * that expect raw MPEG-TS when tuning a channel. The existing capture → segmenter → HLS segments flow is unchanged. Each MPEG-TS client gets its own FFmpeg remuxer
 * that converts stored fMP4 segments to MPEG-TS with codec copy (no transcoding).
 *
 * Data flow per client:
 * 1. Validate channel and check for existing stream
 * 2. If new stream needed, flush HTTP 200 headers immediately (so the client sees "connection accepted")
 * 3. initializeStream() starts the capture, or awaitStreamReadySilent() waits for an in-progress startup
 * 4. Wait for the init segment (ftyp+moov codec configuration)
 * 5. Spawn FFmpeg: -f mp4 -i pipe:0 -c copy -f mpegts pipe:1
 * 6. Write init segment + existing media segments to FFmpeg stdin
 * 7. Subscribe to segment events for new segments in real time
 * 8. Pipe FFmpeg stdout to the HTTP response as video/mp2t
 * 9. On client disconnect or stream termination, kill FFmpeg and clean up
 *
 * The header flush in step 2 prevents client timeouts. Without it, the client receives zero bytes until the entire stream setup completes (4-10+ seconds), which may
 * exceed the client's connection timeout.
 */

// Public Endpoint Handler.

/**
 * Handles MPEG-TS stream requests. Validates the channel, flushes HTTP headers early for new streams, then ensures a capture is running, waits for the init segment,
 * spawns a per-client FFmpeg remuxer, and streams the output.
 *
 * For new streams, headers are flushed before stream setup begins so the client sees an immediate 200 response. This prevents timeout failures during the 4-10+
 * second startup sequence. The trade-off is that error responses cannot be sent after the flush — failures are logged server-side and the connection is closed.
 *
 * Route: GET /stream/:name
 *
 * @param req - Express request object.
 * @param res - Express response object.
 */
export async function handleMpegTsStream(req: Request, res: Response): Promise<void> {

  const channelName = (req.params as { name?: string }).name;

  if(!channelName) {

    res.status(400).send("Channel name is required.");

    return;
  }

  // Check for an existing stream first. If one exists, we can skip validation and header flushing.
  const existingStreamId = getChannelStreamId(channelName);

  // Fast path: a real stream already exists. No early flush needed — the stream data will flow quickly.
  if((existingStreamId !== undefined) && (existingStreamId !== -1)) {

    serveMpegTsStream(existingStreamId, channelName, req, res);

    return;
  }

  // If no existing stream or startup in progress, validate the channel before flushing headers. This ensures we can still return proper error responses for invalid
  // channels, disabled channels, and login mode. Store the validated channel for use during stream initialization below.
  let validatedChannel: Channel | undefined;

  if(existingStreamId === undefined) {

    const validation = validateChannel(channelName);

    if(!validation.valid) {

      sendValidationError(validation, res);

      return;
    }

    validatedChannel = validation.channel;
  }

  // Flush HTTP 200 headers immediately. The client sees "connection accepted, data coming" and waits patiently. After this point, we cannot send error status codes —
  // failures will close the connection with no data.
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "close");
  res.setHeader("Content-Type", "video/mpeg");
  res.setHeader("transferMode.dlna.org", "Streaming");
  res.flushHeaders();

  // Acquire the stream. If a startup is in progress (another request started it), poll silently. Otherwise, start a new stream via initializeStream().
  let streamId: Nullable<number>;

  if(existingStreamId === -1) {

    // Another request is already starting this stream. Wait silently (no error responses possible after flush).
    streamId = await awaitStreamReadySilent(channelName);

    if(streamId === null) {

      LOG.warn("MPEG-TS stream startup failed for %s (startup did not complete).", channelName);
      res.end();

      return;
    }
  } else {

    // Start a new stream directly. validatedChannel is guaranteed set: this branch runs only when existingStreamId === undefined, which requires successful
    // validation above. Since headers are already flushed, errors are logged and the connection is closed.
    if(!validatedChannel) {

      res.end();

      return;
    }

    try {

      streamId = await initializeStream({

        channel: validatedChannel,
        channelName,
        clientAddress: req.ip ?? req.socket.remoteAddress ?? null,
        profileOverride: req.query.profile as string | undefined,
        url: validatedChannel.url
      });
    } catch(error) {

      if(error instanceof StreamSetupError) {

        LOG.warn("MPEG-TS stream startup failed for %s: %s.", channelName, error.userMessage);
      } else {

        LOG.warn("MPEG-TS stream startup failed for %s: %s.", channelName, formatError(error));
      }

      res.end();

      return;
    }

    if(streamId === null) {

      LOG.warn("MPEG-TS stream startup failed for %s (terminated during setup).", channelName);
      res.end();

      return;
    }
  }

  serveMpegTsStream(streamId, channelName, req, res);
}

// Internal Helpers.

/**
 * Serves the MPEG-TS stream once a stream ID is available. Pipes FFmpeg's MPEG-TS output directly to the HTTP response — no segmenter, no remuxer, no HLS.
 *
 * @param streamId - The numeric stream ID.
 * @param channelName - The channel name for logging.
 * @param req - Express request object.
 * @param res - Express response object.
 */
function serveMpegTsStream(streamId: number, channelName: string, req: Request, res: Response): void {

  const stream = getStream(streamId);

  if(!stream?.mpegTsStream) {

    if(!res.headersSent) {

      res.status(500).send("Stream no longer available.");
    } else {

      res.end();
    }

    return;
  }

  // Capture client address for client tracking. Captured before any async operations so it remains consistent in the cleanup closure, even if the request object
  // becomes unreliable after disconnect.
  const clientAddress = req.ip ?? req.socket.remoteAddress ?? "unknown";

  // Increment the MPEG-TS client counter to prevent idle timeout while this client is connected.
  stream.mpegTsClientCount++;
  updateLastAccess(streamId);
  registerClient(streamId, clientAddress, "mpegts");

  const streamLog = LOG.withStreamId(stream.streamIdStr);

  // Set response headers if they haven't been sent yet.
  if(!res.headersSent) {

    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.setHeader("Content-Type", "video/mpeg");
    res.setHeader("transferMode.dlna.org", "Streaming");
  }

  // Pipe FFmpeg's MPEG-TS output directly to the HTTP response. No segmenter, no remuxer, no HLS.
  stream.mpegTsStream.pipe(res);

  streamLog.debug("streaming:mpegts", "MPEG-TS client connected (direct pipe).");

  // Clean up when the client disconnects.
  req.on("close", () => {

    const currentStream = getStream(streamId);

    if(currentStream) {

      currentStream.mpegTsClientCount = Math.max(0, currentStream.mpegTsClientCount - 1);

      if(currentStream.mpegTsClientCount === 0) {

        updateLastAccess(streamId);
      }
    }

    unregisterClient(streamId, clientAddress, "mpegts");
    stream.mpegTsStream?.unpipe(res);

    streamLog.debug("streaming:mpegts", "MPEG-TS client disconnected.");
  });
}
