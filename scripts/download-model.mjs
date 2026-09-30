// Downloads the speech model without starting the app (the app also offers this on first launch).
// Handy for `npm run bench` and the tests on a fresh machine.
// Run: npm run model [-- <folder>]   default folder: %APPDATA%\Utter\models
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Keep in sync with MODEL in src/main/stt.ts.
const NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

const root = process.argv[2] ?? join(process.env.APPDATA, 'Utter', 'models')
const dir = join(root, NAME)
if (existsSync(join(dir, '.installed'))) {
  console.log(`Already installed: ${dir}`)
  process.exit(0)
}

mkdirSync(root, { recursive: true })
const archive = join(root, `${NAME}.tar.bz2`)
console.log(`Downloading ${URL}`)
const res = await fetch(URL)
if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
const total = Number(res.headers.get('content-length')) || 482e6
let got = 0
let shown = -1
const body = Readable.fromWeb(res.body)
body.on('data', (c) => {
  got += c.length
  const pct = Math.floor((got / total) * 100)
  if (pct !== shown && pct % 5 === 0) process.stdout.write(`\r  ${pct}%`)
  shown = pct
})
await pipeline(body, createWriteStream(archive))
console.log('\nUnpacking…')
// Windows 10+ ships bsdtar, which handles .tar.bz2. Full path, because a plain "tar" can be Git's GNU tar,
// which reads "C:\..." as a remote host and fails.
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xjf', archive, '-C', root])
rmSync(archive, { force: true })
if (!FILES.every((f) => existsSync(join(dir, f)))) throw new Error('Model files missing after extraction')
writeFileSync(join(dir, '.installed'), new Date().toISOString())
console.log(`Installed: ${dir}`)
