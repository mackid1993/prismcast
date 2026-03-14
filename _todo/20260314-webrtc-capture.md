# WebRTC Capture for PrismCast

Replace MediaRecorder with WebRTC for video/audio capture to eliminate frame drops on Linux.

## Problem
Chrome's MediaRecorder on Linux uses a software H264 encoder that drops ~15% of frames. WebRTC uses hardware-accelerated encoding that doesn't drop frames.

## Phase Checklist
- [x] Phase 1: Research — MediaRecorder drops, WebCodecs blocked, werift ICE broken
- [x] Phase 2: Architecture — @roamhq/wrtc native WebRTC bindings
- [x] Phase 3: Implementation — monkey-patch, signaling, RTCVideoSink/AudioSink
- [x] Phase 4: Rawvideo path — works but abandoned (frame pacing, CPU, audio issues)
- [ ] **Phase 5: H264 passthrough** — Encoded Transform API, `-c:v copy`, TESTING
- [ ] Phase 6: Stability — ECONNRESET, long-running streams
- [ ] Phase 7: Cleanup — squash commits, clean PR

## Current State

**Active branch:** `webrtc-h264-passthrough` — **TESTING, three fixes applied**

Chrome's `createEncodedStreams()` intercepts H264 before RTP packetization. FFmpeg uses `-c:v copy` (zero CPU for video). Audio via MediaRecorder WebM/Opus (48kHz stereo, not RTCAudioSink's 16kHz mono).

**What's confirmed working:**
- `createEncodedStreams()` works in Chrome 146 (must call immediately after `addTrack()`)
- H264 data flows through WebSocket (0x03 prefix) to Node.js
- FFmpeg receives data and produces segments
- `generateKeyFrame()` timer set at `segmentDuration` intervals

**What failed on test of `cb817ff`:**
- Segments had wrong timing (13.16s media in 3.34s wall) — `use_wallclock_as_timestamps` doesn't work because H264 arrives in I/O bursts
- No video output — likely H264 frames missing Annex B start codes
- Audio broken — MediaRecorder starts seconds before WebRTC, causing stream offset

**Fixes applied (uncommitted):**
1. Replaced `-use_wallclock_as_timestamps 1` with `-framerate <fps>` for deterministic PTS assignment
2. Added Annex B start code detection/injection — logs first frame bytes for format diagnosis
3. Buffer early audio until first H264 frame arrives — preserves WebM header, drops intermediate chunks

## Next Session: Start Here

1. **Build and test in Docker** — look for new diagnostic logs
2. Check `"H264 passthrough: first frame"` log — verify byte format (Annex B = `00 00 00 01`, AVCC = length prefix)
3. Check `"injecting Annex B start codes"` — tells you if Chrome's data needed start code injection
4. Check `"dropped N early audio chunks"` — confirms audio sync is working
5. Check segment timing: should now be ~2s media per ~2s wall
6. If video still doesn't play: may need to handle multi-NAL-unit frames (SPS+PPS+IDR) differently

## Tasks

### Done
- [x] Monkey-patch with createEncodedStreams() (immediately after addTrack)
- [x] H264 frames over WebSocket (0x03 prefix, byte 1 = keyframe flag)
- [x] spawnH264PassthroughFFmpeg: `-f h264 -i pipe:3` + `-f webm -i pipe:4` + `-c:v copy -c:a aac`
- [x] setup.ts routes 0x03 → video pipe, 0x02 → audio pipe from rawCaptureStream
- [x] generateKeyFrame() every segmentDuration seconds for segment-aligned keyframes
- [x] Wall-clock timestamps on H264 input for correct PTS
- [x] Fallback to rawvideo path if createEncodedStreams unavailable
- [x] tabCapture video constraints (resolution + framerate from config)
- [x] Pass all config to monkey-patch: bitrate, framerate, resolution, segment duration

### To Do
- [ ] Test H264 passthrough end-to-end (video + audio on TV)
- [ ] Verify H264 frame format (Annex B vs AVCC)
- [ ] Verify MediaRecorder WebM/Opus chunks work as FFmpeg input
- [ ] Verify segment timing (~2s media per ~2s wall)
- [ ] Test ECONNRESET / long-running stability
- [ ] Test channel switching / tab replacement
- [ ] Gate WebRTC path (feature flag or container detection)
- [ ] Squash commits for clean PR

## Architecture

