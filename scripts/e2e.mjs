// End-to-end without touching your desktop: Chromium's fake mic plays a WAV into the pill,
// we drive dictation through a test hook, and check the transcript. Never pastes and never
// touches the clipboard. Screenshots of the pill land in out/e2e/.
// Run: npm run test:e2e [path.wav]
//      npm run test:e2e -- --long   a ~22 s dictation with pauses, to check the wait after letting go stays short
// UTTER_FRESH=1 ignores Orbit's copy of the model and downloads it the way a new install would (482 MB).
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dataDir = join(root, 'out', 'e2e-profile')
const shots = join(root, 'out', 'e2e')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shots, { recursive: true })

/** The PCM samples of a 16-bit mono WAV. */
function pcm(file) {
  const b = readFileSync(file)
  for (let at = 12; at < b.length - 8; at += 8 + b.readUInt32LE(at + 4)) {
    if (b.toString('ascii', at, at + 4) === 'data') return b.subarray(at + 8, at + 8 + b.readUInt32LE(at + 4))
  }
  throw new Error(`no data chunk in ${file}`)
}

/** Both fixtures twice, with short pauses between them, like someone talking in phrases. */
function longWav() {
  const a = pcm(join(root, 'test', 'fixtures', 'speech0.wav'))
  const b = pcm(join(root, 'test', 'fixtures', 'speech1.wav'))
  const pause = Buffer.alloc(16000 * 2 * 0.7) // 0.7 s of silence
  const data = Buffer.concat([a, pause, b, pause, a, pause, b, Buffer.alloc(16000 * 2 * 3)]) // trailing quiet: the fake mic loops
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  const file = join(root, 'out', 'long.wav')
  writeFileSync(file, Buffer.concat([header, data]))
  return file
}

const long = process.argv.includes('--long')
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const wav = long ? longWav() : resolve(arg ?? join(root, 'test', 'fixtures', 'speech0.wav'))
// Chromium plays silence for a missing file instead of failing, so check up front.
if (!existsSync(wav)) throw new Error(`Missing audio fixture: ${wav}`)
const speechSeconds = pcm(wav).length / 32000

// UTTER_EXE=dist/win-unpacked/Utter.exe tests the packaged app instead of the dev build.
const exe = process.env.UTTER_EXE ? resolve(process.env.UTTER_EXE) : undefined
const app = await electron.launch({
  executablePath: exe,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    ...(exe ? [] : [join(root, 'out', 'main.js')])
  ],
  // A deliberately bad key: polishing must fail quietly and fall back to the raw transcript.
  env: { ...process.env, UTTER_E2E: '1', UTTER_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'sk-ant-e2e-invalid' },
  timeout: 60_000
})
const logs = []
app.process().stdout.on('data', (d) => {
  logs.push(String(d))
  process.stdout.write(`  [app] ${d}`)
})
app.process().stderr.on('data', (d) => {
  logs.push(String(d))
  process.stderr.write(`  [app] ${d}`)
})

const call = (name, arg) => app.evaluate((_e, [n, a]) => globalThis.__utter[n](a), [name, arg])
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await wait(100)
  }
  throw new Error('timed out')
}

