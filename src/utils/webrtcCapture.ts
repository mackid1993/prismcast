/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webrtcCapture.ts: WebRTC-based video capture using werift for hardware-accelerated H264 encoding.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access */

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

  // The SDP offer to send to Chrome (werift is the offerer).
  offer: string;

  // Set Chrome's SDP answer on the peer.
  setAnswer: (answer: string) => Promise<void>;

  // Readable stream of raw H264 Annex B NALUs.
  videoStream: Readable;

  // Gracefully close the peer connection.
  close: () => void;
}

// Annex B start code for H264 NALUs.
const ANNEX_B_START_CODE = Buffer.from([ 0x00, 0x00, 0x00, 0x01 ]);

/**
 * Creates a WebRTC peer that receives H264 video from Chrome. werift creates the offer (as the receiver requesting video), Chrome answers with its hardware encoder.
 * This matches the werift save_to_disk/h264.ts example pattern where the server is the offerer.
 *
 * @param streamId - Stream identifier for logging.
 * @returns The capture peer with offer SDP, setAnswer, videoStream, and close.
 */
export async function createWebRTCCapturePeer(streamId?: string): Promise<WebRTCCapturePeer> {

  const logPrefix = streamId ? "[" + streamId + "] " : "";
  const videoOutput = new PassThrough();
  let closed = false;

  const pc = new RTCPeerConnection({

    codecs: {

      audio: [],
      video: [useH264()]
    }
  });

  // Add a recvonly transceiver to request video from Chrome.
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });

  // Set up the H264 depacketizer: RTP packets → reassembled NALUs.
  const depacketizer = new DepacketizeCallback("h264", {

    isFinalPacketInSequence: H264RtpPayload.isDetectedFinalPacketInSequence
  });


  // Handle incoming RTP on the transceiver's receiver.
  let rtpCount = 0;
  let frameBytes = 0;

  const statsInterval = setInterval((): void => {

    if(!closed) {

      LOG.info("%sWebRTC stats: rtp=%d, videoOut=%d KB", logPrefix, rtpCount, Math.round(frameBytes / 1024));
    }

    rtpCount = 0;
    frameBytes = 0;
  }, 5000);

  statsInterval.unref();

  // Override the depacketizer pipe to also count bytes.
  depacketizer.pipe((output: { frame?: { data: Buffer; isKeyframe: boolean } }): void => {

    if(closed || !output.frame) {

      return;
    }

    frameBytes += output.frame.data.length;
    videoOutput.write(ANNEX_B_START_CODE);
    videoOutput.write(output.frame.data);
  });

  // Try both track subscription methods — transceiver.onTrack and pc.ontrack.
  transceiver.onTrack.subscribe((track): void => {

    LOG.info("%sWebRTC: video track received via transceiver.onTrack.", logPrefix);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track.onReceiveRtp.subscribe((rtp: any) => {

      if(closed) {

        return;
      }

      rtpCount++;
      depacketizer.input({ rtp, time: Date.now() });
    });
  });

  // Also subscribe via pc.ontrack as a backup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pc.ontrack = (event: any): void => {

    LOG.info("%sWebRTC: video track received via pc.ontrack, kind=%s.", logPrefix, event?.track?.kind ?? "unknown");

    if(event?.track?.kind === "video" && event.track.onReceiveRtp) {

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event.track.onReceiveRtp.subscribe((rtp: any) => {

        if(closed) {

          return;
        }

        rtpCount++;
        depacketizer.input({ rtp, time: Date.now() });
      });
    }
  };

  // Periodically request keyframes.
  const pliInterval = setInterval((): void => {

    if(closed) {

      clearInterval(pliInterval);

      return;
    }

    transceiver.receiver.sendRtcpPLI(transceiver.receiver.tracks[0]?.ssrc ?? 0).catch((): void => { /* ignore */ });
  }, 2000);

  pliInterval.unref();

  // Create the offer — werift is the offerer (requesting video from Chrome).
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription?.sdp ?? "";

  LOG.info("%sWebRTC: offer created, waiting for Chrome answer.", logPrefix);

  const setAnswer = async (answer: string): Promise<void> => {

    await pc.setRemoteDescription({ sdp: answer, type: "answer" });
    LOG.info("%sWebRTC: answer received, connection establishing.", logPrefix);
  };

  const close = (): void => {

    if(closed) {

      return;
    }

    closed = true;
    clearInterval(pliInterval);
    pc.close().catch((): void => { /* ignore */ });
    videoOutput.end();
    LOG.info("%sWebRTC: peer closed.", logPrefix);
  };

  // Monitor connection state.
  pc.iceConnectionStateChange.subscribe((state): void => {

    LOG.info("%sWebRTC: ICE state → %s", logPrefix, state);
  });

  pc.connectionStateChange.subscribe((state): void => {

    LOG.info("%sWebRTC: connection state → %s", logPrefix, state);
  });

  return {

    close,
    offer: offerSdp,
    setAnswer,
    videoStream: videoOutput
  };
}
