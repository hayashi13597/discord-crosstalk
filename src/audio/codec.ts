import { createRequire } from 'node:module';
import { FRAME_SAMPLES } from './router.js';

const require = createRequire(import.meta.url);
export interface Codec { encode(pcm: Buffer): Buffer; decode(opus: Buffer): Buffer; close(): void }

// Native Opus is preferred; WASM fallback keeps deploys working when native build/download is unavailable.
export function createCodec(): Codec {
  try {
    const { OpusEncoder } = require('@discordjs/opus') as {
      OpusEncoder: new (rate: number, channels: number) => { encode(pcm: Buffer): Buffer; decode(opus: Buffer): Buffer };
    };
    const codec = new OpusEncoder(48000, 2);
    return { encode: pcm => codec.encode(pcm), decode: packet => codec.decode(packet), close() {} };
  } catch (error) {
    // Do not hide codec initialization errors when the native module was actually loaded.
    if (!(error instanceof Error) || !('code' in error) || !['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(String(error.code))) throw error;
  }
  const OpusScript = require('opusscript') as new (rate: number, channels: number, application: number) => {
    encode(pcm: Buffer, samples: number): Buffer;
    decode(opus: Buffer): Buffer;
    delete(): void;
  };
  const codec = new OpusScript(48000, 2, 2048 /* VOIP */);
  return { encode: pcm => codec.encode(pcm, FRAME_SAMPLES), decode: packet => codec.decode(packet), close: () => codec.delete() };
}
