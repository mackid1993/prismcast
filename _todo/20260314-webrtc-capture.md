# WebRTC Capture for PrismCast

Replace MediaRecorder with WebRTC for video/audio capture to eliminate frame drops on Linux.

## Problem
Chrome's MediaRecorder on Linux uses a software H264 encoder that drops ~15% of frames. On macOS (VideoToolbox hardware encoder), no drops. WebRTC uses a different encoder path that doesn't drop frames.

## Phase Checklist
- [x] Phase 1: Research — MediaRecorder drops, WebCodecs blocked, werift ICE broken
- [x] Phase 2: Architecture — @roamhq/wrtc native WebRTC bindings
- [x] Phase 3: Implementation — monkey-patch, signaling, RTCVideoSink/AudioSink
- [x] Phase 4: Video quality — resolution fixed, frame pacing broken (rawvideo path abandoned)
- [ ] **Phase 5: H264 passthrough** — Encoded Transform API, `-c:v copy`, zero re-encode
- [ ] Phase 6: Stability — ECONNRESET, long-running streams
- [ ] Phase 7: Cleanup — squash commits, clean PR

## Current State

### Two active branches:

**`webrtc-capture`** (commit `c71705a`) — RTCVideoSink I420 rawvideo path. Works but has serious issues:
- Frame pacing broken (stuttery every few seconds despite `-fps_mode cfr`, `-force_key_frames`, `-g 9999`)
- Audio is white noise — SDP patching on Chrome's answer side added but untested (16kHz mono → should be 48kHz stereo)
- High CPU — 186MB/s raw I420 through FFmpeg for re-encoding
- ECONNRESET after ~40s (uncaught exception, stream dies)
- Resolution and framing are correct (tabCapture constraints work)
- Segments produce at real-time speed (wall-clock timestamps fixed the muxer stall)

**`webrtc-h264-passthrough`** (commit `39548c3`) — NEW, Encoded Transform API. WIP:
- Chrome's `createEncodedStreams()` intercepts H264 BEFORE RTP packetization
- Must be called immediately after `addTrack()`, before `setParameters()` — fixed "Too late" error
- H264 frames sent over WebSocket (0x03 prefix) to Node.js
- FFmpeg uses `-c:v copy` (zero CPU for video, no re-encode)
- Audio still via RTCAudioSink (PCM)
- **UNTESTED** — pushed, CI passes, needs Docker build + test

## Next Session: Start Here

1. **Build and test `webrtc-h264-passthrough` branch in Docker**
2. Check logs for: "H264 passthrough enabled" (means createEncodedStreams worked)
3. If it works, verify video plays on TV — may need to debug H264 frame format (Annex B vs AVCC)
4. If H264 data isn't Annex B, add start code injection (`00 00 00 01` before each NAL unit)
5. If createEncodedStreams fails, try `RTCRtpScriptTransform` with inline Worker (Blob URL)

## Tasks

### Done
- [x] Monkey-patch START_RECORDING in puppeteer-stream extension
- [x] Native WebRTC peer via @roamhq/wrtc (replaced broken werift)
- [x] ICE candidate generation (40 candidates in Docker)
- [x] SDP signaling: Node.js offers, Chrome answers
- [x] RTCVideoSink — decoded I420 frames from Chrome
- [x] RTCAudioSink — raw s16le PCM audio from Chrome (format detection: sampleRate, channelCount)
- [x] FFmpeg dual-input: rawvideo fd3 + s16le fd4
- [x] VA-API hardware encoding via system FFmpeg
- [x] tabCapture video constraints (resolution + framerate from config)
- [x] Defer FFmpeg spawn until first frame dimensions + audio format known
- [x] Add audio track to Chrome's peer connection
- [x] Wall-clock timestamps for real-time segment production
- [x] Segment log format fix (%.2f → .toFixed(2))
- [x] H264 passthrough: createEncodedStreams() in monkey-patch (moved before setParameters)
- [x] H264 passthrough: spawnH264PassthroughFFmpeg() with `-c:v copy`
- [x] H264 passthrough: setup.ts routes 0x03 WebSocket data to FFmpeg video pipe
- [x] H264 passthrough: falls back to rawvideo if Encoded Transform unavailable

