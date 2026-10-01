import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, powerMonitor, screen, session, shell, Tray } from 'electron'
import { join } from 'node:path'
import type { PillCommand } from '../preload'
import { trayIcon, type IconState } from './icon'
import { keyHeld, SOLO_KEYS, unwatch, watchSoloKey } from './keyhook'
import { logPath, preview, startFileLog } from './log'
import { pasteInto } from './paste'
import { findClaude, polish, polishEngine, prepare, shutdown as shutdownPolish } from './polish'
import { loadSettings, saveSettings, settings, settingsPath, type Settings } from './settings'
import { LiveTranscriber } from './live'
import { findModel, installModel, MODEL, removeStaleDownload, warmUp } from './stt'
import { acceleratorKey, foregroundWindow, hasTextTarget, isKeyDown, windowInfo, type Hwnd, type WindowInfo } from './win32'

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
let pendingEnd: (() => void) | undefined
/** Transcribes the current dictation as it comes in. */
let live: LiveTranscriber | undefined
let micOpen = false

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Utter', body, silent: true }).show()
  console.log(`[utter] ${body}`)
}

/** Commands sent before the pill page has loaded would be lost; they wait here instead. */
let pillLoaded = false
const pendingCmds: PillCommand[] = []

function send(cmd: PillCommand): void {
  if (!pill) return
  if (!pillLoaded) pendingCmds.push(cmd)
  else pill.webContents.send('pill:cmd', cmd)
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
  pillLoaded = false
  w.webContents.on('did-finish-load', () => {
    pillLoaded = true
    for (const cmd of pendingCmds.splice(0)) w.webContents.send('pill:cmd', cmd)
  })
  // The pill records the audio, so a dead pill means a silent Utter. Rebuild it.
  w.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[utter] pill window died (${details.reason}), recreating it`)
    void cancel()
    w.destroy()
    pill = createPill()
  })
  w.on('unresponsive', () => console.warn('[utter] pill window not responding'))
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
  live?.cancel()
  live = new LiveTranscriber()
  micOpen = false
  const thisDictation = live
  setTimeout(() => {
    if (live === thisDictation && !micOpen) console.warn(`[utter] mic still not open 4 s after the key press (pill ${pillLoaded ? 'loaded' : 'not loaded'})`)
  }, 4000)
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
  clearTap()
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
  const transcriber = live!
  live = undefined
  try {
    await new Promise<void>((resolve, reject) => {
      pendingEnd = resolve
      setTimeout(() => reject(new Error('The recorder never finished')), 5000)
      send({ type: 'stop' })
    }).finally(() => (pendingEnd = undefined))
    // Most of the audio was already transcribed while you talked; this waits for the last piece.
    const t0 = Date.now()
    const raw = await transcriber.finish()
    const t1 = Date.now()
    const audio = `${(transcriber.samples / 16000).toFixed(1)} s audio (${transcriber.piecesDone} pieces done while talking), stt after release ${t1 - t0} ms`
    if (!raw) {
      console.log(`[utter] ${audio}: nothing recognised`)
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
      `[utter] ${audio}, polish ${Date.now() - t1} ms → ${targetInfo.app || '?'}: ${preview(text)}`
    )
    lastText = text
    if (!hasTextTarget(targetInfo)) {
      // Desktop, taskbar, nothing focused: keep it on the clipboard and say so.
      await showCopyCard(text, "Nowhere to type, so it's on your clipboard")
      return
    }
    hidePill()
    // Tests run on a real desktop: never paste there.
    if (!E2E) {
      try {
        await pasteInto(target, settings.trailingSpace ? `${text} ` : text, settings.restoreClipboard)
      } catch (err) {
        // The words are the valuable part: never lose them to a paste problem.
        console.error('[utter] paste failed:', err instanceof Error ? err.message : err)
        await showCopyCard(text, "Couldn't paste, so it's on your clipboard")
        return
      }
    }
  } catch (err) {
    console.error('[utter] dictation failed:', err instanceof Error ? err.stack ?? err.message : err)
    hidePill()
    notify(`Dictation failed: ${err instanceof Error ? err.message : err}`)
  }
  setState('idle')
}

/** Puts the text on the clipboard and shows the card with a Copy button. */
async function showCopyCard(text: string, note: string): Promise<void> {
  // Tests run on a real desktop, so they never touch the clipboard.
  if (!E2E) await clipboard.writeText(text).catch((err) => console.error('[utter] clipboard write failed:', err))
  cardOpen = true
  setState('idle')
  showPill()
  send({ type: 'card', text, note })
}

/** Throws the recording away. */
async function cancel(): Promise<void> {
  if (state !== 'recording') return
  endRecording()
  handsFree = false
  live?.cancel()
  live = undefined
  send({ type: 'cancel' })
  setState('idle')
  if (shown) hidePill()
}

// ---- the talk key -----------------------------------------------------------

/** After a quick tap the recording keeps going this long, in case a second tap makes it hands-free. */
let tapTimer: NodeJS.Timeout | undefined
/** The current press is the second of a double-tap. */
let secondPress = false
let stopOnRelease = false

function clearTap(): void {
  clearTimeout(tapTimer)
  tapTimer = undefined
  secondPress = false
}

/**
 * Single-key mode (Right Alt by default), driven by the low-level hook:
 *   hold          talk, release to paste
 *   double-tap    hands-free; the next press pastes
 *   tap / Alt+Tab ignored (the quiet recording is thrown away)
 *
 * A double-tap is one recording, not two: the first tap's recording is kept alive for
 * DOUBLE_TAP_MS and the second tap just switches it to hands-free. (Stopping and restarting
 * the mic between the taps raced, and sometimes left hands-free recording nothing.)
 */
const soloKey = {
  press(): void {
    console.log(`[key] ${settings.hotkey} down (${state}${handsFree ? ', hands-free' : ''})`)
    if (state === 'recording' && handsFree) {
      stopOnRelease = true
      return
    }
    if (state === 'recording' && tapTimer) {
      clearTimeout(tapTimer)
      tapTimer = undefined
      secondPress = true
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
  },
  release(heldMs: number, solo: boolean): void {
    console.log(`[key] up after ${heldMs} ms${solo ? '' : ' (was a combo)'} (${state})`)
    if (stopOnRelease) {
      stopOnRelease = false
      void stop()
      return
    }
    if (state !== 'recording' || handsFree || !solo) return
    if (secondPress) {
      secondPress = false
      if (heldMs >= HOLD_MS) void stop() // tap, then hold: plain hold-to-talk
      else {
        console.log('[key] double-tap: hands-free')
        handsFree = true
        reveal()
      }
      return
    }
    if (heldMs >= HOLD_MS) {
      void stop()
      return
    }
    // A single quick tap. Wait a moment for a second one before throwing the recording away.
    tapTimer = setTimeout(() => {
      tapTimer = undefined
      void cancel()
    }, DOUBLE_TAP_MS)
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

/**
 * Windows silently drops a low-level hook that's too slow to answer even once in a while, and
 * the talk key would then do nothing until a restart. Re-attaching now and then (and after sleep
 * or unlock) costs nothing, and is skipped mid-press or mid-dictation.
 */
function rehook(): void {
  if (E2E || !SOLO_KEYS[settings.hotkey] || state !== 'idle' || keyHeld()) return
  watchSoloKey(SOLO_KEYS[settings.hotkey], HOLD_MS, soloKey)
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

  ipcMain.on('pill:chunk', (_e, samples: Float32Array) => live?.push(samples))
  ipcMain.on('pill:end', () => pendingEnd?.())
  ipcMain.on('pill:ready', (_e, ms: number) => {
    micOpen = true
    console.log(`[utter] mic open in ${ms} ms`)
  })
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
  removeStaleDownload()
  pill = createPill()
  tray = new Tray(trayIcon('idle'))
  tray.on('click', () => tray?.popUpContextMenu())
  refreshTray()
  bindHotkey()
  setInterval(rehook, 5 * 60_000)
  powerMonitor.on('resume', rehook)
  powerMonitor.on('unlock-screen', rehook)
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
        prepare,
        /** The talk-key handlers the keyboard hook calls, so tests can press and release it. */
        key: soloKey,
        handsFree: () => handsFree
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
