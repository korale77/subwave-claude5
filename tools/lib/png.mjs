/**
 * Zero-dependency PNG decoder for the offline measurement tools.
 *
 * WHY THIS EXISTS AT ALL: every frame statistic this project judges visual work
 * by has to be measured on the DISPLAY-REFERRED image - the PNG that comes back
 * from Chrome's CDP `Page.captureScreenshot`, or the ones `qa.mjs` writes. It
 * cannot be measured on `renderer.debugReadback('resolved')`, because TAA runs
 * before tonemapping, so `resolved` is pre-AgX and AgX is the operator that
 * decides delivered saturation. So the instrument has to read PNG bytes, and
 * CLAUDE.md forbids an npm dependency to do it. `node:zlib` is a platform API,
 * the same way `Worker` is, so `inflateSync` plus the five PNG filters is the
 * whole decoder.
 *
 * WHAT IT ACTUALLY HAS TO HANDLE: every PNG in `qa-output/` and
 * `shot-output-before/` measures bitDepth 8, colourType 2 (RGB), interlace 0
 * (checked over all 26 files on 2026-08-04). Chrome emits colourType 6 (RGBA)
 * when the captured surface has an alpha channel, so both are first-class. The
 * remaining non-interlaced forms - greyscale, greyscale+alpha, palette, and
 * 16-bit - are implemented too because they are a few lines each and a decoder
 * that silently mis-reads a file is worse than one that refuses.
 *
 * DELIBERATE LIMITS, stated rather than stubbed:
 *   - Adam7 interlacing throws. No file we produce uses it and untested
 *     de-interlacing code would be exactly the placeholder CLAUDE.md forbids.
 *   - `tRNS` is honoured for palette images and ignored for the greyscale/RGB
 *     colour-key forms. Alpha is not used by any metric here, so this changes
 *     no measurement; it is recorded so nobody assumes coverage that is absent.
 *   - CRCs are not verified. `inflateSync` already fails loudly on a damaged
 *     IDAT stream, which is the only chunk whose corruption could produce a
 *     plausible-but-wrong image.
 */

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** The eight-byte PNG signature, per the spec's section 5.2. */
const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Samples per pixel for each PNG colour type; -1 marks the undefined codes. */
const SAMPLES_PER_PIXEL = [1, -1, 3, 1, 2, -1, 4];

/**
 * Reverse the five PNG scanline filters into a tightly packed pixel buffer.
 *
 * The filters are defined on BYTES at a fixed stride, not on samples, which is
 * why `bpp` is `ceil(bitsPerPixel / 8)` and is 1 for every sub-byte depth: at
 * depth < 8 the "pixel to the left" is the byte to the left. Filtering is
 * always done in 8-bit modular arithmetic regardless of the sample depth.
 *
 * @param {Uint8Array} raw inflated IDAT stream, one filter byte per scanline
 * @param {number} height scanline count
 * @param {number} bpp filter stride in bytes
 * @param {number} rowBytes bytes per unfiltered scanline
 * @returns {Uint8Array} height * rowBytes of unfiltered data
 */
function unfilter(raw, height, bpp, rowBytes) {
  const expected = height * (rowBytes + 1);
  if (raw.length < expected) {
    throw new Error(`png: inflated stream is ${raw.length} bytes, expected ${expected}`);
  }
  const out = new Uint8Array(height * rowBytes);
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    const o = y * rowBytes;
    const p = o - rowBytes;
    if (filter === 0) {
      out.set(raw.subarray(ri, ri + rowBytes), o);
    } else if (filter === 1) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? out[o + x - bpp] : 0;
        out[o + x] = (raw[ri + x] + a) & 255;
      }
    } else if (filter === 2) {
      for (let x = 0; x < rowBytes; x++) {
        const b = y > 0 ? out[p + x] : 0;
        out[o + x] = (raw[ri + x] + b) & 255;
      }
    } else if (filter === 3) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? out[o + x - bpp] : 0;
        const b = y > 0 ? out[p + x] : 0;
        out[o + x] = (raw[ri + x] + ((a + b) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? out[o + x - bpp] : 0;
        const b = y > 0 ? out[p + x] : 0;
        const c = y > 0 && x >= bpp ? out[p + x - bpp] : 0;
        // Paeth: pick whichever of left/up/up-left the linear estimate a+b-c
        // is nearest to. Ties resolve a, then b, per the spec's pseudocode.
        const q = a + b - c;
        const pa = q > a ? q - a : a - q;
        const pb = q > b ? q - b : b - q;
        const pc = q > c ? q - c : c - q;
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[o + x] = (raw[ri + x] + pred) & 255;
      }
    } else {
      throw new Error(`png: unknown scanline filter ${filter} on row ${y}`);
    }
    ri += rowBytes;
  }
  return out;
}

/**
 * Expand unfiltered scanlines to interleaved 8-bit samples.
 *
 * 16-bit samples are reduced by taking the high byte rather than rounding: the
 * metrics downstream quantise to 32 hue bins, so a half-LSB bias is orders of
 * magnitude below anything they can resolve, and the high byte is exact for
 * every value an 8-bit source was widened from.
 *
 * @param {Uint8Array} rows unfiltered scanlines
 * @param {number} width pixels per row
 * @param {number} height row count
 * @param {number} rowBytes bytes per unfiltered scanline
 * @param {number} depth bits per sample
 * @param {number} colourType PNG colour type code
 * @param {Uint8Array|null} palette PLTE entries, 3 bytes each
 * @param {Uint8Array|null} trns tRNS alpha for palette entries
 * @returns {{data: Uint8Array, channels: number}}
 */
