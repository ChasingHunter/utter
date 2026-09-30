// Offline STT check without the app: transcribe WAVs with the Parakeet model, print speed + text.
// Run: node scripts/stt-bench.mjs test/fixtures/*.wav
// Model folder: $DICTATE_MODEL_DIR, else Dictate's, else Orbit's.
import sherpa from 'sherpa-onnx-node'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'

const NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const dir = [process.env.DICTATE_MODEL_DIR, join(process.env.APPDATA, 'Dictate', 'models', NAME), join(process.env.APPDATA, 'Orbit', 'models', NAME)]
  .filter(Boolean)
  .find((d) => existsSync(join(d, 'tokens.txt')))
if (!dir) {
  console.error('No speech model found. Start the app once to download it, or set DICTATE_MODEL_DIR.')
  process.exit(1)
}
const files = process.argv.slice(2)
if (!files.length) {
  console.error('Usage: node scripts/stt-bench.mjs <file.wav> [...]')
  process.exit(1)
}

const f = (n) => join(dir, n)
const threads = Math.max(1, Math.min(4, cpus().length - 1))

let t = performance.now()
const rec = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') },
    tokens: f('tokens.txt'),
    modelType: 'nemo_transducer',
    numThreads: threads,
    provider: 'cpu',
    debug: 0
  }
})
console.log(`model: ${dir}\nload: ${(performance.now() - t).toFixed(0)} ms (${threads} threads)`)

for (const path of files) {
  const wave = sherpa.readWave(path)
  const secs = wave.samples.length / wave.sampleRate
  t = performance.now()
  const stream = rec.createStream()
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
  await rec.decodeAsync(stream)
  const ms = performance.now() - t
  console.log(`\n${path}  audio ${secs.toFixed(1)}s  decode ${ms.toFixed(0)} ms  RTF ${(ms / 1000 / secs).toFixed(3)}`)
  console.log(`  ${rec.getResult(stream).text}`)
}
