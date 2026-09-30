import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell, Tray } from 'electron'
import { join } from 'node:path'
import type { PillCommand } from '../preload'
import { trayIcon, type IconState } from './icon'
import { SOLO_KEYS, unwatch, watchSoloKey } from './keyhook'
import { logPath, startFileLog } from './log'
import { pasteInto } from './paste'
import { findClaude, polish, polishEngine, prepare, shutdown as shutdownPolish } from './polish'
import { loadSettings, saveSettings, settings, settingsPath, type Settings } from './settings'
import { findModel, installModel, MODEL, transcribe, warmUp } from './stt'
import { acceleratorKey, foregroundWindow, hasTextTarget, isKeyDown, sendMaskKey, windowInfo, type Hwnd, type WindowInfo } from './win32'

const E2E = !!process.env.UTTER_E2E
if (process.env.UTTER_DATA_DIR) app.setPath('userData', process.env.UTTER_DATA_DIR)
startFileLog()
// Windows drops toast notifications from apps without an ID; unpackaged, the exe path is the ID that works.
app.setAppUserModelId(app.isPackaged ? 'dev.utter.desktop' : process.execPath)

if (!E2E && !app.requestSingleInstanceLock()) app.quit()

/** Held at least this long = talking (pill shows, release pastes). Shorter = a tap, which Utter ignores. */
const HOLD_MS = 250
/** Two taps this close together = hands-free. */
const DOUBLE_TAP_MS = 400
const WIN = { width: 380, height: 200 }

type State = 'idle' | 'recording' | 'working'
let state: State = 'idle'
let target: Hwnd
let targetInfo: WindowInfo = { app: '', title: '', className: '' }
let testTarget: WindowInfo | undefined // e2e only: stands in for the real foreground window
let lastText = ''
let tray: Tray | undefined
let pill: BrowserWindow | undefined
let maxTimer: NodeJS.Timeout | undefined
let hideTimer: NodeJS.Timeout | undefined
let shown = false // pill visible for the current dictation
let handsFree = false
let cardOpen = false
let downloading: number | undefined // 0..1 while the model downloads
let pendingAudio: ((samples: Float32Array) => void) | undefined

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Utter', body, silent: true }).show()
  console.log(`[utter] ${body}`)
}

function send(cmd: PillCommand): void {
  pill?.webContents.send('pill:cmd', cmd)
}

/** "RightAlt" → "Right Alt", "Control+Shift+Space" → "Ctrl+Shift+Space". */
function keyLabel(): string {
  if (SOLO_KEYS[settings.hotkey]) return settings.hotkey.replace(/([a-z])([A-Z])/g, '$1 $2')
  return settings.hotkey.replace(/\b(Command|Cmd)OrControl\b|\bControl\b/g, 'Ctrl')
}

// ---- the pill window --------------------------------------------------------

function createPill(): BrowserWindow {
  const w = new BrowserWindow({
    ...WIN,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never takes focus, so the app you're typing in stays in front the whole time.
    focusable: false,
    hasShadow: false,
    webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, backgroundThrottling: false }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  // Clicks go through to whatever is underneath, except over the copy card (see pill:hover).
  w.setIgnoreMouseEvents(true, { forward: true })
  void w.loadFile(join(__dirname, 'index.html'))
  return w
}

/** Bottom-centre of the screen the cursor is on. */
function showPill(): void {
  if (!pill) return
  clearTimeout(hideTimer)
  if (!pill.isVisible()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    pill.setBounds({ x: Math.round(workArea.x + (workArea.width - WIN.width) / 2), y: workArea.y + workArea.height - WIN.height - 12, ...WIN })
    pill.showInactive()
  }
  shown = true
}

/** Plays the exit animation, then hides. */
function hidePill(): void {
  shown = false
  cardOpen = false
  send({ type: 'leave' })
  pill?.setIgnoreMouseEvents(true, { forward: true })
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!shown && !cardOpen) pill?.hide()
  }, 200)
}

/** A short message in the pill while nothing else is going on. */
function flash(tone: 'info' | 'error', text: string, ms = 3500): void {
  if (state !== 'idle') return
  showPill()
  send({ type: 'message', tone, text })
  setTimeout(() => state === 'idle' && !cardOpen && hidePill(), ms)
}

