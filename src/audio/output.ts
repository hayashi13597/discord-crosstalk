import { Readable } from 'node:stream';
import { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, type AudioPlayer } from '@discordjs/voice';
import { createCodec, type Codec } from './codec.js';
import type { Output } from './router.js';

export class LatestPacketStream extends Readable {
  constructor() { super({ objectMode: true, highWaterMark: 1 }); }
  override _read(): void {}
  offer(packet: Buffer): void {
    if (this.destroyed) return;
    while (this.readableLength) this.read();
    this.push(packet);
  }
}

const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
export class VoiceOutput implements Output {
  readonly player: AudioPlayer;
  private ready = false;
  private stream?: LatestPacketStream;
  private codec?: Codec;
  constructor(private onError: (error: unknown) => void) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 10 } });
    this.player.on('error', error => this.onError(error));
  }
  setReady(ready: boolean): void { this.ready = ready; this.reset(); }
  reset(): void {
    this.player.stop(true);
    this.stream?.destroy();
    this.stream = undefined;
    this.codec?.close();
    this.codec = undefined;
  }
  write(pcm: Buffer | undefined): void {
    if (!this.ready) return;
    try {
      if (!this.stream || this.stream.destroyed) {
        this.stream = new LatestPacketStream();
        this.player.play(createAudioResource(this.stream, { inputType: StreamType.Opus, silencePaddingFrames: 0 }));
      }
      if (pcm) this.codec ??= createCodec();
      this.stream.offer(pcm ? this.codec!.encode(pcm) : OPUS_SILENCE);
    } catch (error) { this.onError(error); }
  }
  close(): void { this.ready = false; this.reset(); }
}
