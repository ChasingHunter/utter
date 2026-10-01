import koffi from 'koffi'
import { sendKeys } from './win32'

// Low-level keyboard hook, so a single modifier (Right Alt) can be the talk key.
// Electron's globalShortcut can't bind a lone modifier, and polling can't tell
// "Alt held alone" from "Alt+Tab".
//
// The talk key itself is kept from apps: a lone Alt press/release toggles the menu bar in apps
// like Notepad, which then swallows the paste. If another key is pressed while it's held (a
// shortcut, or an AltGr character), the talk key's press is handed to the app after all, just
// before that other key, so shortcuts keep working. Every other key passes through untouched.

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr'
})
const HookProc = koffi.proto('intptr __stdcall LowLevelKeyboardProc(int nCode, uintptr wParam, void *lParam)')
const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, LowLevelKeyboardProc *lpfn, void *hmod, uint32 threadId)')
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)')
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *name)')

const WH_KEYBOARD_LL = 13
const WM_KEYDOWN = 0x100
const WM_SYSKEYDOWN = 0x104
const LLKHF_INJECTED = 0x10

/** Keys that can be the talk key on their own. */
export const SOLO_KEYS: Record<string, number> = {
  LeftAlt: 0xa4,
  RightAlt: 0xa5,
  LeftCtrl: 0xa2,
  RightCtrl: 0xa3,
  RightShift: 0xa1,
  CapsLock: 0x14,
  F13: 0x7c,
  F24: 0x87
}

export interface SoloKeyEvents {
  /** Key went down with nothing else held. Fires once per press. */
  press(): void
  /** Still held alone after `holdMs`: this press is dictation, not a shortcut. */
  hold(): void
  /** Key released. `solo` is false if another key was pressed during the hold. */
  release(heldMs: number, solo: boolean): void
  /** Another key was pressed while ours was down (Alt+Tab etc.). */
  combo(): void
}

let hook: unknown
let callback: ReturnType<typeof koffi.register> | undefined
let held = false

/** True while the talk key is down (so a re-hook never cuts into a press). */
export function keyHeld(): boolean {
  return held
}

/** Watches one key; returns false if the hook couldn't be installed. */
export function watchSoloKey(vk: number, holdMs: number, on: SoloKeyEvents): boolean {
  unwatch()
  let down = false
  let solo = true
  let downAt = 0
  let timer: NodeJS.Timeout | undefined

  /** Returns true to keep the event from apps. */
  const handle = (wParam: number, info: { vkCode: number; scanCode: number; flags: number }): boolean => {
    // Keys we inject ourselves (the paste, a replayed talk key) must not count as the user's.
    if (process.env.UTTER_HOOK_TEST) {
      // Test mode counts injected keys, but only F23/F24 so real typing (or another app's injection) can't interfere.
      if (info.vkCode !== 0x86 && info.vkCode !== 0x87) return false
    } else if (info.flags & LLKHF_INJECTED) return false
    // On layouts where Right Alt is AltGr, Windows adds a fake Left Ctrl (scan code 0x21D) to every
    // Right Alt press, including auto-repeats. It isn't the user pressing Ctrl, so it's not a combo.
    if (info.vkCode === 0xa2 && info.scanCode === 0x21d) return false
    const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN
    if (info.vkCode === vk) {
      if (isDown) {
        if (down) return solo // auto-repeat: hidden while it's ours, passed on once it's a shortcut
        down = held = true
        solo = true
        downAt = Date.now()
        on.press()
        timer = setTimeout(() => down && solo && on.hold(), holdMs)
        return true
      }
      if (!down) return false
      down = held = false
      clearTimeout(timer)
      on.release(Date.now() - downAt, solo)
      // The app only saw a press if this turned into a shortcut; then it needs the release too.
      return solo
    }
    if (down && solo && isDown) {
      solo = false
      clearTimeout(timer)
      on.combo()
      // Hand the talk key's press to the app first, then this key, in that order. Injected keys
      // land behind the event being handled, so this one is swallowed and re-sent after it.
      sendKeys([vk], false)
      sendKeys([info.vkCode], false)
      return true
    }
    return false
  }

  callback = koffi.register((nCode: number, wParam: number, lParam: unknown) => {
    if (nCode >= 0) {
      try {
        if (handle(Number(wParam), koffi.decode(lParam, KBDLLHOOKSTRUCT) as { vkCode: number; scanCode: number; flags: number })) return 1
      } catch (err) {
        console.error('[keyhook]', err)
      }
    }
    return CallNextHookEx(null, nCode, wParam, lParam)
  }, koffi.pointer(HookProc))
  hook = SetWindowsHookExW(WH_KEYBOARD_LL, callback, GetModuleHandleW(null), 0)
  if (!hook) {
    koffi.unregister(callback)
    callback = undefined
    return false
  }
  return true
}

export function unwatch(): void {
  held = false
  if (hook) UnhookWindowsHookEx(hook)
  if (callback) koffi.unregister(callback)
  hook = undefined
  callback = undefined
}
