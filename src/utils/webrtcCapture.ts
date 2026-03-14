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
import { networkInterfaces } from "node:os";
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

  // Get all IPv4 addresses from the container's network interfaces. werift's getHostAddresses() filters out Docker's veth interfaces, so we need to discover
  // addresses ourselves and pass them via iceAdditionalHostAddresses which bypasses werift's interface filtering.
  const hostAddresses: string[] = [ "127.0.0.1" ];
  const ifaces = networkInterfaces();

  for(const name of Object.keys(ifaces)) {

    for(const iface of ifaces[name] ?? []) {

      if((iface.family === "IPv4") && !iface.internal) {

        hostAddresses.push(iface.address);
      }
    }
  }

  LOG.info("%sWebRTC: discovered host addresses: %s", logPrefix, hostAddresses.join(", "));

  const pc = new RTCPeerConnection({

    codecs: {

      audio: [],
      video: [useH264()]
    },
    iceAdditionalHostAddresses: hostAddresses,
    iceUseIpv4: true,
    iceUseIpv6: false
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

  // Collect ICE candidates via events. werift's localDescription may not include candidates in Docker because the veth filter leaves no interfaces for the
  // standard gathering path. iceAdditionalHostAddresses bypasses the filter but candidates arrive asynchronously via onIceCandidate events.
  const collectedCandidates: string[] = [];

  pc.onIceCandidate.subscribe((candidate) => {

    if(candidate) {

      // Format as SDP candidate line.
      const line = "a=" + candidate.candidate;

      collectedCandidates.push(line);
      LOG.info("%sWebRTC: ICE candidate gathered: %s", logPrefix, candidate.candidate.substring(0, 60));
    }
  });

  // Create the offer.
  await pc.setLocalDescription(await pc.createOffer());

  LOG.info("%sWebRTC: ICE gathering state: %s", logPrefix, pc.iceGatheringState);

  // Wait for ICE gathering to complete — candidates arrive async.
  await new Promise<void>((resolve) => {

    if(pc.iceGatheringState === "complete") {

      resolve();

      return;
    }

    pc.iceGatheringStateChange.subscribe((state) => {

      if(state === "complete") {

        resolve();
      }
    });

    setTimeout(resolve, 5000);
  });

  LOG.info("%sWebRTC: gathered %d ICE candidates.", logPrefix, collectedCandidates.length);

  // Build the offer SDP. If localDescription already has candidates (macOS), use it as-is. Otherwise, manually inject the collected candidates.
  let offerSdp = pc.localDescription?.sdp ?? "";

  if(!offerSdp.includes("a=candidate") && (collectedCandidates.length > 0)) {

    // Inject candidates before the first m= line's attributes end (before the next m= or end of SDP).
    const lines = offerSdp.split("\r\n");
    const injected: string[] = [];

    for(const line of lines) {

      injected.push(line);

      // Add candidates after the media line attributes.
      if(line.startsWith("a=rtpmap")) {

        for(const candidate of collectedCandidates) {

          injected.push(candidate);
        }
      }
    }

    offerSdp = injected.join("\r\n");
    LOG.info("%sWebRTC: injected %d candidates into offer SDP.", logPrefix, collectedCandidates.length);
  }

  // Log the offer SDP media lines for debugging.
  const offerLines = offerSdp.split("\n").filter((l: string) => l.startsWith("m=") || l.startsWith("a=recvonly") || l.startsWith("a=sendonly") || l.startsWith("a=sendrecv") || l.startsWith("a=inactive") || l.startsWith("a=rtpmap"));

  LOG.info("%sWebRTC offer SDP: %s", logPrefix, offerLines.join(" | "));

  const setAnswer = async (answer: string): Promise<void> => {

    // Log answer SDP media lines.
    const answerLines = answer.split("\n").filter((l: string) => l.startsWith("m=") || l.startsWith("a=recvonly") || l.startsWith("a=sendonly") || l.startsWith("a=sendrecv") || l.startsWith("a=inactive") || l.startsWith("a=rtpmap") || l.startsWith("a=candidate"));

    LOG.info("%sWebRTC answer SDP: %s", logPrefix, answerLines.join(" | "));

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
