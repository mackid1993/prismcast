/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mpegts.ts: Minimal MPEG-TS packetizer for wrapping raw H264 Annex B frames with proper PTS timestamps.
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;
const STREAM_TYPE_H264 = 0x1b;

// MPEG CRC32 lookup table — must be initialized before buildPAT/buildPMT which use crc32().
const CRC32_TABLE = new Uint32Array(256);

for(let i = 0; i < 256; i++) {

  let crc = i << 24;

  for(let j = 0; j < 8; j++) {

    crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
  }

  CRC32_TABLE[i] = crc >>> 0;
}

function crc32(buffer: Buffer, start: number, end: number): number {

  let crc = 0xffffffff;

  for(let i = start; i < end; i++) {

    crc = (CRC32_TABLE[((crc >>> 24) ^ buffer[i]) & 0xff] ^ (crc << 8)) >>> 0;
  }

  return crc >>> 0;
}

// Pre-built PAT and PMT packets (fixed for single-program, single-H264-stream).
const PAT_PACKET = buildPAT();
const PMT_PACKET = buildPMT();

/**
 * MPEG-TS muxer state. Create one per stream, then call `mux()` for each H264 frame.
 */
export interface MpegTsMuxer {

  mux: (h264Frame: Buffer, isKeyframe: boolean) => Buffer;
}

/**
 * Creates an MPEG-TS muxer that wraps H264 Annex B frames in MPEG-TS packets with PTS.
 *
 * @param frameRate - Frames per second for PTS calculation (90kHz clock).
 * @returns Muxer with a `mux()` method that returns MPEG-TS packets for each frame.
 */
export function createMpegTsMuxer(): MpegTsMuxer {

  let videoContinuity = 0;
  let patContinuity = 0;
  const startTime = Date.now();

  const mux = (h264Frame: Buffer, isKeyframe: boolean): Buffer => {

    const packets: Buffer[] = [];

    // Write PAT + PMT before every keyframe (required for random access / segment starts).
    if(isKeyframe) {

      packets.push(setPATContinuity(patContinuity));
      patContinuity = (patContinuity + 1) & 0x0f;
      packets.push(setPMTContinuity(patContinuity));
      patContinuity = (patContinuity + 1) & 0x0f;
    }

    // Calculate PTS from wall-clock time (90kHz clock). Don't assume a fixed framerate —
    // Chrome's WebRTC encoder may produce variable frame rates.
    const pts = Math.round((Date.now() - startTime) * 90);

    // Build PES packet: header + H264 data.
    const pesHeader = buildPESHeader(pts);
    const pesPacket = Buffer.concat([ pesHeader, h264Frame ]);

    // Split PES packet into 188-byte TS packets.
    let offset = 0;
    let first = true;

    while(offset < pesPacket.length) {

      const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
      let headerSize = 4;

      // TS header.
      packet[0] = TS_SYNC_BYTE;
      packet[1] = (first ? 0x40 : 0x00) | ((VIDEO_PID >> 8) & 0x1f); // payload_unit_start + PID high
      packet[2] = VIDEO_PID & 0xff; // PID low
      // adaptation_field_control = 01 (payload only), continuity counter
      packet[3] = 0x10 | (videoContinuity & 0x0f);
      videoContinuity = (videoContinuity + 1) & 0x0f;

      // For the first packet of a keyframe, add a PCR via adaptation field.
      if(first && isKeyframe) {

        packet[3] = 0x30 | (packet[3] & 0x0f); // adaptation_field_control = 11 (adaptation + payload)

        const adaptationLength = 7; // 1 (flags) + 6 (PCR)

        packet[4] = adaptationLength;
        packet[5] = 0x10; // PCR flag
        writePCR(packet, 6, pts);
        headerSize = 4 + 1 + adaptationLength; // TS header + adaptation_length byte + adaptation
      }

      const payloadSize = TS_PACKET_SIZE - headerSize;
      const remaining = pesPacket.length - offset;
      const copySize = Math.min(payloadSize, remaining);

      // If this is the last packet and there's leftover space, stuff with adaptation field.
      if(copySize < payloadSize) {

        const stuffingSize = payloadSize - copySize;

        if(headerSize === 4) {

          // No adaptation field yet — add one with stuffing.
          packet[3] = 0x30 | (packet[3] & 0x0f);
          packet[4] = stuffingSize - 1; // adaptation_field_length (excludes length byte itself)

          if(stuffingSize > 1) {

            packet[5] = 0x00; // flags
            packet.fill(0xff, 6, 4 + stuffingSize); // stuffing bytes
          }

          pesPacket.copy(packet, 4 + stuffingSize, offset, offset + copySize);
        } else {

          // Already have adaptation field — extend it with stuffing.
          const existingAdaptLen = packet[4];
          const newAdaptLen = existingAdaptLen + stuffingSize;

          packet[4] = newAdaptLen;
          packet.fill(0xff, 4 + 1 + existingAdaptLen, 4 + 1 + newAdaptLen);
          pesPacket.copy(packet, 4 + 1 + newAdaptLen, offset, offset + copySize);
        }
      } else {

        pesPacket.copy(packet, headerSize, offset, offset + copySize);
      }

      offset += copySize;
      first = false;
      packets.push(packet);
    }

    return Buffer.concat(packets);
  };

  return { mux };
}

