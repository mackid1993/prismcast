# WebRTC Capture for PrismCast

Replace MediaRecorder with WebRTC for video/audio capture to eliminate frame drops on Linux.

## Problem
Chrome's MediaRecorder on Linux uses a software H264 encoder that drops ~15% of frames. On macOS (VideoToolbox hardware encoder), no drops. WebRTC uses a different encoder path that doesn't drop frames.

## Phase Checklist
- [x] Phase 1: Research — MediaRecorder drops, WebCodecs blocked, werift ICE broken
- [x] Phase 2: Architecture — @roamhq/wrtc native WebRTC bindings
- [x] Phase 3: Implementation — monkey-patch, signaling, RTCVideoSink/AudioSink
- [ ] Phase 4: Video quality — crop/resolution, frame rate, AV sync
- [ ] Phase 5: Stability — ECONNRESET at 40s, long-running streams
- [ ] Phase 6: Cleanup — squash commits, clean PR

## Current State
**Branch:** `webrtc-capture` (based on `ffmpeg-fix-dropped-frames`)

Video plays on TV with correct frame pacing. Audio + video both via WebRTC. Latest: added tabCapture video constraints (width/height/framerate) so Chrome delivers at the user's configured resolution instead of Xvfb screen size — eliminates need for center crop.

## Tasks

### Done
- [x] Monkey-patch START_RECORDING in puppeteer-stream extension
- [x] Native WebRTC peer via @roamhq/wrtc (replaced broken werift)
- [x] ICE candidate generation (40 candidates in Docker)
- [x] SDP signaling: Node.js offers, Chrome answers
- [x] Trickle ICE for candidates not in SDP
- [x] RTCVideoSink — decoded I420 frames from Chrome
- [x] RTCAudioSink — raw s16le PCM audio from Chrome
- [x] FFmpeg dual-input: raw video fd3 + raw audio fd4
- [x] VA-API hardware encoding via system FFmpeg
- [x] Center crop 2160x1440 → 1920x1080 (viewport)
- [x] Output frame rate from user config
- [x] Defer FFmpeg spawn until first frame dimensions known
- [x] Add audio track to Chrome's peer connection
- [x] createRequire for ESM→CJS import of native module
- [x] Remove werift dependency, clean up references

### To Do
- [ ] Test latest build (tabCapture constraints + segment log fix)
- [ ] Fix ECONNRESET after ~40s (stream dies, needs investigation)
- [ ] Verify AV sync with WebRTC audio (both from same connection)
- [ ] Verify frame rate now respects user's config (constraints added)
- [ ] Remove MediaRecorder audio code from monkey-patch (no longer needed)
- [ ] Gate WebRTC path (PRISMCAST_CONTAINER or feature flag?)
- [ ] Test with different quality presets (720p, 480p, 4K)
- [ ] Test channel switching / tab replacement
- [ ] Squash commits for clean PR
- [ ] Update memory file with final state

## Architecture
```
Chrome extension (monkey-patch):
  tabCapture → RTCPeerConnection.addTrack(video + audio)
  → Chrome encodes, sends RTP to Node.js

Node.js (@roamhq/wrtc):
  RTCPeerConnection receives RTP
  → RTCVideoSink: decoded I420 frames → PassThrough stream
  → RTCAudioSink: raw s16le PCM → PassThrough stream
  → FFmpeg: rawvideo fd3 + s16le fd4 → center crop → h264_vaapi → fMP4
  → Segmenter → HLS/MPEG-TS

Fallback: standard MediaRecorder pipeline if WebRTC not available
```

## Key Files
- `src/utils/webrtcCapture.ts` — native WebRTC peer, sinks, streams
- `src/browser/index.ts` — monkey-patch (~line 830-970)
- `src/streaming/setup.ts` — signaling + FFmpeg spawn (~line 487-600)
- `src/utils/ffmpeg.ts` — spawnWebRTCFFmpeg with crop + VA-API (~line 375-450)
- `Dockerfile` — system ffmpeg, @roamhq/wrtc (native, needs build tools)

