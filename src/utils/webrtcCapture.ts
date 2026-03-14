/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webrtcCapture.ts: WebRTC-based video capture using werift for hardware-accelerated H264 encoding.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

// @ts-expect-error — werift/nonstandard uses package.json exports which moduleResolution:"node" doesn't resolve.
import { DepacketizeCallback, H264RtpPayload } from "werift/nonstandard";
import { RTCPeerConnection, useH264 } from "werift";
import { LOG } from "./logger.js";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

/**
 * Result from creating a WebRTC capture peer.
 */
export interface WebRTCCapturePeer {

  // Readable stream of raw H264 Annex B NALUs. Pipe this to FFmpeg.
  videoStream: Readable;

  // Create an SDP answer from Chrome's offer.
  createAnswer: (offer: string) => Promise<string>;

  // Gracefully close the peer connection.
  close: () => void;
}

// Annex B start code for H264 NALUs.
const ANNEX_B_START_CODE = Buffer.from([ 0x00, 0x00, 0x00, 0x01 ]);

/**
 * Creates a WebRTC peer that receives H264 video from Chrome's hardware encoder. The peer accepts an SDP offer from the Chrome extension, answers with H264 codec
 * preference, and outputs depacketized H264 NALUs as Annex B byte stream on the videoStream.
 *
 * @param streamId - Stream identifier for logging.
 * @returns The capture peer with videoStream, createAnswer, and close methods.
 */
export function createWebRTCCapturePeer(streamId?: string): WebRTCCapturePeer {

  const logPrefix = streamId ? "[" + streamId + "] " : "";
  const videoOutput = new PassThrough();
  let closed = false;

  const pc = new RTCPeerConnection({

    codecs: {

      audio: [],
      video: [useH264()]
    }
  });

  // Set up the H264 depacketizer: RTP packets → reassembled NALUs.
  const depacketizer = new DepacketizeCallback("h264", {

    isFinalPacketInSequence: H264RtpPayload.isDetectedFinalPacketInSequence
  });

  // When a complete frame is depacketized, write it to the output stream with Annex B start codes.
  depacketizer.pipe((output: { frame?: { data: Buffer; isKeyframe: boolean } }): void => {

    if(closed || !output.frame) {

      return;
    }

    videoOutput.write(ANNEX_B_START_CODE);
    videoOutput.write(output.frame.data);
  });

  // Handle incoming video track from Chrome.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pc.ontrack = (event: any): void => {

    if(event.track.kind !== "video") {

      return;
    }

    LOG.info("%sWebRTC: video track received.", logPrefix);

    // Feed RTP packets to the depacketizer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event.track.onReceiveRtp.subscribe((rtp: any) => {

      if(closed) {

        return;
      }

      depacketizer.input({ rtp, time: Date.now() });
    });

    // Periodically request keyframes via PLI.
    const pliInterval = setInterval((): void => {

      if(closed) {

        clearInterval(pliInterval);

        return;
      }

      if(event.track.ssrc) {

        event.receiver.sendRtcpPLI(event.track.ssrc).catch((): void => { /* ignore */ });
      }
    }, 2000);
  };

  const createAnswer = async (offer: string): Promise<string> => {

    await pc.setRemoteDescription({ sdp: offer, type: "offer" });
    const answer = await pc.createAnswer();

    await pc.setLocalDescription(answer);

    LOG.info("%sWebRTC: SDP negotiation complete.", logPrefix);

    return pc.localDescription?.sdp ?? "";
  };

  const close = (): void => {

    if(closed) {

      return;
    }

    closed = true;
    pc.close().catch((): void => { /* ignore */ });
    videoOutput.end();

    LOG.info("%sWebRTC: peer closed.", logPrefix);
  };

  return {

    close,
    createAnswer,
    videoStream: videoOutput
  };
}
