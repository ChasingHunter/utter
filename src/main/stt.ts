import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus } from 'node:os'
import type { OfflineRecognizer } from 'sherpa-onnx-node'
import { settings } from './settings'

// Offline speech-to-text: NVIDIA Parakeet TDT 0.6B v2 (int8) via sherpa-onnx.
// English, punctuation + casing built in, faster than real time on a laptop CPU.

export const MODEL = {
  name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
  sizeMb: 482
}

const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
// Written only after a complete extraction, so a half-unpacked model never counts as installed.
const MARKER = '.installed'

const ownModelsDir = (): string => join(app.getPath('userData'), 'models')

/** Where to look, in order: the configured folder, our own download, then Orbit's (same model, no second download). */
function candidates(): string[] {
  const list = [join(ownModelsDir(), MODEL.name)]
  // UTTER_FRESH pretends Orbit isn't installed, to test a clean machine.
  if (!process.env.UTTER_FRESH) list.push(join(app.getPath('appData'), 'Orbit', 'models', MODEL.name))
  return settings.modelDir ? [settings.modelDir, ...list] : list
}

const complete = (dir: string): boolean => MODEL_FILES.every((n) => existsSync(join(dir, n)))

export function findModel(): string | undefined {
  return candidates().find((dir) => complete(dir) && (existsSync(join(dir, MARKER)) || dir === settings.modelDir))
}

let installing: Promise<void> | undefined

/** Downloads and unpacks the model into Utter's data folder. `onProgress` gets 0..1 while downloading. */
export function installModel(onProgress: (fraction: number, phase: 'download' | 'unpack') => void): Promise<void> {
  installing ??= (async () => {
    const dir = ownModelsDir()
    mkdirSync(dir, { recursive: true })
    const archive = join(dir, `${MODEL.name}.tar.bz2`)
    const res = await fetch(MODEL.url)
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
    const total = Number(res.headers.get('content-length')) || MODEL.sizeMb * 1e6
    let received = 0
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      onProgress(Math.min(1, received / total), 'download')
    })
    await pipeline(body, createWriteStream(archive))
    onProgress(1, 'unpack')
    // Windows 10+ ships bsdtar, which handles .tar.bz2. Call it by full path: a plain "tar" can resolve to
    // Git's GNU tar (when Git's tools are on PATH), which reads "C:\..." as a remote host and fails.
    await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xjf', archive, '-C', dir])
    rmSync(archive, { force: true })
    const modelDir = join(dir, MODEL.name)
    if (!complete(modelDir)) throw new Error('Model files missing after extraction')
    writeFileSync(join(modelDir, MARKER), new Date().toISOString())
  })().finally(() => {
    installing = undefined
  })
  return installing
}

let recognizer: Promise<OfflineRecognizer> | undefined

function getRecognizer(): Promise<OfflineRecognizer> {
  recognizer ??= (async () => {
    const dir = findModel()
    if (!dir) throw new Error('Speech model not installed')
    const f = (n: string): string => join(dir, n)
    const t0 = Date.now()
    // Loaded lazily: if the native addon is broken, the tray still comes up and says so.
    const mod = await import('sherpa-onnx-node')
    // CommonJS package: under dynamic import() its exports may sit on `default`.
    const { OfflineRecognizer } = mod.default ?? mod
    const rec = await OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') },
        tokens: f('tokens.txt'),
        modelType: 'nemo_transducer',
        numThreads: Math.max(1, Math.min(4, cpus().length - 1)),
        provider: 'cpu',
        debug: 0
      }
    })
    console.log(`[stt] model loaded from ${dir} in ${Date.now() - t0} ms`)
    return rec
  })().catch((err) => {
    recognizer = undefined
    throw err
  })
  return recognizer
}

/** Loads the model ahead of time so the first dictation isn't slow. */
export function warmUp(): Promise<void> {
  return getRecognizer().then(() => {})
}

/** Transcribes 16 kHz mono float samples. */
export async function transcribe(samples: Float32Array): Promise<string> {
  if (samples.length < 16000 * 0.3) return '' // under 300 ms: nothing said
  const rec = await getRecognizer()
  const stream = rec.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  await rec.decodeAsync(stream)
  return rec.getResult(stream).text.trim()
}
