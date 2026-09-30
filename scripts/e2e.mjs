// End-to-end without touching your desktop: Chromium's fake mic plays a WAV into the pill,
// we drive dictation through a test hook, and check the transcript. Never pastes and never
// touches the clipboard. Screenshots of the pill land in out/e2e/.
// Run: npm run test:e2e [path.wav]
// UTTER_FRESH=1 ignores Orbit's copy of the model and downloads it the way a new install would (482 MB).
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const wav = resolve(process.argv[2] ?? join(root, 'test', 'fixtures', 'speech0.wav'))
// Chromium plays silence for a missing file instead of failing, so check up front.
if (!existsSync(wav)) throw new Error(`Missing audio fixture: ${wav}`)
const dataDir = join(root, 'out', 'e2e-profile')
const shots = join(root, 'out', 'e2e')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shots, { recursive: true })

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
  await wait(4000)
  const t0 = Date.now()
  const stopping = call('stop')
  await wait(150)
  await pill.screenshot({ path: join(shots, '2-thinking.png') })
  await stopping
  const text = await call('last')
  console.log(`transcript (${Date.now() - t0} ms after stop): ${JSON.stringify(text)}`)
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

  // 3. Cancel returns to idle without producing text, and closes the card.
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
