import { app } from 'electron'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

// Everything the main process prints also goes to %APPDATA%\Utter\utter.log, because the installed
// app has no console to print to. Bounded: past 1 MB the file becomes utter.old.log (replacing the
// previous one) and a new one starts, so the two together never pass ~2 MB. Checked at start-up and
// every 100 lines while running, since Utter can run for weeks without a restart.

const MAX_BYTES = 1_000_000
const CHECK_EVERY = 100

export const logPath = (): string => join(app.getPath('userData'), 'utter.log')
const oldLogPath = (): string => join(app.getPath('userData'), 'utter.old.log')

function rotateIfBig(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, oldLogPath())
  } catch {
    // a locked file just means one less rotation; the next check tries again
  }
}

export function startFileLog(): void {
  const file = logPath()
  rotateIfBig(file)
  let lines = 0
  const write = (level: string, args: unknown[]): void => {
    try {
      if (++lines % CHECK_EVERY === 0) rotateIfBig(file)
      appendFileSync(file, `${new Date().toLocaleString('sv')} ${level} ${format(...args)}\n`)
    } catch {
      // never let logging break dictation
    }
  }
  for (const [name, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']] as const) {
    const original = console[name].bind(console)
    console[name] = (...args: unknown[]) => {
      original(...args)
      write(level, args)
    }
  }
  console.log(`[utter] started v${app.getVersion()}`)
}

/** What gets logged of a dictation: enough to recognise it, not everything you said. */
export function preview(text: string): string {
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}…` : text) + ` (${text.length} chars)`
}
