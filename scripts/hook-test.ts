// Checks the low-level hook fires inside Electron's main thread, using F24/F23 (no app uses them) via SendInput.
// Run: npm run test:hook
import { app } from 'electron'
import { sendKeys } from '../src/main/win32'
import * as kh from '../src/main/keyhook'
const log: string[] = []
app.whenReady().then(async () => {
  const ok = kh.watchSoloKey(0x87, 150, {
    press: () => log.push('press'),
    hold: () => log.push('hold'),
    release: (ms, solo) => log.push(`release ${ms >= 150 ? 'long' : 'short'} solo=${solo}`),
    combo: () => log.push('combo')
  })
  console.log('installed', ok)
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  sendKeys([0x87], false); await wait(300); sendKeys([0x87], true); await wait(100)   // long solo
  sendKeys([0x87], false); await wait(40); sendKeys([0x87], true); await wait(100)    // tap
  sendKeys([0x87], false); await wait(40); sendKeys([0x86], false); sendKeys([0x86], true); await wait(300); sendKeys([0x87], true); await wait(100) // combo with F23
  const want = ["press","hold","release long solo=true","press","release short solo=true","press","combo","release long solo=false"]
  const pass = JSON.stringify(log) === JSON.stringify(want)
  console.log(pass ? "hook test passed" : `hook test FAILED
  got  ${JSON.stringify(log)}
  want ${JSON.stringify(want)}`)
  kh.unwatch()
  app.exit(pass ? 0 : 1)
})
