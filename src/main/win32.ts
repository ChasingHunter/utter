import koffi from 'koffi'

// Thin user32 bindings via koffi (FFI with prebuilt binaries, so no compiler needed).

const user32 = koffi.load('user32.dll')

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr'
})
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr'
})
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
})

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)')
const MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)')
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)')

const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const INPUT_SIZE = koffi.sizeof(INPUT)

// RCtrl, RAlt, LWin, RWin, Apps, and the nav block need the extended-key flag.
const EXTENDED = new Set([0xa3, 0xa5, 0x5b, 0x5c, 0x5d, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e])

function key(vk: number, up: boolean): unknown {
  return {
    type: 1,
    u: {
      ki: {
        wVk: vk,
        wScan: MapVirtualKeyW(vk, 0),
        dwFlags: (EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0),
        time: 0,
        dwExtraInfo: 0
      }
    }
  }
}

/** Press keys in order (down) or release in reverse order (up), as one atomic batch. */
export function sendKeys(vks: number[], up: boolean): number {
  const seq = up ? [...vks].reverse() : vks
  const inputs = seq.map((vk) => key(vk, up))
  return SendInput(inputs.length, inputs, INPUT_SIZE)
}

export const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5b, RWIN: 0x5c, V: 0x56 }

/** Virtual-key code for the main (non-modifier) key of an Electron accelerator like "Control+Shift+Space". */
export function acceleratorKey(accel: string): number | undefined {
  const key = accel.split('+').pop()!.trim().toUpperCase()
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0)
  const fn = key.match(/^F(\d{1,2})$/)
  if (fn) return 0x6f + Number(fn[1])
  const named: Record<string, number> = { SPACE: 0x20, ENTER: 0x0d, RETURN: 0x0d, ESCAPE: 0x1b, ESC: 0x1b, TAB: 0x09, BACKSPACE: 0x08, '`': 0xc0, '/': 0xbf, '.': 0xbe, ',': 0xbc, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '-': 0xbd, '=': 0xbb }
  return named[key]
}

export function isKeyDown(vk: number): boolean {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0
}

/** Resolves once the user has physically released Ctrl/Alt/Shift/Win (or after timeout). */
export async function waitForModifiersReleased(timeoutMs = 1500): Promise<void> {
  const mods = [VK.SHIFT, VK.CONTROL, VK.MENU, VK.LWIN, VK.RWIN]
  const end = Date.now() + timeoutMs
  while (Date.now() < end && mods.some(isKeyDown)) await new Promise((r) => setTimeout(r, 15))
}

export type Hwnd = unknown

export function foregroundWindow(): Hwnd {
  return GetForegroundWindow()
}

export function focusWindow(hwnd: Hwnd): boolean {
  return hwnd ? SetForegroundWindow(hwnd) : false
}

/** koffi hands back a fresh pointer object per call, so compare addresses. */
export function sameWindow(a: Hwnd, b: Hwnd): boolean {
  return !!a && !!b && koffi.address(a) === koffi.address(b)
}