function buildPESHeader(pts: number): Buffer {

  // PES header: start code (3) + stream_id (1) + length (2) + flags (2) + header_data_length (1) + PTS (5) = 14 bytes.
  const header = Buffer.alloc(14);

  // Start code: 00 00 01
  header[0] = 0x00;
  header[1] = 0x00;
  header[2] = 0x01;

  // Stream ID: 0xE0 (video stream 0).
  header[3] = 0xe0;

  // PES packet length: 0 for unbounded (valid for video PES in TS).
  header[4] = 0x00;
  header[5] = 0x00;

  // Flags: 10xx xxxx — marker bits (10), no scrambling, no priority, no alignment, no copyright, no original.
  header[6] = 0x80;
  // PTS flag: 1xxx xxxx (PTS present, no DTS).
  header[7] = 0x80;

  // PES header data length: 5 bytes (PTS only).
  header[8] = 0x05;

  // PTS encoding: 0010_xxx1 xxxx_xxx1 xxxx_xxx1 xxxx_xxx1 xxxx_xxx1
  writePTS(header, 9, pts);

  return header;
}

function writePTS(buffer: Buffer, offset: number, pts: number): void {

  // PTS is 33 bits encoded in 5 bytes with marker bits.
  const ptsHigh = Math.floor(pts / 0x100000000) & 0x01; // bit 32
  const ptsLow = pts >>> 0;

  buffer[offset] = 0x21 | (ptsHigh << 3) | (((ptsLow >>> 29) & 0x07) << 1); // 0010 xxx1
  buffer[offset + 1] = (ptsLow >>> 22) & 0xff;
  buffer[offset + 2] = ((ptsLow >>> 14) & 0xff) | 0x01; // marker bit
  buffer[offset + 3] = (ptsLow >>> 7) & 0xff;
  buffer[offset + 4] = ((ptsLow << 1) & 0xff) | 0x01; // marker bit
}

function writePCR(buffer: Buffer, offset: number, pts: number): void {

  // PCR = 33-bit base (90kHz) + 6 reserved + 9-bit extension (27MHz). We use PTS as base, extension = 0.
  const pcrBase = pts >>> 0;
  const pcrHigh = Math.floor(pts / 0x100000000) & 0x01;

  buffer[offset] = ((pcrHigh << 7) | (pcrBase >>> 25)) & 0xff;
  buffer[offset + 1] = (pcrBase >>> 17) & 0xff;
  buffer[offset + 2] = (pcrBase >>> 9) & 0xff;
  buffer[offset + 3] = (pcrBase >>> 1) & 0xff;
  buffer[offset + 4] = ((pcrBase << 7) | 0x7e) & 0xff; // 6 reserved bits = 1
  buffer[offset + 5] = 0x00; // extension = 0
}

function buildPAT(): Buffer {

  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);

  // TS header.
  packet[0] = TS_SYNC_BYTE;
  packet[1] = 0x40 | ((PAT_PID >> 8) & 0x1f); // payload_unit_start
  packet[2] = PAT_PID & 0xff;
  packet[3] = 0x10; // payload only, continuity = 0

  // Pointer field (required when payload_unit_start = 1).
  packet[4] = 0x00;

  // PAT section: table_id=0, section_syntax=1, length=13 (fixed for 1 program).
  const section = Buffer.from([
    0x00, // table_id
    0xb0, 0x0d, // section_syntax_indicator + section_length (13 bytes follow)
    0x00, 0x01, // transport_stream_id
    0xc1, // version=0, current_next=1
    0x00, 0x00, // section_number, last_section_number
    0x00, 0x01, // program_number = 1
    0xe0 | ((PMT_PID >> 8) & 0x1f), PMT_PID & 0xff // PMT PID
  ]);

  section.copy(packet, 5);

  // CRC32.
  const crc = crc32(packet, 5, 5 + section.length);

  packet.writeUInt32BE(crc, 5 + section.length);

  return packet;
}

function buildPMT(): Buffer {

  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);

  // TS header.
  packet[0] = TS_SYNC_BYTE;
  packet[1] = 0x40 | ((PMT_PID >> 8) & 0x1f);
  packet[2] = PMT_PID & 0xff;
  packet[3] = 0x10;

  // Pointer field.
  packet[4] = 0x00;

  // PMT section: table_id=2, 1 H264 stream.
  const section = Buffer.from([
    0x02, // table_id
    0xb0, 0x12, // section_syntax_indicator + section_length (18 bytes follow)
    0x00, 0x01, // program_number = 1
    0xc1, // version=0, current_next=1
    0x00, 0x00, // section_number, last_section_number
    0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, // PCR PID = video PID
    0xf0, 0x00, // program_info_length = 0
    STREAM_TYPE_H264, // stream_type = H264
    0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, // elementary PID
    0xf0, 0x00 // ES_info_length = 0
  ]);

  section.copy(packet, 5);

  const crc = crc32(packet, 5, 5 + section.length);

  packet.writeUInt32BE(crc, 5 + section.length);

  return packet;
}

function setPATContinuity(cc: number): Buffer {

  const packet = Buffer.from(PAT_PACKET);

  packet[3] = (packet[3] & 0xf0) | (cc & 0x0f);

  return packet;
}

function setPMTContinuity(cc: number): Buffer {

  const packet = Buffer.from(PMT_PACKET);

  packet[3] = (packet[3] & 0xf0) | (cc & 0x0f);

  return packet;
}

// CRC32 table and function are defined at the top of the file (before PAT/PMT initialization).
