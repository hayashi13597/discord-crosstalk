import { Readable } from 'node:stream';
import { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, type AudioPlayer } from '@discordjs/voice';
import { createCodec, type Codec } from './codec.js';
import type { Output } from './router.js';

export class LatestPacketStream extends Readable {
  private ended = false;
  constructor(private maxPackets = 3) { super({ objectMode: true, highWaterMark: maxPackets }); }
  override _read(): void {}
  offer(packet: Buffer): void {
    if (this.destroyed || this.ended) return;
    while (this.readableLength >= this.maxPackets) this.read();
    this.push(packet);
  }
  finish(): void {
    if (this.destroyed || this.ended) return;
    this.ended = true;
    this.push(null);
  }
  get finishedOffering(): boolean { return this.ended || this.destroyed; }
}

const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE_FRAMES = 5;

export class VoiceOutput implements Output {
  readonly player: AudioPlayer;
  private ready = false;
  private stream?: LatestPacketStream;
  private codec?: Codec;
  private silenceRemaining = 0;
  constructor(private onError: (error: unknown) => void) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 10 } });
    this.player.on('error', error => this.onError(error));
  }
  setReady(ready: boolean): void { this.ready = ready; this.reset(); }
  reset(): void {
    this.silenceRemaining = 0;
    this.player.stop(true);
    this.stream?.destroy();
    this.stream = undefined;
    this.codec?.close();
    this.codec = undefined;
  }
  write(pcm: Buffer | undefined): void {
    if (!this.ready) return;
    try {
      if (!pcm) {
        if (this.silenceRemaining <= 0) return;
        this.silenceRemaining--;
        this.stream?.offer(OPUS_SILENCE);
        if (this.silenceRemaining === 0) {
          this.stream?.finish();
          this.stream = undefined;
        }
        return;
      }
      if (!this.stream || this.stream.finishedOffering) {
        this.stream = new LatestPacketStream();
        this.player.play(createAudioResource(this.stream, { inputType: StreamType.Opus, silencePaddingFrames: 0 }));
      }
      this.codec ??= createCodec();
      this.silenceRemaining = SILENCE_FRAMES;
      this.stream.offer(this.codec.encode(pcm));
    } catch (error) { this.onError(error); }
  }
  close(): void { this.ready = false; this.reset(); }
}
