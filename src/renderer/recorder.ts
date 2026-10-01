// Captures microphone audio as 16 kHz mono Float32 for the local speech model and hands it over
// in small chunks while recording, so the main process can transcribe as you talk.
// Chromium resamples to the AudioContext's rate, so no manual resampling needed.

const SAMPLE_RATE = 16000
/** 64 ms per chunk: small enough that little audio sits waiting when you stop. */
const CHUNK = 1024

export class Recorder {
  private ctx: AudioContext | undefined
  private stream: MediaStream | undefined
  private node: ScriptProcessorNode | undefined
  private starting: Promise<void> | undefined
  private analyser: AnalyserNode | undefined
  private frame = new Float32Array(512)

  constructor(private onChunk: (samples: Float32Array) => void) {}

  /**
   * Opens and closes the mic once. The first open in a process spins up Chromium's audio
   * service (~2 s here), which would otherwise swallow the first words of the first dictation.
   */
  async warm(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    await new AudioContext({ sampleRate: SAMPLE_RATE }).close()
  }

  start(): Promise<void> {
    this.starting ??= this.open().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async open(): Promise<void> {
    if (this.ctx) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const source = this.ctx.createMediaStreamSource(this.stream)
    // Separate tap for the waveform, read every animation frame so it moves smoothly.
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    source.connect(this.analyser)
    // ScriptProcessor is deprecated but needs no extra module file (CSP-friendly) and is plenty for mono 16 kHz.
    this.node = this.ctx.createScriptProcessor(CHUNK, 1, 1)
    this.node.onaudioprocess = (e) => this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)))
    source.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  /** Loudness right now, 0..1 (RMS, eased so normal speech fills most of the range). */
  level(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.frame)
    let sum = 0
    for (const v of this.frame) sum += v * v
    return Math.min(1, Math.sqrt(Math.sqrt(sum / this.frame.length) * 7))
  }

  /** Stops recording. Waits for a start still in progress so the mic never stays open. */
  async stop(): Promise<void> {
    await this.starting?.catch(() => {})
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close().catch(() => {})
    this.ctx = undefined
    this.node = undefined
    this.stream = undefined
    this.analyser = undefined
  }
}
