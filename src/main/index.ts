import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell, Tray } from 'electron'
import { join } from 'node:path'
import type { PillCommand } from '../preload'
import { trayIcon, type IconState } from './icon'
import { pasteInto } from './paste'
import { loadSettings, saveSettings, settings, settingsPath } from './settings'
import { findModel, installModel, MODEL, transcribe, warmUp } from './stt'
import { acceleratorKey, foregroundWindow, isKeyDown, type Hwnd } from './win32'

const E2E = !!process.env.DICTATE_E2E
if (process.env.DICTATE_DATA_DIR) app.setPath('userData', process.env.DICTATE_DATA_DIR)
// Windows drops toast notifications from apps without an ID; unpackaged, the exe path is the ID that works.
app.setAppUserModelId(app.isPackaged ? 'dev.dictate.desktop' : process.execPath)

if (!E2E && !app.requestSingleInstanceLock()) app.quit()

// A tap shorter than this starts dictation and leaves it running (toggle); longer is hold-to-talk.
const HOLD_MS = 350
const PILL = { width: 380, height: 48 }

type State = 'idle' | 'recording' | 'transcribing'
let state: State = 'idle'
let target: Hwnd
let lastText = ''
let tray: Tray | undefined
let pill: BrowserWindow | undefined
let maxTimer: NodeJS.Timeout | undefined
let hotkeyHeld = false
let downloading: number | undefined // 0..1 while the model downloads
let pendingAudio: ((samples: Float32Array) => void) | undefined

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Dictate', body, silent: true }).show()
  console.log(`[dictate] ${body}`)
}

function send(cmd: PillCommand): void {
  pill?.webContents.send('pill:cmd', cmd)
}

function createPill(): BrowserWindow {
  const w = new BrowserWindow({
    ...PILL,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never takes focus, so the app you're typing in stays in front the whole time.
    focusable: false,
    webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, backgroundThrottling: false }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setIgnoreMouseEvents(true)
  void w.loadFile(join(__dirname, 'index.html'))
  return w
}

/** Bottom-centre of the screen the cursor is on. */
function showPill(): void {
  if (!pill) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  pill.setBounds({ x: Math.round(workArea.x + (workArea.width - PILL.width) / 2), y: workArea.y + workArea.height - PILL.height - 48, ...PILL })
  pill.showInactive()
}

/** "Control+Shift+Space" → "Ctrl+Shift+Space", the way Windows labels it. */
const keyLabel = (): string => settings.hotkey.replace(/\b(Command|Cmd)OrControl\b|\bControl\b/g, 'Ctrl')

/** Shows a short message in the pill while idle. */
function flash(text: string, ms = 3500): void {
  if (state !== 'idle') return
  showPill()
  send({ type: 'status', state: 'info', text })
  setTimeout(() => {
    if (state === 'idle') pill?.hide()
  }, ms)
}

function setState(next: State): void {
  state = next
  const icon: IconState = next === 'recording' ? 'recording' : next === 'transcribing' ? 'busy' : 'idle'
  tray?.setImage(trayIcon(icon))
  refreshTray()
}

async function start(): Promise<void> {
  if (state !== 'idle') return
  if (!findModel()) {
    offerModelDownload()
    return
  }
  target = foregroundWindow()
  setState('recording')
  showPill()
  send({ type: 'start' })
  // Esc cancels, but only while recording so we don't eat it the rest of the time.
  globalShortcut.register('Escape', () => void cancel())
  maxTimer = setTimeout(() => void stop(), settings.maxSeconds * 1000)
}

function endRecording(): void {
  clearTimeout(maxTimer)
  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
}

/** Stops recording, transcribes, and pastes into the window that was in front when we started. */
async function stop(): Promise<void> {
  if (state !== 'recording') return
  endRecording()
  setState('transcribing')
  try {
    const samples = await new Promise<Float32Array>((resolve, reject) => {
      pendingAudio = resolve
      setTimeout(() => reject(new Error('No audio came back from the recorder')), 5000)
      send({ type: 'stop' })
    }).finally(() => (pendingAudio = undefined))
    const t0 = Date.now()
    const text = await transcribe(samples)
    console.log(`[dictate] ${(samples.length / 16000).toFixed(1)} s audio → ${Date.now() - t0} ms: ${JSON.stringify(text)}`)
    if (!text) {
      send({ type: 'status', state: 'error', text: "Didn't catch that" })
      await new Promise((r) => setTimeout(r, 900))
      return
    }
    lastText = text
    pill?.hide()
    // Tests run on a real desktop: never paste there.
    if (!E2E) await pasteInto(target, settings.trailingSpace ? `${text} ` : text, settings.restoreClipboard)
  } catch (err) {
    notify(`Dictation failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    pill?.hide()
    setState('idle')
  }
}

async function cancel(): Promise<void> {
  if (state !== 'recording') return
  endRecording()
  send({ type: 'cancel' })
  pill?.hide()
  setState('idle')
}

/**
 * Hotkey pressed. Windows repeats the hotkey while it's held, so we ignore it until the key comes back up.
 * Hold mode: releasing after HOLD_MS pastes. A quick tap keeps recording until the next press.
 */
async function onHotkey(): Promise<void> {
  if (hotkeyHeld) return
  const vk = acceleratorKey(settings.hotkey)
  hotkeyHeld = true
  const pressedAt = Date.now()
  const wasIdle = state === 'idle'
  try {
    if (wasIdle) await start()
    else if (state === 'recording') void stop()
    if (!vk) return
    while (isKeyDown(vk)) await new Promise((r) => setTimeout(r, 25))
    if (wasIdle && settings.mode === 'hold' && Date.now() - pressedAt >= HOLD_MS) void stop()
  } finally {
    hotkeyHeld = false
  }
}

function bindHotkey(): void {
  globalShortcut.unregisterAll()
  let ok = false
  try {
    ok = globalShortcut.register(settings.hotkey, () => void onHotkey())
  } catch {
    // invalid accelerator
  }
  if (!ok) notify(`Couldn't use the hotkey ${settings.hotkey}. Another app may own it, or it isn't valid. Change "hotkey" in settings.json.`)
}

function offerModelDownload(): void {
  if (downloading !== undefined) {
    notify(`Still downloading the speech model (${Math.round(downloading * 100)}%).`)
    return
  }
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Dictate',
    message: 'Download the speech model?',
    detail: `Dictate needs NVIDIA's Parakeet model (${MODEL.sizeMb} MB, one-time). It runs fully on this PC; your audio never leaves it.`,
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
      tray?.setToolTip(phase === 'unpack' ? 'Dictate: unpacking speech model…' : `Dictate: downloading speech model ${pct}%`)
    })
    downloading = undefined
    await warmUp()
    notify(`Ready. Hold ${settings.hotkey} and talk.`)
  } catch (err) {
    downloading = undefined
    notify(`Model download failed: ${err instanceof Error ? err.message : err}`)
  }
  refreshTray()
}