function setState(next: State): void {
  state = next
  const icon: IconState = next === 'recording' ? 'recording' : next === 'working' ? 'busy' : 'idle'
  tray?.setImage(trayIcon(icon))
  refreshTray()
}

// ---- dictation --------------------------------------------------------------

/** Starts capturing. The pill stays hidden until `reveal()`, so an Alt+Tab never flashes it. */
function begin(): boolean {
  if (state !== 'idle') return false
  if (!findModel()) return false
  target = foregroundWindow()
  prepare()
  targetInfo = testTarget ?? windowInfo(target)
  handsFree = false
  cardOpen = false
  setState('recording')
  send({ type: 'start' })
  // Esc cancels, but only while recording so we don't eat it the rest of the time.
  globalShortcut.register('Escape', () => void cancel())
  maxTimer = setTimeout(() => void stop(), settings.maxSeconds * 1000)
  return true
}

function reveal(): void {
  if (state === 'recording') showPill()
}

function endRecording(): void {
  clearTimeout(maxTimer)
  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
}

/** Stops recording, transcribes, polishes, then pastes (or shows the copy card if there's nowhere to paste). */
async function stop(): Promise<void> {
  if (state !== 'recording') return
  endRecording()
  handsFree = false
  setState('working')
  showPill()
  send({ type: 'thinking' })
  try {
    const samples = await new Promise<Float32Array>((resolve, reject) => {
      pendingAudio = resolve
      setTimeout(() => reject(new Error('No audio came back from the recorder')), 5000)
      send({ type: 'stop' })
    }).finally(() => (pendingAudio = undefined))
    const t0 = Date.now()
    const raw = await transcribe(samples)
    const t1 = Date.now()
    if (!raw) {
      setState('idle')
      flash('error', "Didn't catch that", 1200)
      return
    }
    let text = raw
    if (polishEngine()) {
      text = await polish(raw, targetInfo).catch((err) => {
        console.warn('[utter] polish failed, using raw text:', err instanceof Error ? err.message : err)
        return raw
      })
    }
    console.log(
      `[utter] ${(samples.length / 16000).toFixed(1)} s audio, stt ${t1 - t0} ms, polish ${Date.now() - t1} ms → ${targetInfo.app || '?'}: ${JSON.stringify(text)}`
    )
    lastText = text
    if (!hasTextTarget(targetInfo)) {
      // Desktop, taskbar, nothing focused: keep it on the clipboard and say so.
      // Tests run on a real desktop, so they never touch the clipboard.
      if (!E2E) await clipboard.writeText(text)
      cardOpen = true
      setState('idle')
      send({ type: 'card', text, note: "Nowhere to type, so it's on your clipboard" })
      return
    }
    hidePill()
    // Tests run on a real desktop: never paste there.
    if (!E2E) await pasteInto(target, settings.trailingSpace ? `${text} ` : text, settings.restoreClipboard)
  } catch (err) {
    hidePill()
    notify(`Dictation failed: ${err instanceof Error ? err.message : err}`)
  }
  setState('idle')
}

/** Throws the recording away. */
async function cancel(): Promise<void> {
  if (state !== 'recording') return
  endRecording()
  handsFree = false
  send({ type: 'cancel' })
  setState('idle')
  if (shown) hidePill()
}

// ---- the talk key -----------------------------------------------------------

const isAltKey = (): boolean => settings.hotkey === 'LeftAlt' || settings.hotkey === 'RightAlt'

let lastTapAt = 0
let stopOnRelease = false

/**
 * Single-key mode (Right Alt by default), driven by the low-level hook:
 *   hold          talk, release to paste
 *   double-tap    hands-free; the next press pastes
 *   tap / Alt+Tab ignored (the quiet recording is thrown away)
 */
const soloKey = {
  press(): void {
    console.log(`[key] ${settings.hotkey} down (${state}${handsFree ? ', hands-free' : ''})`)
    if (state === 'recording' && handsFree) {
      stopOnRelease = true
      if (isAltKey()) sendMaskKey()
      return
    }
    // Start listening right away so the first word isn't lost; the pill waits for hold().
    begin()
  },
  hold(): void {
    console.log(`[key] held (${state})`)
    if (!findModel()) {
      offerModelDownload()
      return
    }
    if (state !== 'recording' || handsFree) return
    reveal()
    // Without this, letting go of Alt would open the menu bar in the app you're typing in.
    if (isAltKey()) sendMaskKey()
  },
  release(heldMs: number, solo: boolean): void {
    console.log(`[key] up after ${heldMs} ms${solo ? '' : ' (was a combo)'} (${state})`)
    if (stopOnRelease) {
      stopOnRelease = false
      void stop()
      return
    }
    if (state !== 'recording' || handsFree || !solo) return
    if (heldMs >= HOLD_MS) {
      void stop()
      return
    }
    if (Date.now() - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0
      handsFree = true
      reveal()
      return
    }
    lastTapAt = Date.now()
    void cancel()
  },
  combo(): void {
    console.log('[key] another key pressed while held: shortcut, not dictation')
    if (state === 'recording' && !handsFree) void cancel()
  }
}

