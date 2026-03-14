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
/**
 * Audio format from RTCAudioSink's first callback.
 */
export interface WebRTCAudioFormat {

  bitsPerSample: number;
  channelCount: number;
  sampleRate: number;
}

export interface WebRTCCapturePeer {

  // Promise that resolves with the audio format from the first RTCAudioSink callback.
  audioFormat: Promise<WebRTCAudioFormat>;

  // Readable stream of raw PCM audio.
  audioStream: Readable;

  // Collected ICE candidates (unused with native — SDP includes them).
  candidates: string[];

  // Gracefully close the peer connection.
  close: () => void;

  // Promise that resolves with the first frame's dimensions.
  firstFrameDimensions: Promise<{ height: number; width: number }>;

  // The SDP offer to send to Chrome.
  offer: string;

  // Set Chrome's SDP answer.
  setAnswer: (answer: string) => Promise<void>;

  // Readable stream of raw I420 video frames.
  videoStream: Readable;
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
  const audioOutput = new PassThrough();
  let closed = false;

  // Promise for the audio format — setup.ts waits for this before spawning FFmpeg.
  let resolveAudioFormat: (format: WebRTCAudioFormat) => void;
  const audioFormat = new Promise<WebRTCAudioFormat>((resolve) => {

    resolveAudioFormat = resolve;
  });

  // Dynamic import for ESM compatibility — @roamhq/wrtc is a CommonJS native addon.

  const pc = new wrtc.RTCPeerConnection() as RTCPeerConnection;

  // Add recvonly transceivers for both video and audio from Chrome.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  // Promise for the first frame's dimensions — setup.ts waits for this before spawning FFmpeg.
  let resolveDimensions: (dims: { height: number; width: number }) => void;
  const firstFrameDimensions = new Promise<{ height: number; width: number }>((resolve) => {

    resolveDimensions = resolve;
  });

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
          resolveDimensions({ height: evt.frame.height, width: evt.frame.width });
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
    } else if(event.track.kind === "audio") {

      LOG.info("%sWebRTC: audio track received.", logPrefix);

      // Use RTCAudioSink to get raw PCM audio samples — synchronized with video via WebRTC.
      const audioSink: any = new wrtc.nonstandard.RTCAudioSink(event.track);
      let firstAudio = true;

      audioSink.ondata = (evt: { bitsPerSample: number; channelCount: number; numberOfFrames: number; sampleRate: number; samples: Buffer }): void => {

        if(closed) {

          return;
        }

        if(firstAudio) {

          firstAudio = false;
          LOG.info("%sWebRTC: audio format %dHz %dch %dbit, %d frames.",
            logPrefix, evt.sampleRate, evt.channelCount, evt.bitsPerSample, evt.numberOfFrames);
          resolveAudioFormat({ bitsPerSample: evt.bitsPerSample, channelCount: evt.channelCount, sampleRate: evt.sampleRate });
        }

        audioOutput.write(Buffer.from(evt.samples));
      };
    }
  };

  // Create the offer and wait for ICE gathering. Audio SDP patching happens on Chrome's answer side (in the monkey-patch)
  // because the answerer's local description controls encoding behavior — patching the offer alone doesn't change Chrome's encoder.
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

  // Force H264 in the SDP offer. @roamhq/wrtc doesn't include H264 (no OpenH264), so we inject it
  // synthetically. Chrome will see H264 in the offer and encode H264 — the Encoded Transform API
  // intercepts the frames before RTP, so the native peer never needs to decode H264.
  let offerSdp = pc.localDescription?.sdp ?? "";
  const videoMLine = /^(m=video \d+ [A-Z/]+ )([\d ]+)/m.exec(offerSdp);

  if(videoMLine) {

    // Find existing H264 payload types (in case a future @roamhq/wrtc version includes them).
    const h264PTs: string[] = [];
    const rtpmapMatches = offerSdp.matchAll(/a=rtpmap:(\d+) H264\//gi);

    for(const m of rtpmapMatches) {

      h264PTs.push(m[1]);
    }

    if(h264PTs.length > 0) {

      // H264 already present — just reorder to prefer it.
      const allPTs = videoMLine[2].trim().split(/\s+/);
      const reordered = [ ...h264PTs, ...allPTs.filter((pt) => !h264PTs.includes(pt)) ];

      offerSdp = offerSdp.replace(videoMLine[0], videoMLine[1] + reordered.join(" "));
      LOG.info("%sWebRTC: SDP reordered to prefer H264 (PTs: %s).", logPrefix, h264PTs.join(", "));
    } else {

      // Inject H264 synthetically. Pick a PT not already in use.
      const usedPTs = new Set(videoMLine[2].trim().split(/\s+/));
      let h264PT = "126";

      for(let pt = 126; pt >= 96; pt--) {

        if(!usedPTs.has(String(pt))) {

          h264PT = String(pt);

          break;
        }
      }

      // Add H264 PT to front of m-line so Chrome prefers it.
      offerSdp = offerSdp.replace(videoMLine[0], videoMLine[1] + h264PT + " " + videoMLine[2].trim());

      // Insert H264 rtpmap/fmtp/rtcp-fb lines after the video m-line. Constrained Baseline Profile (42e01f)
      // is the most widely supported H264 profile in WebRTC.
      const h264Attrs = [
        "a=rtpmap:" + h264PT + " H264/90000",
        "a=fmtp:" + h264PT + " level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        "a=rtcp-fb:" + h264PT + " nack",
        "a=rtcp-fb:" + h264PT + " nack pli",
        "a=rtcp-fb:" + h264PT + " goog-remb",
        "a=rtcp-fb:" + h264PT + " transport-cc"
      ].join("\r\n");

      // Insert after the m=video line.
      offerSdp = offerSdp.replace(videoMLine[0], videoMLine[0] + "\r\n" + h264Attrs);

      LOG.info("%sWebRTC: injected H264 into SDP offer (PT %s).", logPrefix, h264PT);
    }
  }

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
    audioOutput.end();
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

    audioFormat,
    audioStream: audioOutput,
    candidates: [],
    close,
    firstFrameDimensions,
    offer: offerSdp,
    setAnswer,
    videoStream: videoOutput
  };
}
