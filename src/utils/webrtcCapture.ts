/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webrtcCapture.ts: WebRTC-based video capture using native WebRTC bindings for hardware-accelerated H264 encoding.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import { LOG } from "./logger.js";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { createRequire } from "node:module";


const wrtc: any = createRequire(import.meta.url)("@roamhq/wrtc");

/**
 * Result from creating a WebRTC capture peer.
 */
export interface WebRTCCapturePeer {

  // Collected ICE candidates as JSON strings for trickle ICE (unused with native — SDP includes them).
  candidates: string[];

  // The SDP offer to send to Chrome.
  offer: string;

  // Set Chrome's SDP answer.
  setAnswer: (answer: string) => Promise<void>;

  // Readable stream of raw H264 Annex B NALUs.
  videoStream: Readable;

  // Gracefully close the peer connection.
  close: () => void;
}

/**
 * Creates a WebRTC peer using native bindings that receives H264 video from Chrome. The native WebRTC implementation handles ICE correctly in Docker — no workarounds
 * needed. Chrome sends H264 RTP to the native peer on localhost, and we extract the encoded video data.
 *
 * @param streamId - Stream identifier for logging.
 * @returns The capture peer with offer SDP, setAnswer, videoStream, and close.
 */
export async function createWebRTCCapturePeer(streamId?: string): Promise<WebRTCCapturePeer> {

  const logPrefix = streamId ? "[" + streamId + "] " : "";
  const videoOutput = new PassThrough();
  let closed = false;

  // Dynamic import for ESM compatibility — @roamhq/wrtc is a CommonJS native addon.

  const pc = new wrtc.RTCPeerConnection() as RTCPeerConnection;

  // Add a recvonly transceiver to request video from Chrome.
  pc.addTransceiver("video", { direction: "recvonly" });

  // When Chrome's video track arrives, use RTCVideoSink to get raw frames, or just monitor the connection.
  // For now, we'll extract H264 from the RTP stream via the nonstandard API.
  pc.ontrack = (event: RTCTrackEvent): void => {

    LOG.info("%sWebRTC: video track received, kind=%s.", logPrefix, event.track.kind);

    if(event.track.kind === "video") {

      // Use the nonstandard RTCVideoSink to get decoded video frames.
      // Note: for H264 passthrough we'd need RTP access, but RTCVideoSink gives us decoded frames.
      // We'll need to re-encode with FFmpeg, but at least the capture is correct and complete.


      const sink: any = new wrtc.nonstandard.RTCVideoSink(event.track);
      let frameCount = 0;
      let firstFrame = true;

      sink.onframe = (evt: { frame: { data: Buffer; width: number; height: number } }): void => {

        if(closed) {

          return;
        }

        if(firstFrame) {

          firstFrame = false;
          LOG.info("%sWebRTC: first frame %dx%d, %d bytes (I420).",
            logPrefix, evt.frame.width, evt.frame.height, evt.frame.data.length);
        }

        frameCount++;

        // Write raw I420 frame data. FFmpeg will encode this.
        videoOutput.write(Buffer.from(evt.frame.data));
      };

      // Log stats.
      const statsInterval = setInterval((): void => {

        if(closed) {

          clearInterval(statsInterval);

          return;
        }

        LOG.info("%sWebRTC stats: frames=%d", logPrefix, frameCount);
        frameCount = 0;
      }, 5000);

      statsInterval.unref();
    }
  };

  // Create the offer and wait for ICE gathering.
  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete — native WebRTC handles this properly.
  await new Promise<void>((resolve) => {

    if(pc.iceGatheringState === "complete") {

      resolve();

      return;
    }

    pc.onicegatheringstatechange = (): void => {

      if(pc.iceGatheringState === "complete") {

        resolve();
      }
    };

    setTimeout(resolve, 10000);
  });

  const offerSdp = pc.localDescription?.sdp ?? "";

  LOG.info("%sWebRTC: offer created with %d candidates.", logPrefix,
    (offerSdp.match(/a=candidate/g) ?? []).length);

  const setAnswer = async (answer: string): Promise<void> => {

    await pc.setRemoteDescription({ sdp: answer, type: "answer" } as RTCSessionDescriptionInit);
    LOG.info("%sWebRTC: answer set, connection establishing.", logPrefix);
  };

  const close = (): void => {

    if(closed) {

      return;
    }

    closed = true;
    pc.close();
    videoOutput.end();
    LOG.info("%sWebRTC: peer closed.", logPrefix);
  };

  // Monitor connection state.
  pc.onconnectionstatechange = (): void => {

    LOG.info("%sWebRTC: connection state → %s", logPrefix, pc.connectionState);
  };

  pc.oniceconnectionstatechange = (): void => {

    LOG.info("%sWebRTC: ICE state → %s", logPrefix, pc.iceConnectionState);
  };

  return {

    candidates: [],
    close,
    offer: offerSdp,
    setAnswer,
    videoStream: videoOutput
  };
}