let accelHeld = false

/** Accelerator mode (e.g. Ctrl+Shift+Space): hold to talk, or tap to start and tap again to paste. */
async function onAccelerator(): Promise<void> {
  if (accelHeld) return // Windows repeats the hotkey while it's held
  const vk = acceleratorKey(settings.hotkey)
  accelHeld = true
  const pressedAt = Date.now()
  try {
    if (state === 'recording') {
      void stop()
      return
    }
    if (!begin()) {
      if (!findModel()) offerModelDownload()
      return
    }
    reveal()
    if (!vk) return
    while (isKeyDown(vk)) await new Promise((r) => setTimeout(r, 25))
    if (Date.now() - pressedAt >= HOLD_MS) void stop()
    else handsFree = true
  } finally {
    accelHeld = false
  }
}

function bindHotkey(): void {
  unwatch()
  globalShortcut.unregisterAll()
  if (E2E) return // tests drive dictation directly and must not react to the real keyboard
  const vk = SOLO_KEYS[settings.hotkey]
  let ok = false
  if (vk) ok = watchSoloKey(vk, HOLD_MS, soloKey)
  else {
    try {
      ok = globalShortcut.register(settings.hotkey, () => void onAccelerator())
    } catch {
      // invalid accelerator
    }
  }
  console.log(`[utter] talk key ${settings.hotkey}: ${ok ? 'listening' : 'FAILED to bind'}`)
  if (!ok) notify(`Couldn't use ${settings.hotkey} as the talk key. Change "hotkey" in settings.json.`)
}

// ---- model download ---------------------------------------------------------

function offerModelDownload(): void {
  if (downloading !== undefined) {
    notify(`Still downloading the speech model (${Math.round(downloading * 100)}%).`)
    return
  }
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Utter',
    message: 'Download the speech model?',
    detail: `Utter needs NVIDIA's Parakeet model (${MODEL.sizeMb} MB, one-time). It runs fully on this PC; your audio never leaves it.`,
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1
  })
  if (choice === 0) void downloadModel()
}

async function downloadModel(): Promise<void> {
  downloading = 0
  refreshTray()
  let lastPct = -1
  try {
    await installModel((f, phase) => {
      const pct = Math.floor(f * 100)
      if (phase === 'download' && pct === lastPct) return
      lastPct = pct
      downloading = f
      tray?.setToolTip(phase === 'unpack' ? 'Utter: unpacking speech model…' : `Utter: downloading speech model ${pct}%`)
    })
    downloading = undefined
    await warmUp()
    flash('info', `Ready. Hold ${keyLabel()} and talk`)
  } catch (err) {
    downloading = undefined
    notify(`Model download failed: ${err instanceof Error ? err.message : err}`)
  }
  refreshTray()
}

// ---- tray -------------------------------------------------------------------

