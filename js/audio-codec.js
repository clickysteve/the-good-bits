// audio-codec.js
//
// Manual WAV and AIFF readers/writers, operating directly on ArrayBuffer /
// DataView. WAV and AIFF are both just headers around raw PCM, so decoding
// them by hand is straightforward and — unlike the browser's built-in
// decodeAudioData — gives byte-exact, dependable results across every
// browser, at the source file's original sample rate and bit depth, with
// no implicit resampling. Compressed formats (MP3/M4A/FLAC) still go
// through decodeAudioData in app.js; this file only has to know PCM.
//
// Nothing here touches the DOM, so it can be unit-tested in Node.

/** A minimal AudioBuffer-shaped object so the rest of the app can treat
 *  manually-parsed audio the same way as a real browser AudioBuffer. */
function makeBufferLike(sampleRate, channelData) {
  return {
    sampleRate,
    numberOfChannels: channelData.length,
    length: channelData[0].length,
    getChannelData(i) {
      return channelData[i];
    },
  };
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

export function parseWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, false) !== 0x52494646 /* 'RIFF' */) {
    throw new Error("Not a RIFF/WAV file");
  }
  const riffFormat = dv.getUint32(8, false);
  if (riffFormat !== 0x57415645 /* 'WAVE' */) {
    throw new Error("RIFF file is not WAVE format");
  }

  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLen = 0;

  while (pos + 8 <= dv.byteLength) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;

    if (id === 0x666d7420 /* 'fmt ' */) {
      const audioFormat = dv.getUint16(body, true);
      const numChannels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      let format = audioFormat;
      if (audioFormat === 0xfffe && size >= 24) {
        // WAVE_FORMAT_EXTENSIBLE: real format is the first two bytes of
        // the sub-format GUID, 24 bytes into the fmt chunk body.
        format = dv.getUint16(body + 24, true);
      }
      fmt = { format, numChannels, sampleRate, bitsPerSample };
    } else if (id === 0x64617461 /* 'data' */) {
      dataOffset = body;
      dataLen = size;
    }

    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV file has no fmt chunk");
  if (dataOffset < 0) throw new Error("WAV file has no data chunk");
  dataLen = Math.min(dataLen, dv.byteLength - dataOffset);

  const { numChannels, sampleRate, bitsPerSample, format } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * numChannels));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  let readSample;
  if (format === 3 && bitsPerSample === 32) {
    readSample = (off) => dv.getFloat32(off, true);
  } else if (format === 1 && bitsPerSample === 16) {
    readSample = (off) => dv.getInt16(off, true) / 32768;
  } else if (format === 1 && bitsPerSample === 24) {
    readSample = (off) => {
      const b0 = dv.getUint8(off);
      const b1 = dv.getUint8(off + 1);
      const b2 = dv.getUint8(off + 2);
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v -= 0x1000000;
      return v / 8388608;
    };
  } else if (format === 1 && bitsPerSample === 32) {
    readSample = (off) => dv.getInt32(off, true) / 2147483648;
  } else if (format === 1 && bitsPerSample === 8) {
    readSample = (off) => (dv.getUint8(off) - 128) / 128;
  } else {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit)`);
  }

  for (let f = 0; f < frameCount; f++) {
    const frameOff = dataOffset + f * bytesPerSample * numChannels;
    for (let c = 0; c < numChannels; c++) {
      channels[c][f] = readSample(frameOff + c * bytesPerSample);
    }
  }

  return makeBufferLike(sampleRate, channels);
}

/**
 * Encode Float32 channel data as a PCM WAV Blob.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {16|24} bitDepth
 */
export function encodeWav(channels, sampleRate, bitDepth = 24) {
  const numChannels = channels.length;
  const frameCount = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frameCount * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  dv.setUint16(32, numChannels * bytesPerSample, true); // block align
  dv.setUint16(34, bitDepth, true);
  writeStr(36, "data");
  dv.setUint32(40, dataSize, true);

  let off = 44;
  const clamp = (x) => Math.max(-1, Math.min(1, x));

  if (bitDepth === 16) {
    for (let f = 0; f < frameCount; f++) {
      for (let c = 0; c < numChannels; c++) {
        dv.setInt16(off, Math.round(clamp(channels[c][f]) * 32767), true);
        off += 2;
      }
    }
  } else if (bitDepth === 24) {
    for (let f = 0; f < frameCount; f++) {
      for (let c = 0; c < numChannels; c++) {
        let v = Math.round(clamp(channels[c][f]) * 8388607);
        if (v < 0) v += 0x1000000;
        dv.setUint8(off, v & 0xff);
        dv.setUint8(off + 1, (v >> 8) & 0xff);
        dv.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
  } else {
    throw new Error(`Unsupported export bit depth: ${bitDepth}`);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// AIFF / AIFF-C
// ---------------------------------------------------------------------------

/** Decode the 80-bit IEEE-754 extended-precision float AIFF uses for its sample rate. */
function readExtendedFloat80(dv, offset) {
  const sign = dv.getUint8(offset) & 0x80 ? -1 : 1;
  const exponent = ((dv.getUint8(offset) & 0x7f) << 8) | dv.getUint8(offset + 1);
  const hi = dv.getUint32(offset + 2, false);
  const lo = dv.getUint32(offset + 6, false);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * Math.pow(2, 32) + lo;
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
}

export function parseAiff(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, false) !== 0x464f524d /* 'FORM' */) {
    throw new Error("Not a FORM/AIFF file");
  }
  const formType = dv.getUint32(8, false);
  if (formType !== 0x41494646 /* 'AIFF' */ && formType !== 0x41494643 /* 'AIFC' */) {
    throw new Error("FORM file is not AIFF/AIFC");
  }

  let pos = 12;
  let comm = null;
  let ssndOffset = -1;
  let ssndDataStart = -1;
  let ssndDataLen = 0;

  while (pos + 8 <= dv.byteLength) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, false);
    const body = pos + 8;

    if (id === 0x434f4d4d /* 'COMM' */) {
      const numChannels = dv.getUint16(body, false);
      const numSampleFrames = dv.getUint32(body + 2, false);
      const bitsPerSample = dv.getUint16(body + 6, false);
      const sampleRate = Math.round(readExtendedFloat80(dv, body + 8));
      let compressionType = "NONE";
      if (formType === 0x41494643 && size >= 22) {
        const c = dv.getUint32(body + 18, false);
        compressionType = String.fromCharCode(
          (c >>> 24) & 0xff,
          (c >>> 16) & 0xff,
          (c >>> 8) & 0xff,
          c & 0xff
        );
      }
      comm = { numChannels, numSampleFrames, bitsPerSample, sampleRate, compressionType };
    } else if (id === 0x53534e44 /* 'SSND' */) {
      const dataOffset = dv.getUint32(body, false);
      ssndOffset = body;
      ssndDataStart = body + 8 + dataOffset;
      ssndDataLen = size - 8 - dataOffset;
    }

    pos = body + size + (size % 2);
  }

  if (!comm) throw new Error("AIFF file has no COMM chunk");
  if (ssndDataStart < 0) throw new Error("AIFF file has no SSND chunk");

  const { numChannels, bitsPerSample, sampleRate, compressionType } = comm;
  const littleEndian = compressionType === "sowt";
  if (compressionType !== "NONE" && compressionType !== "sowt" && compressionType !== "\0\0\0\0") {
    throw new Error(`Compressed AIFF-C (${compressionType}) is not supported`);
  }

  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  ssndDataLen = Math.min(ssndDataLen, dv.byteLength - ssndDataStart);
  const frameCount = Math.floor(ssndDataLen / (bytesPerSample * numChannels));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  let readSample;
  if (bitsPerSample === 16) {
    readSample = (off) => dv.getInt16(off, littleEndian) / 32768;
  } else if (bitsPerSample === 24) {
    readSample = (off) => {
      let b0, b1, b2;
      if (littleEndian) {
        b0 = dv.getUint8(off);
        b1 = dv.getUint8(off + 1);
        b2 = dv.getUint8(off + 2);
      } else {
        b2 = dv.getUint8(off);
        b1 = dv.getUint8(off + 1);
        b0 = dv.getUint8(off + 2);
      }
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v -= 0x1000000;
      return v / 8388608;
    };
  } else if (bitsPerSample === 32) {
    readSample = (off) => dv.getInt32(off, littleEndian) / 2147483648;
  } else if (bitsPerSample === 8) {
    readSample = (off) => dv.getInt8(off) / 128;
  } else {
    throw new Error(`Unsupported AIFF bit depth: ${bitsPerSample}`);
  }

  for (let f = 0; f < frameCount; f++) {
    const frameOff = ssndDataStart + f * bytesPerSample * numChannels;
    for (let c = 0; c < numChannels; c++) {
      channels[c][f] = readSample(frameOff + c * bytesPerSample);
    }
  }

  return makeBufferLike(sampleRate, channels);
}