function refreshTray(): void {
  if (!tray) return
  const hasModel = !!findModel()
  const how = settings.mode === 'hold' ? 'hold to talk, or tap to start/stop' : 'press to start, again to paste'
  if (downloading === undefined) {
    const status = !hasModel ? 'speech model not installed' : state === 'idle' ? `${settings.hotkey}` : state
    tray.setToolTip(`Dictate: ${status}`)
  }
  const setMode = (mode: 'hold' | 'toggle') => () => {
    saveSettings({ mode })
    refreshTray()
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${settings.hotkey}: ${how}`, enabled: false },
      { type: 'separator' },
      { label: 'Hold to talk', type: 'radio', checked: settings.mode === 'hold', click: setMode('hold') },
      { label: 'Press to start and stop', type: 'radio', checked: settings.mode === 'toggle', click: setMode('toggle') },
      { type: 'separator' },
      ...(hasModel
        ? []
        : [{ label: downloading === undefined ? `Download speech model (${MODEL.sizeMb} MB)` : 'Downloading speech model…', enabled: downloading === undefined, click: () => void downloadModel() }]),
      ...(app.isPackaged
        ? [{ label: 'Start with Windows', type: 'checkbox' as const, checked: app.getLoginItemSettings().openAtLogin, click: (item: Electron.MenuItem) => app.setLoginItemSettings({ openAtLogin: item.checked }) }]
        : []),
      { label: 'Edit settings', click: () => void shell.openPath(settingsPath()) },
      { label: 'Reload settings', click: reload },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

function reload(): void {
  const problem = loadSettings()
  if (problem) notify(problem)
  bindHotkey()
  refreshTray()
}

app.whenReady().then(async () => {
  // Only the pill asks for anything, and it only ever needs the mic.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  ipcMain.on('pill:audio', (_e, samples: Float32Array) => pendingAudio?.(samples))
  ipcMain.on('pill:ready', (_e, ms: number) => console.log(`[dictate] mic open in ${ms} ms`))
  ipcMain.on('pill:error', (_e, message: string) => {
    notify(`Microphone problem: ${message}`)
    void cancel()
  })

  const problem = loadSettings()
  if (problem) notify(problem)
  pill = createPill()
  tray = new Tray(trayIcon('idle'))
  refreshTray()
  bindHotkey()

  if (findModel()) {
    // There's no window, so say hello once the pill can draw; otherwise launching looks like nothing happened.
    if (!E2E) pill.webContents.once('did-finish-load', () => flash(`Ready. Hold ${keyLabel()} and talk`))
    warmUp().catch((err) => notify(`Couldn't load the speech model: ${err instanceof Error ? err.message : err}`))
  } else if (!E2E) offerModelDownload()

  if (E2E) {
    Object.assign(globalThis, {
      __dictate: { start, stop, cancel, state: () => state, last: () => lastText, pill: () => pill, warmUp }
    })
  }
})

app.on('second-instance', () => flash(`Already running. Hold ${keyLabel()} to talk`))
// Tray app: closing the pill must not quit.
app.on('window-all-closed', () => {})
app.on('will-quit', () => globalShortcut.unregisterAll())
