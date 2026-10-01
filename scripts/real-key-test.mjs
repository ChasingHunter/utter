// Drives the real app through the real keyboard hook: Windows-level key presses (F24 stands in
// for the talk key, so nothing else on your desktop reacts), the real mic, and screenshots of the
// screen to check the pill actually shows. Dry run: never pastes or touches the clipboard.
// Screenshots: out/realkey/*.png. Run: npm run build && node scripts/real-key-test.mjs
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import koffi from 'koffi'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const dataDir = join(root, 'out', 'realkey-profile')
const shots = join(root, 'out', 'realkey')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ hotkey: 'F24', polish: 'off', startAtLogin: false }))

// SendInput for F24, the same way a keyboard would deliver it.
const user32 = koffi.load('user32.dll')
const KI = koffi.struct({ wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
const MI = koffi.struct({ dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
const INPUT = koffi.struct({ type: 'uint32', u: koffi.union({ mi: MI, ki: KI }) })
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, _In_ void *inputs, int size)')
const press = (up) => {
  const buf = Buffer.alloc(koffi.sizeof(INPUT))
  koffi.encode(buf, INPUT, { type: 1, u: { ki: { wVk: 0x87, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } })
  SendInput(1, buf, koffi.sizeof(INPUT))
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tap = async (ms = 90) => {
  press(false)
  await wait(ms)
  press(true)
}

const logFile = join(dataDir, 'utter.log')
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
const until = async (re, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (re.test(log())) return true
    await wait(100)
  }
  return false
}

/** Saves the bottom-centre of the screen (where the pill sits) and reports whether anything dark is there. */
function shot(name) {
  const file = join(shots, `${name}.png`)
  const ps = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$s = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = 440; $h = 220; $x = $s.X + [int](($s.Width - $w) / 2); $y = $s.Bottom - $h
$b = New-Object System.Drawing.Bitmap $w, $h
[System.Drawing.Graphics]::FromImage($b).CopyFromScreen($x, $y, 0, 0, $b.Size)
$b.Save('${file.replace(/'/g, "''")}')`
  execFileSync('powershell', ['-NoProfile', '-Command', ps])
  return file
}

const app = spawn(electron, [join(root, 'out', 'main.js')], {
  env: { ...process.env, UTTER_DATA_DIR: dataDir, UTTER_HOOK_TEST: '1', UTTER_DRY_RUN: '1' },
  stdio: 'ignore'
})
let failed = false
const fail = (msg) => {
  failed = true
  console.log(`FAIL: ${msg}`)
}
try {
  if (!(await until(/talk key F24: listening/, 20_000))) throw new Error('app never started listening')
  if (!(await until(/model loaded/, 30_000))) throw new Error('model never loaded')
  await wait(4000) // let the ready message fade

  // Double-tap: hands-free should start and the pill should be on screen.
  await tap()
  await wait(140)
  await tap()
  await wait(1500)
  console.log(`double-tap pill: ${shot('1-double-tap')}`)
  if (!/double-tap: hands-free/.test(log())) fail('double-tap did not switch to hands-free')
  await wait(1500)
  await tap() // finish
  if (!(await until(/s audio .*\n(?![\s\S]*RightAlt)/, 10_000))) fail('no result after finishing hands-free')
  await wait(2500)

  // Hold: the pill should be on screen while held.
  press(false)
  await wait(1200)
  console.log(`hold pill: ${shot('2-hold')}`)
  press(true)
  await wait(3000)
} catch (err) {
  fail(err.message)
} finally {
  app.kill()
}
console.log('--- log:')
console.log(log().split('\n').filter((l) => /\[key\]|audio|mic|pill|FAIL|warn|error/.test(l)).join('\n'))
console.log(failed ? 'real-key test FAILED' : 'real-key test finished: check the screenshots')
process.exit(failed ? 1 : 0)