### To Do (H264 passthrough branch)
- [ ] Test H264 passthrough in Docker — does video play?
- [ ] Debug H264 frame format (Annex B? AVCC? Need start codes?)
- [ ] Debug puppeteer-stream WebSocket framing (messages delivered intact?)
- [ ] Fix audio (SDP patching on answer side, or find alternative)
- [ ] Test long-running stability (ECONNRESET still an issue?)
- [ ] Gate WebRTC path (PRISMCAST_CONTAINER or feature flag?)
- [ ] Test channel switching / tab replacement
- [ ] Squash commits for clean PR

## Architecture

### H264 Passthrough (new, preferred):
```
Chrome extension (monkey-patch):
  tabCapture → RTCPeerConnection.addTrack(video + audio)
  → createEncodedStreams() intercepts H264 BEFORE RTP
  → H264 frames sent over WebSocket (0x03 prefix)

Node.js:
  rawCaptureStream parses 0x03 prefix → H264 to FFmpeg fd3
  RTCAudioSink: raw PCM → FFmpeg fd4
  FFmpeg: -c:v copy + -c:a aac → fMP4
  Segmenter → HLS/MPEG-TS
```

### Rawvideo fallback (working but broken pacing):
```
Chrome → RTP → @roamhq/wrtc RTCVideoSink (I420) → FFmpeg rawvideo → h264_vaapi → fMP4
```

## Key Files
- `src/browser/index.ts` — monkey-patch with createEncodedStreams (~line 863-898)
- `src/streaming/setup.ts` — H264 passthrough routing (~line 583-630), rawvideo fallback (~line 632+)
- `src/utils/ffmpeg.ts` — spawnH264PassthroughFFmpeg (~line 563-684), spawnWebRTCFFmpeg (~line 375-550)
- `src/utils/webrtcCapture.ts` — native WebRTC peer, RTCVideoSink/AudioSink, audio format detection

## Lore (Session Discoveries)

### createEncodedStreams() timing is critical
Must call immediately after `addTrack()`, BEFORE `setParameters()` or `setRemoteDescription()`. Otherwise throws "Too late to create encoded streams". Chrome 86-149+ supports it (confirmed via caniuse).

### RTCAudioSink delivers 16kHz mono by default
Without SDP Opus parameters (`stereo=1;maxplaybackrate=48000`), Chrome negotiates narrowband mono. Patching the OFFER SDP doesn't work — must patch Chrome's ANSWER SDP (the answerer's local description controls encoding). SDP patch added to monkey-patch but untested.

### Wall-clock timestamps cause frame jitter
`-use_wallclock_as_timestamps 1` on rawvideo input causes stuttery output because pipe I/O backpressure makes frame read timing irregular. Even with `-fps_mode cfr -r 60`, the jitter is visible. Switched to input `-r 60` for smooth PTS, with wall-clock on audio only.

### h264_vaapi ignores -g, inserts extra keyframes
Despite `-g 9999` and `-force_key_frames "expr:gte(t,n_forced*2)"`, h264_vaapi still inserts 1-second keyframes. Results in irregular segment sizes (mix of 2s and 4s segments).

### tabCapture constraints fix resolution
Adding `videoConstraints.mandatory` with min/max width/height/frameRate to `chrome.tabCapture.capture()` makes Chrome deliver at the configured resolution (1920x1080) instead of Xvfb screen size (2160x1440). Eliminates need for center crop.

### puppeteer-stream WebSocket passes data through raw
`ws.on("message", (data) => stream.write(data))` — no prefix stripping, no parsing. Raw binary WebSocket messages go straight to the stream. Our 0x03 prefix for H264 will be in rawCaptureStream.

### H264 frame format unknown
RTCEncodedVideoFrame.data format from createEncodedStreams() is unconfirmed. Likely Annex B (start codes) since it's pre-packetizer, but could be AVCC (length-prefixed). FFmpeg `-f h264` expects Annex B. If wrong, need to inject `00 00 00 01` start codes.

## Failed Approaches
1. **werift** — ICE broken in Docker
2. **WebCodecs VideoEncoder** — Chrome blocks hardware H264 on Linux
3. **x11grab / gpu-screen-recorder** — integration nightmares
4. **Wall-clock timestamps for rawvideo** — pipe I/O jitter causes visible stutter
5. **SDP Opus patch on offer side** — doesn't change Chrome's encoder; must patch answer
6. **-g flag for h264_vaapi GOP** — encoder ignores it, inserts extra keyframes
7. **-fps_mode cfr with wall-clock** — doesn't smooth out the underlying jitter