### H264 Passthrough (active):
```
Chrome monkey-patch:
  tabCapture → addTrack → createEncodedStreams() (IMMEDIATELY, before setParameters)
  → TransformStream intercepts H264 frames → WebSocket (0x03 prefix)
  → MediaRecorder (audio-only WebM/Opus) → WebSocket (0x02 prefix)
  → generateKeyFrame() every segmentDuration seconds

Node.js (setup.ts):
  rawCaptureStream.on("data"):
    0x03 → strip 2-byte prefix → FFmpeg pipe:3 (H264 video)
    0x02 → strip 1-byte prefix → FFmpeg pipe:4 (WebM/Opus audio)
  FFmpeg: -c:v copy + -c:a aac → fMP4 → Segmenter → HLS/MPEG-TS
```

### Rawvideo fallback (abandoned, kept as fallback):
```
Chrome → RTP → @roamhq/wrtc RTCVideoSink (I420) → FFmpeg rawvideo → h264_vaapi
Issues: frame pacing broken, 186MB/s CPU burn, audio 16kHz mono
```

## Key Files
- `src/browser/index.ts` — monkey-patch: createEncodedStreams, generateKeyFrame, SDP patch (~line 869-900)
- `src/streaming/setup.ts` — H264 passthrough routing: 0x03→video, 0x02→audio (~line 583-635)
- `src/utils/ffmpeg.ts` — spawnH264PassthroughFFmpeg (~line 563-684)
- `src/utils/webrtcCapture.ts` — native WebRTC peer (used by both paths)

## Lore

### createEncodedStreams() timing
Must call immediately after `addTrack()`, before `setParameters()` or `setRemoteDescription()`. Chrome throws "Too late to create encoded streams" otherwise. Confirmed working in Chrome 146 (supported since Chrome 86).

### H264 frame format unknown
`RTCEncodedVideoFrame.data` format unconfirmed. Likely Annex B (start codes `00 00 00 01`) since it's pre-RTP-packetizer. FFmpeg `-f h264` expects Annex B. If AVCC (length-prefixed), need start code injection.

### puppeteer-stream passes WebSocket data raw
`ws.on("message", (data) => stream.write(data))` — no parsing, no prefix stripping. The 0x02 and 0x03 prefixed messages appear in rawCaptureStream as-is.

### RTCAudioSink negotiates 16kHz mono
Without SDP Opus parameters, Chrome's WebRTC defaults to narrowband mono. SDP patch on Chrome's answer side was added but untested. MediaRecorder audio bypasses this entirely — captures tab audio at native quality.

### Wall-clock timestamps DON'T work for H264 passthrough
`-use_wallclock_as_timestamps 1` assigns PTS based on when FFmpeg reads from the pipe, not when frames were captured. H264 data arrives through WebSocket → Node.js → pipe with I/O batching, causing bursts. Result: 13s media in 3s wall (frames arrive faster than real-time in bursts). Use `-framerate <fps>` instead for deterministic PTS.

### MediaRecorder starts before WebRTC
`recorder.start(20)` runs in `PRISMCAST_START_RECORDING` but H264 frames only flow after `WEBRTC_CONNECT`. Audio stream is seconds ahead of video, causing FFmpeg sync issues. Must buffer early WebM chunks and only start feeding audio when first H264 frame arrives.

### generateKeyFrame() for segment alignment
With `-c:v copy`, FFmpeg can't insert keyframes. Chrome's encoder must produce them. `RTCRtpSender.generateKeyFrame()` requests an IDR frame at `segmentDuration` intervals (e.g., every 2s).

## Failed Approaches
1. **werift** — ICE broken in Docker
2. **WebCodecs VideoEncoder** — Chrome blocks hardware H264 on Linux
3. **RTCVideoSink rawvideo path** — frame pacing broken, 186MB/s CPU burn, audio 16kHz mono
4. **Wall-clock timestamps on rawvideo** — pipe I/O jitter causes visible stutter
8. **`use_wallclock_as_timestamps` for H264 passthrough** — I/O batching causes bursts (13s media in 3s wall). Use `-framerate` instead
5. **SDP Opus patch on offer side** — doesn't change Chrome's encoder; must patch answer
6. **h264_vaapi -g flag** — encoder ignores it, inserts extra keyframes
7. **createEncodedStreams after setParameters** — "Too late" error, must call right after addTrack
