// End-to-end without touching your desktop: Chromium's fake mic plays a WAV into the pill,
// we start/stop dictation through a test hook, and check the transcript. Paste is skipped in test mode.
// Run: npm run test:e2e [path.wav]
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const wav = resolve(process.argv[2] ?? join(root, 'test', 'fixtures', 'speech0.wav'))
// Chromium plays silence for a missing file instead of failing, so check up front.
if (!existsSync(wav)) throw new Error(`Missing audio fixture: ${wav}`)
const dataDir = join(root, 'out', 'e2e-profile')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const app = await electron.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    join(root, 'out', 'main.js')
  ],
  env: { ...process.env, DICTATE_E2E: '1', DICTATE_DATA_DIR: dataDir }
})
app.process().stdout.on('data', (d) => process.stdout.write(`  [app] ${d}`))
app.process().stderr.on('data', (d) => process.stderr.write(`  [app] ${d}`))

const call = (name) => app.evaluate((_e, n) => globalThis.__dictate[n](), name)
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

let failed = false
try {
  await until(() => app.evaluate(() => !!globalThis.__dictate), 15_000)
  await call('warmUp')

  // 1. A normal dictation comes back as text.
  await call('start')
  await new Promise((r) => setTimeout(r, 7000)) // let the WAV play into the fake mic
  const t0 = Date.now()
  await call('stop')
  const text = await call('last')
  console.log(`transcript (${Date.now() - t0} ms after stop): ${JSON.stringify(text)}`)
  if (!text) throw new Error('empty transcript')
  if ((await call('state')) !== 'idle') throw new Error('not idle after stop')

  // 2. Cancel returns to idle without producing text.
  await call('start')
  await new Promise((r) => setTimeout(r, 1000))
  await call('cancel')
  if ((await call('state')) !== 'idle') throw new Error('not idle after cancel')
  if ((await call('last')) !== text) throw new Error('cancel changed the transcript')

  // 3. An instant tap (stop right after start) must not leave the mic open or hang.
  await call('start')
  await call('stop')
  if ((await call('state')) !== 'idle') throw new Error('not idle after instant stop')

  console.log('e2e passed')
} catch (err) {
  failed = true
  console.error('e2e FAILED:', err)
} finally {
  await app.close()
}
process.exit(failed ? 1 : 0)