function refreshTray(): void {
  if (!tray) return
  const hasModel = !!findModel()
  if (downloading === undefined) {
    const status = !hasModel ? 'speech model not installed' : state === 'idle' ? `hold ${keyLabel()} to talk` : state
    tray.setToolTip(`Utter: ${status}`)
  }
  const how = SOLO_KEYS[settings.hotkey] ? `Hold ${keyLabel()} to talk, double-tap for hands-free` : `Hold ${keyLabel()} to talk, or tap to start and stop`
  const engine = polishEngine()
  const canPolish = settings.polish === 'off' ? true : !!engine
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: how, enabled: false },
      { type: 'separator' },
      {
        label:
          engine === 'subscription'
            ? 'Polish with Claude Haiku (your Claude plan)'
            : engine === 'api'
              ? 'Polish with Claude Haiku (API key)'
              : canPolish
                ? 'Polish with Claude Haiku'
                : 'Polish with Claude Haiku (needs Claude Code or an API key)',
        type: 'checkbox',
        checked: !!engine,
        enabled: canPolish,
        click: (item) => {
          saveSettings({ polish: item.checked ? 'auto' : 'off' })
          refreshTray()
        }
      },
      { label: 'Copy last dictation', enabled: !!lastText, click: () => void clipboard.writeText(lastText) },
      { type: 'separator' },
      ...(hasModel
        ? []
        : [{ label: downloading === undefined ? `Download speech model (${MODEL.sizeMb} MB)` : 'Downloading speech model…', enabled: downloading === undefined, click: () => void downloadModel() }]),
      ...(app.isPackaged
        ? [
            {
              label: 'Start with Windows',
              type: 'checkbox' as const,
              checked: settings.startAtLogin,
              click: (item: Electron.MenuItem) => {
                saveSettings({ startAtLogin: item.checked })
                applyLoginItem()
              }
            }
          ]
        : []),
      { label: 'Edit settings', click: () => void shell.openPath(settingsPath()) },
      { label: 'Open log', click: () => void shell.openPath(logPath()) },
      { label: 'Reload settings', click: reload },
      { type: 'separator' },
      { label: 'Quit Utter', click: () => app.quit() }
    ])
  )
}

function applyLoginItem(): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin })
}

function reload(): void {
  const problem = loadSettings()
  if (problem) notify(problem)
  bindHotkey()
  applyLoginItem()
  refreshTray()
}

// ---- startup ----------------------------------------------------------------

app.whenReady().then(async () => {
  // Only the pill asks for anything, and it only ever needs the mic.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  ipcMain.on('pill:audio', (_e, samples: Float32Array) => pendingAudio?.(samples))
  ipcMain.on('pill:ready', (_e, ms: number) => console.log(`[utter] mic open in ${ms} ms`))
  ipcMain.on('pill:error', (_e, message: string) => {
    notify(`Microphone problem: ${message}`)
    void cancel()
  })
  ipcMain.on('pill:copy', () => void clipboard.writeText(lastText))
  ipcMain.on('pill:hover', (_e, over: boolean) => pill?.setIgnoreMouseEvents(!over, { forward: true }))
  ipcMain.on('pill:dismiss', () => cardOpen && hidePill())

  const problem = loadSettings()
  if (problem) notify(problem)
  applyLoginItem()
  pill = createPill()
  tray = new Tray(trayIcon('idle'))
  tray.on('click', () => tray?.popUpContextMenu())
  refreshTray()
  bindHotkey()
  // Looking for Claude Code runs where.exe; the tray is already up, so update it when that's done.
  void findClaude().then(refreshTray)

  if (findModel()) {
    // There's no window, so say hello once the pill can draw; otherwise launching looks like nothing happened.
    if (!E2E) pill.webContents.once('did-finish-load', () => flash('info', `Ready. Hold ${keyLabel()} and talk`))
    warmUp().catch((err) => notify(`Couldn't load the speech model: ${err instanceof Error ? err.message : err}`))
  } else if (!E2E) offerModelDownload()

  if (E2E) {
    Object.assign(globalThis, {
      __utter: {
        begin,
        reveal,
        stop,
        cancel,
        warmUp,
        state: () => state,
        last: () => lastText,
        cardOpen: () => cardOpen,
        pill: () => pill,
        /** Pretend the dictation started over this kind of window. */
        setTarget: (info: WindowInfo) => (testTarget = info),
        hasModel: () => !!findModel(),
        downloadModel: () =>
          installModel((f, phase) => phase === 'download' && Math.round(f * 100) % 10 === 0 && console.log(`[utter] model ${Math.round(f * 100)}%`)),
        /** Switch polishing for this run only (not saved). */
        setPolish: (mode: Settings['polish']) => {
          settings.polish = mode
          return polishEngine() ?? null
        },
        polish: ({ raw, target }: { raw: string; target: WindowInfo }) => polish(raw, target),
        prepare
      }
    })
  }
})

app.on('second-instance', () => flash('info', `Already running. Hold ${keyLabel()} to talk`))
// Tray app: hiding the pill must not quit.
app.on('window-all-closed', () => {})
app.on('will-quit', () => {
  unwatch()
  shutdownPolish()
  globalShortcut.unregisterAll()
})
