import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Settings {
  /**
   * The talk key. Either one key on its own (LeftAlt, RightAlt, LeftCtrl, RightCtrl, RightShift, CapsLock, F13, F24),
   * or an Electron accelerator like "Control+Shift+Space".
   * Hold to talk, let go to paste. Double-tap for hands-free; tap again to paste.
   */
  hotkey: string
  /** Adds a space after each dictation so back-to-back ones don't run together. */
  trailingSpace: boolean
  /** Put back whatever was on the clipboard before we pasted. */
  restoreClipboard: boolean
  /** Recording stops by itself after this long. */
  maxSeconds: number
  /** Folder holding the Parakeet model files. Empty = look in Utter's and Orbit's model folders. */
  modelDir: string
  /** auto: clean up with Claude Haiku when an API key is set. off: paste exactly what was heard. */
  polish: 'auto' | 'off'
  /** Anthropic API key for polishing. Empty = use the ANTHROPIC_API_KEY environment variable. */
  anthropicApiKey: string
  /** Give up on polishing after this long and paste the raw text. */
  polishTimeoutMs: number
  /** Start Utter when you sign in to Windows (installed app only). */
  startAtLogin: boolean
}

const DEFAULTS: Settings = {
  hotkey: 'LeftAlt',
  trailingSpace: true,
  restoreClipboard: true,
  maxSeconds: 300,
  modelDir: '',
  polish: 'auto',
  anthropicApiKey: '',
  polishTimeoutMs: 5000,
  startAtLogin: true
}

export const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export let settings: Settings = { ...DEFAULTS }

/** Reads settings.json (creating it with defaults the first time). Returns an error message if it's broken. */
export function loadSettings(): string | undefined {
  const file = settingsPath()
  if (!existsSync(file)) {
    saveSettings()
    return
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
    settings = { ...DEFAULTS, ...raw }
    if (settings.polish !== 'auto' && settings.polish !== 'off') settings.polish = DEFAULTS.polish
    if (!(settings.maxSeconds > 0)) settings.maxSeconds = DEFAULTS.maxSeconds
    if (!(settings.polishTimeoutMs > 0)) settings.polishTimeoutMs = DEFAULTS.polishTimeoutMs
  } catch (err) {
    settings = { ...DEFAULTS }
    return `settings.json couldn't be read, using defaults (${err instanceof Error ? err.message : err})`
  }
}

export function saveSettings(patch: Partial<Settings> = {}): void {
  settings = { ...settings, ...patch }
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n')
}