let failed = false
try {
  await until(() => app.evaluate(() => !!globalThis.__utter), 15_000)
  const pill = await app.firstWindow()
  // The pill's own errors never reach the app log, so surface them here.
  pill.on('pageerror', (e) => console.error(`  [pill] ${e.message}`))
  pill.on('console', (m) => m.type() === 'error' && console.error(`  [pill] ${m.text()}`))
  if (!(await call('hasModel'))) {
    console.log('no speech model yet: downloading it like a fresh install would…')
    const t = Date.now()
    await call('downloadModel')
    console.log(`model installed in ${((Date.now() - t) / 1000).toFixed(0)} s`)
  }
  await call('warmUp')
  // Scenarios 1-4 use the API engine with a bad key, so polishing must fail and fall back.
  if ((await call('setPolish', 'api')) !== 'api') throw new Error('api polish engine not selected')

  // 1. Hold-to-talk into a normal app: text comes back (polish fails on the bad key and falls back).
  await call('setTarget', { app: 'notepad.exe', title: 'Untitled - Notepad', className: 'Notepad' })
  await call('begin')
  await call('reveal')
  await wait(3000)
  await pill.screenshot({ path: join(shots, '1-listening.png') })
  // Let the whole clip play (the mic takes a moment to open), then let go.
  await wait(long ? (speechSeconds - 3) * 1000 - 2200 : 4000)
  const t0 = Date.now()
  const stopping = call('stop')
  await wait(150)
  await pill.screenshot({ path: join(shots, '2-thinking.png') })
  await stopping
  const text = await call('last')
  console.log(`transcript (${Date.now() - t0} ms after stop, including a failed polish call): ${JSON.stringify(text)}`)
  console.log(`  ${(logs.join('').match(/\d+\.\d s audio \(\d+ pieces done while talking\), stt after release \d+ ms/) ?? ['(no timing line)'])[0]}`)
  if (!/investor call/i.test(text)) throw new Error(`unexpected transcript: ${text}`)
  if (!logs.join('').includes('polish failed')) throw new Error('polish was not attempted with the (bad) key')
  if ((await call('state')) !== 'idle') throw new Error('not idle after stop')

  // 2. Nowhere to type (desktop): the copy card shows instead of pasting.
  await call('setTarget', { app: 'explorer.exe', title: '', className: 'Progman' })
  await call('begin')
  await call('reveal')
  await wait(4000)
  await call('stop')
  if (!(await call('cardOpen'))) throw new Error('copy card did not open for a desktop target')
  await wait(400)
  await pill.screenshot({ path: join(shots, '3-card.png') })

  // 3. Double-tap: tap, tap quickly, talk hands-free, tap to finish. Drives the same handlers the
  // keyboard hook calls. Used to race (mic restarted between the taps) and record nothing.
  await call('setTarget', { app: 'notepad.exe', title: 'Untitled - Notepad', className: 'Notepad' })
  const logsBefore = logs.length
  const textBefore = await call('last')
  const key = (fn, ...args) => app.evaluate((_e, [f, a]) => globalThis.__utter.key[f](...a), [fn, args])
  await key('press')
  await wait(90)
  await key('release', 90, true)
  await wait(150)
  await key('press')
  await wait(90)
  await key('release', 90, true)
  await wait(500) // past the double-tap window: a single tap would have been thrown away by now
  if (!(await call('handsFree')) || (await call('state')) !== 'recording') throw new Error('double-tap did not start hands-free')
  await wait(5000)
  await key('press')
  await key('release', 90, true)
  await until(async () => (await call('state')) === 'idle', 15_000)
  const handsFreeText = await call('last')
  console.log(`double-tap hands-free: ${JSON.stringify(handsFreeText)}`)
  const seconds = Number((logs.slice(logsBefore).join('').match(/(\d+\.\d) s audio/) ?? [0, 0])[1])
  if (seconds < 3 || !handsFreeText || handsFreeText === textBefore) throw new Error(`hands-free recorded ${seconds} s and no new text`)

  // 4. Cancel returns to idle without producing text, and closes the card.
  const before = await call('last')
  await call('begin')
  await wait(1000)
  await call('cancel')
  if ((await call('state')) !== 'idle') throw new Error('not idle after cancel')
  if ((await call('last')) !== before) throw new Error('cancel changed the transcript')

  // 4. An instant tap (stop right after start) must not leave the mic open or hang.
  await call('begin')
  await call('stop')
  if ((await call('state')) !== 'idle') throw new Error('not idle after instant stop')

  // 5. Polishing through your Claude plan (only if Claude Code is installed). Real Haiku calls.
  let engine = null
  for (let i = 0; i < 50 && engine !== 'subscription'; i++) {
    engine = await call('setPolish', 'subscription')
    if (engine !== 'subscription') await wait(100)
  }
  if (engine === 'subscription') {
    await call('prepare')
    const target = { app: 'slack.exe', title: 'general | Acme - Slack', className: 'Chrome_WidgetWin_1' }
    for (const raw of ['um so can you like send me the uh deck before three no wait four', 'okay so first the budget second hiring and third the launch date']) {
      const t = Date.now()
      const out = await call('polish', { raw, target })
      console.log(`polish via subscription ${Date.now() - t} ms: ${JSON.stringify(out)}`)
      if (!out || out === raw) throw new Error('subscription polish returned nothing new')
    }
  } else console.log('skipped subscription polish: Claude Code not found')

  console.log(`e2e passed (screenshots in ${shots})`)
} catch (err) {
  failed = true
  console.error('e2e FAILED:', err)
} finally {
  await app.close()
}
process.exit(failed ? 1 : 0)
