import { contextBridge, ipcRenderer } from 'electron'

export type PillCommand =
  /** Start capturing. The capsule shows once main makes the window visible. */
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  /** Waveform turns into the "working on it" wave. */
  | { type: 'thinking' }
  /** A short line of text in the capsule. */
  | { type: 'message'; tone: 'info' | 'error'; text: string }
  /** The copy card: dictation that had nowhere to go (it's already on the clipboard). */
  | { type: 'card'; text: string; note: string }
  /** Play the exit animation; main hides the window right after. */
  | { type: 'leave' }

const api = {
  onCommand(cb: (cmd: PillCommand) => void): void {
    ipcRenderer.on('pill:cmd', (_e, cmd: PillCommand) => cb(cmd))
  },
  /** Sends the finished recording (16 kHz mono) to main. */
  audio(samples: Float32Array): void {
    ipcRenderer.send('pill:audio', samples)
  },
  /** Mic is open and capturing; `ms` is how long that took. */
  ready(ms: number): void {
    ipcRenderer.send('pill:ready', ms)
  },
  error(message: string): void {
    ipcRenderer.send('pill:error', message)
  },
  /** Copy button on the card. */
  copy(): void {
    ipcRenderer.send('pill:copy')
  },
  /** Pointer is over something clickable, so the window must take mouse input. */
  hover(over: boolean): void {
    ipcRenderer.send('pill:hover', over)
  },
  /** Card timed out or was closed. */
  dismiss(): void {
    ipcRenderer.send('pill:dismiss')
  }
}

export type PillApi = typeof api

contextBridge.exposeInMainWorld('pill', api)
