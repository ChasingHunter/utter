import { contextBridge, ipcRenderer } from 'electron'

export type PillCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'status'; state: 'busy' | 'error'; text: string }

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
  }
}

export type PillApi = typeof api

contextBridge.exposeInMainWorld('pill', api)