function expand(rows, width, height, rowBytes, depth, colourType, palette, trns) {
  if (colourType === 3) {
    if (palette === null) throw new Error('png: indexed image has no PLTE chunk');
    const channels = trns === null ? 3 : 4;
    const data = new Uint8Array(width * height * channels);
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes;
      let d = y * width * channels;
      for (let x = 0; x < width; x++) {
        let idx;
        if (depth === 8) {
          idx = rows[src + x];
        } else {
          const shift = 8 - depth * ((x % perByte) + 1);
          idx = (rows[src + ((x / perByte) | 0)] >> shift) & mask;
        }
        const p = idx * 3;
        if (p + 2 >= palette.length) throw new Error(`png: palette index ${idx} out of range`);
        data[d++] = palette[p];
        data[d++] = palette[p + 1];
        data[d++] = palette[p + 2];
        if (channels === 4) data[d++] = idx < trns.length ? trns[idx] : 255;
      }
    }
    return { data, channels };
  }

  const channels = SAMPLES_PER_PIXEL[colourType];
  if (depth === 8) {
    // Already tightly packed and already 8-bit: the unfiltered buffer IS the
    // pixel buffer. This is the path every qa-output frame takes.
    return { data: rows, channels };
  }
  const data = new Uint8Array(width * height * channels);
  if (depth === 16) {
    for (let i = 0, n = data.length; i < n; i++) data[i] = rows[i * 2];
    return { data, channels };
  }
  // Sub-byte depths only occur for greyscale here (colour types 2/4/6 forbid
  // them). Scale the sample to full range so a depth-1 white reads 255, not 1.
  const maxVal = (1 << depth) - 1;
  const scale = 255 / maxVal;
  const perByte = 8 / depth;
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    let d = y * width;
    for (let x = 0; x < width; x++) {
      const shift = 8 - depth * ((x % perByte) + 1);
      const v = (rows[src + ((x / perByte) | 0)] >> shift) & maxVal;
      data[d++] = Math.round(v * scale);
    }
  }
  return { data, channels };
}

/**
 * Decode a PNG from raw bytes.
 *
 * Returns 8-bit interleaved samples in source channel order, NOT forced to
 * RGBA: the caller is told the channel count and reads what is there. Forcing
 * RGBA would allocate a third more memory per 1.2 Mpixel frame for an alpha
 * channel no metric in this project reads.
 *
 * @param {Uint8Array|Buffer} bytes complete PNG file contents
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function decodePNG(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) throw new Error('png: file is too short to hold a signature');
  for (let i = 0; i < 8; i++) {
    if (b[i] !== SIGNATURE[i]) throw new Error('png: bad signature, not a PNG file');
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let seenIHDR = false;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatBytes = 0;

  let off = 8;
  while (off + 8 <= b.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    const dataStart = off + 8;
    if (dataStart + len + 4 > b.length) throw new Error(`png: chunk ${type} runs past end of file`);
    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      depth = b[dataStart + 8];
      colourType = b[dataStart + 9];
      const compression = b[dataStart + 10];
      const filterMethod = b[dataStart + 11];
      const interlace = b[dataStart + 12];
      if (width <= 0 || height <= 0) throw new Error('png: IHDR declares a zero dimension');
      if (compression !== 0) throw new Error(`png: unsupported compression method ${compression}`);
      if (filterMethod !== 0) throw new Error(`png: unsupported filter method ${filterMethod}`);
      if (interlace !== 0) throw new Error('png: Adam7 interlacing is not supported by this decoder');
      if (SAMPLES_PER_PIXEL[colourType] === undefined || SAMPLES_PER_PIXEL[colourType] === -1) {
        throw new Error(`png: unknown colour type ${colourType}`);
      }
      const legal = colourType === 0 ? [1, 2, 4, 8, 16]
        : colourType === 3 ? [1, 2, 4, 8]
          : [8, 16];
      if (!legal.includes(depth)) {
        throw new Error(`png: bit depth ${depth} is illegal for colour type ${colourType}`);
      }
      seenIHDR = true;
    } else if (type === 'PLTE') {
      palette = b.subarray(dataStart, dataStart + len);
    } else if (type === 'tRNS') {
      if (colourType === 3) trns = b.subarray(dataStart, dataStart + len);
    } else if (type === 'IDAT') {
      idat.push(b.subarray(dataStart, dataStart + len));
      idatBytes += len;
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!seenIHDR) throw new Error('png: no IHDR chunk');
  if (idat.length === 0) throw new Error('png: no IDAT data');

  // The IDAT chunks form ONE zlib stream split at arbitrary byte boundaries -
  // Chrome splits at 4096 - so they must be concatenated before inflating.
  let stream;
  if (idat.length === 1) {
    stream = idat[0];
  } else {
    stream = new Uint8Array(idatBytes);
    let at = 0;
    for (let i = 0; i < idat.length; i++) {
      stream.set(idat[i], at);
      at += idat[i].length;
    }
  }
  const raw = new Uint8Array(inflateSync(stream));

  const samples = SAMPLES_PER_PIXEL[colourType];
  const bitsPerPixel = samples * depth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8);
  const rows = unfilter(raw, height, bpp, rowBytes);
  const { data, channels } = expand(rows, width, height, rowBytes, depth, colourType, palette, trns);
  return { width, height, channels, data };
}

/**
 * Read and decode a PNG file from disk.
 *
 * Synchronous on purpose: every consumer is an offline measurement tool that
 * walks a directory and prints a table, and async here would buy nothing but a
 * more awkward driver.
 *
 * @param {string} path absolute path to a .png file
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function decodePNGFile(path) {
  return decodePNG(readFileSync(path));
}
