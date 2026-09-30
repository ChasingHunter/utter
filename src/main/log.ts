import { app } from 'electron'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

// Everything the main process prints also goes to %APPDATA%\Utter\utter.log, because the installed
// app has no console to print to. Kept under ~1 MB: the previous file is renamed to utter.old.log.

const MAX_BYTES = 1_000_000

export const logPath = (): string => join(app.getPath('userData'), 'utter.log')

export function startFileLog(): void {
  const file = logPath()
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(app.getPath('userData'), 'utter.old.log'))
  } catch {
    // a locked or missing file just means one less rotation
  }
  const write = (level: string, args: unknown[]): void => {
    try {
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
