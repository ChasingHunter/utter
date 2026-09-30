import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Settings {
  /** Electron accelerator. Needs a non-modifier key (Electron can't bind Ctrl+Win alone). */
  hotkey: string
  /** hold: hold while talking, let go to paste (a quick tap still toggles). toggle: press to start, press again to paste. */
  mode: 'hold' | 'toggle'
  /** Adds a space after each dictation so back-to-back ones don't run together. */
  trailingSpace: boolean
  /** Put back whatever was on the clipboard before we pasted. */
  restoreClipboard: boolean
  /** Recording stops by itself after this long. */
  maxSeconds: number
  /** Folder holding the Parakeet model files. Empty = look in Dictate's and Orbit's model folders. */
  modelDir: string
}

const DEFAULTS: Settings = {
  hotkey: 'Control+Shift+Space',
  mode: 'hold',
  trailingSpace: true,
  restoreClipboard: true,
  maxSeconds: 300,
  modelDir: ''
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
    if (settings.mode !== 'hold' && settings.mode !== 'toggle') settings.mode = DEFAULTS.mode
    if (!(settings.maxSeconds > 0)) settings.maxSeconds = DEFAULTS.maxSeconds
  } catch (err) {
    settings = { ...DEFAULTS }
    return `settings.json couldn't be read, using defaults (${err instanceof Error ? err.message : err})`
  }
}

export function saveSettings(patch: Partial<Settings> = {}): void {
  settings = { ...settings, ...patch }
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n')
}
