import type { PillApi } from '../preload'
import { Recorder } from './recorder'

declare global {
  interface Window {
    pill: PillApi
  }
}

const pill = document.getElementById('pill')!
const label = document.getElementById('label')!
const time = document.getElementById('time')!
const barsEl = document.getElementById('bars')!
const BAR_COUNT = 12
const bars = Array.from({ length: BAR_COUNT }, () => barsEl.appendChild(document.createElement('span')))
const history: number[] = Array(BAR_COUNT).fill(0)

const recorder = new Recorder()
let startedAt = 0
let frame = 0

function setState(state: 'opening' | 'recording' | 'busy' | 'error' | 'info', text: string): void {
  pill.className = state
  label.textContent = text
  if (state !== 'recording') time.textContent = ''
}

function tick(): void {
  history.shift()
  history.push(recorder.level)
  bars.forEach((b, i) => (b.style.height = `${3 + Math.round(history[i] * 17)}px`))
  const s = Math.floor((Date.now() - startedAt) / 1000)
  time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  frame = requestAnimationFrame(tick)
}

async function start(): Promise<void> {
  history.fill(0)
  // Grey dot until the mic is really capturing, so it's clear when to start talking.
  setState('opening', 'Opening mic…')
  startedAt = Date.now()
  try {
    await Promise.race([
      recorder.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mic took over 5 s to open')), 5000))
    ])
    window.pill.ready(Date.now() - startedAt)
    setState('recording', '')
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(tick)
  } catch (err) {
    window.pill.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  }
}

async function stop(send: boolean): Promise<void> {
  cancelAnimationFrame(frame)
  const samples = await recorder.stop()
  if (send) {
    setState('busy', 'Transcribing…')
    window.pill.audio(samples)
  }
}

recorder.warm().catch((err) => console.warn('mic warm-up failed', err))

window.pill.onCommand((cmd) => {
  if (cmd.type === 'start') void start()
  else if (cmd.type === 'stop') void stop(true)
  else if (cmd.type === 'cancel') void stop(false)
  else setState(cmd.state, cmd.text)
})