## Lore (Session Discoveries)

### werift is broken in Docker
werift's pure-TypeScript ICE implementation filters out Docker's network interfaces (veth ban list). Even with iceAdditionalHostAddresses, candidates appear in events but never in localDescription SDP. GitHub issues #400, #402 confirm bugs. Spent hours debugging — DON'T USE WERIFT.

### @roamhq/wrtc works perfectly
Native WebRTC M98 bindings. 40 ICE candidates generated instantly in Docker. Published 4 days ago, actively maintained. Uses createRequire for ESM compatibility.

### RTCVideoSink frame structure
`{ type: "frame", frame: { width, height, rotation, data } }` — NOT `{ data, width, height }`. The `data` is a Uint8Array of I420 pixels. Must use `Buffer.from(event.frame.data)`.

### RTCAudioSink frame structure
`{ samples: Buffer }` — raw s16le PCM at 48kHz stereo.

### Chrome captures at screen size, not viewport
tabCapture gives 2160x1440 (Xvfb screen) even though viewport is 1920x1080. Must crop to viewport dimensions. Content position TBD — center crop assumed.

### FFmpeg rawvideo input rate
Do NOT set `-r` on input for rawvideo — it makes FFmpeg interpret frames at the wrong speed (2x if set to 60 but frames arrive at 30). Set `-r` on OUTPUT only. For dual-input (video+audio), use `-use_wallclock_as_timestamps 1` on BOTH inputs so video and audio PTS advance at real time. Without this, rawvideo defaults to 25fps PTS, racing 2.4x ahead of real-time audio, stalling the muxer and producing segments 3-6x slower than real time.

### FFmpeg needs both inputs
With dual-input (fd3 video + fd4 audio), FFmpeg won't produce ANY output until BOTH inputs have data. Missing audio track = no segments = stream timeout.

### VA-API works for re-encode
System FFmpeg (`/usr/bin/ffmpeg`) with h264_vaapi confirmed working. Filter chain: `crop=W:H:X:Y,format=nv12,hwupload` → h264_vaapi.

### tabCapture needs video constraints
Without `videoConstraints` in `chrome.tabCapture.capture()`, Chrome delivers video at the Xvfb screen resolution (e.g., 2160x1440) instead of the user's configured viewport (e.g., 1920x1080). The standard MediaRecorder path passes mandatory min/max width/height/frameRate constraints — the WebRTC monkey-patch must do the same.

### ECONNRESET at 40s
Stream consistently dies after ~40 seconds with "read ECONNRESET". Likely from the standard MediaRecorder pipeline's FFmpeg (VA-API path) failing in the fallback code, or puppeteer-stream's WebSocket closing.

### Raw H264 interception (research)
@roamhq/wrtc's RTCVideoSink only gives decoded I420 — no API for raw H264 or RTP. No Node.js WebRTC library exposes encoded frames. However, Chrome's **Encoded Transform API** (`RTCRtpSender.createEncodedStreams()` or `RTCRtpScriptTransform`) can intercept H264 frames on the browser side BEFORE RTP packetization. The monkey-patch runs in Chrome's extension context — could intercept encoded frames and send via WebSocket to Node.js, where FFmpeg does `-c:v copy` (no re-encode). Would solve CPU, pacing, and quality in one shot.

## Failed Approaches
1. **werift** — ICE broken in Docker, wasted many hours
2. **WebCodecs VideoEncoder** — Chrome blocks hardware H264 on Linux
3. **x11grab / gpu-screen-recorder** — External capture tools, integration nightmares
4. **Xorg dummy driver** — Proper 60Hz but loses all GPU acceleration
5. **trun normalization in segmenter** — Caused AV desync and slow playback
6. **requestAnimationFrame pump** — Doubled frame duplications, stole CPU
7. **100Mbps capture bitrate** — Didn't prevent MediaRecorder frame drops
8. **Page.screencast()** — JPEG screenshots, unusable for live video
