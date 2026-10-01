// Checks the low-level hook inside Electron's main thread, using F24 as the talk key and F23 as
// "another key" (no app uses them), sent with SendInput.
// Also checks what apps get to see: an observer hook installed *before* ours runs *after* it, so
// it only sees what our hook passes on. The talk key on its own must never reach apps (a lone Alt
// toggles menu bars and swallows the paste); with another key it must reach them, before that key.
// Run: npm run test:hook
import { app } from 'electron'
import koffi from 'koffi'
import { sendKeys } from '../src/main/win32'
import * as kh from '../src/main/keyhook'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const KeyInfo = koffi.struct({ vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
const ObserverProc = koffi.proto('intptr __stdcall ObserverProc(int nCode, uintptr wParam, void *lParam)')
const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, ObserverProc *lpfn, void *hmod, uint32 threadId)')
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)')
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *name)')

const events: string[] = [] // what our handlers were told
const seen: string[] = [] // what got past our hook, i.e. what apps would see
const name = (vk: number): string => (vk === 0x87 ? 'F24' : 'F23')

app.whenReady().then(async () => {
  const observer = koffi.register((nCode: number, wParam: number, lParam: unknown) => {
    const k = koffi.decode(lParam, KeyInfo) as { vkCode: number }
    if (nCode >= 0 && (k.vkCode === 0x86 || k.vkCode === 0x87)) seen.push(`${name(k.vkCode)} ${Number(wParam) & 1 ? 'up' : 'down'}`)
    return CallNextHookEx(null, nCode, wParam, lParam)
  }, koffi.pointer(ObserverProc))
  const observerHook = SetWindowsHookExW(13, observer, GetModuleHandleW(null), 0)

  kh.watchSoloKey(0x87, 150, {
    press: () => events.push('press'),
    hold: () => events.push('hold'),
    release: (ms, solo) => events.push(`release ${ms >= 150 ? 'long' : 'short'} solo=${solo}`),
    combo: () => events.push('combo')
  })
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const check = (what: string, got: string[], want: string[]): boolean => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) console.log(`  ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
    return ok
  }

  sendKeys([0x87], false); await wait(300); sendKeys([0x87], true); await wait(100) // held alone
  const heldSeen = seen.splice(0)
  sendKeys([0x87], false); await wait(40); sendKeys([0x87], true); await wait(100) // tapped
  const tapSeen = seen.splice(0)
  sendKeys([0x87], false); await wait(40); sendKeys([0x86], false); sendKeys([0x86], true); await wait(300); sendKeys([0x87], true); await wait(100) // with F23
  const comboSeen = seen.splice(0)

  const pass = [
    check('events', events, ['press', 'hold', 'release long solo=true', 'press', 'release short solo=true', 'press', 'combo', 'release long solo=false']),
    check('held alone: apps see', heldSeen, []),
    check('tapped: apps see', tapSeen, []),
    check('with another key: apps see', comboSeen, ['F24 down', 'F23 down', 'F23 up', 'F24 up'])
  ].every(Boolean)
  console.log(pass ? 'hook test passed' : 'hook test FAILED')
  kh.unwatch()
  UnhookWindowsHookEx(observerHook)
  app.exit(pass ? 0 : 1)
})
