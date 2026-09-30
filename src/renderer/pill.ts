import type { PillApi, PillCommand } from '../preload'
import { Recorder } from './recorder'

declare global {
  interface Window {
    pill: PillApi
  }
}

const $ = (id: string): HTMLElement => document.getElementById(id)!
const pill = $('pill')
const msg = $('msg')
const card = $('card')
const canvas = $('wave') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

const recorder = new Recorder()

// ---- waveform -------------------------------------------------------------

type Mode = 'opening' | 'live' | 'thinking'
let mode: Mode = 'opening'
let frame = 0

const BARS = 21
const GAP = 5 // px between bar centres
const BAR_W = 2.5
const MIN_H = 2.5
const heights = new Float32Array(BARS).fill(MIN_H)

function sizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1
  const { width, height } = canvas.getBoundingClientRect()
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function draw(t: number): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  const max = h
  const level = mode === 'live' ? recorder.level() : 0
  const x0 = (w - (BARS - 1) * GAP) / 2
  const c = (BARS - 1) / 2
  const s = t / 1000
  for (let i = 0; i < BARS; i++) {
    let target: number
    let alpha = 0.95
    if (mode === 'live') {
      // Taller in the middle, each bar wobbling on its own so it reads as a voice, not a meter.
      const envelope = Math.exp(-(((i - c) / (BARS * 0.3)) ** 2))
      const wobble = 0.55 + 0.45 * Math.sin(s * 7.3 + i * 1.9) * Math.cos(s * 4.1 + i * 0.7)
      target = MIN_H + (max - MIN_H) * level * envelope * wobble
    } else if (mode === 'thinking') {
      // A soft pulse that travels left to right.
      const p = Math.max(0, Math.sin(s * 7 - i * 0.45))
      target = MIN_H + 5 * p * p
      alpha = 0.45 + 0.5 * p
    } else {
      target = MIN_H
      alpha = 0.35
    }
    heights[i] += (target - heights[i]) * (target > heights[i] ? 0.45 : 0.2)
    const bh = Math.max(MIN_H, heights[i])
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#f5f5f4'
    ctx.beginPath()
    ctx.roundRect(x0 + i * GAP - BAR_W / 2, (h - bh) / 2, BAR_W, bh, BAR_W / 2)
    ctx.fill()
  }
  frame = requestAnimationFrame(draw)
}

function animate(on: boolean): void {
  cancelAnimationFrame(frame)
  if (on) frame = requestAnimationFrame(draw)
}

// ---- showing and hiding ---------------------------------------------------

/** Adds `on` a frame later so the enter transition actually plays. */
function enter(el: HTMLElement): void {
  if (el.classList.contains('on')) return
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')))
}

function showWave(m: Mode): void {
  mode = m
  pill.className = pill.classList.contains('on') ? 'on' : ''
  hideCard()
  sizeCanvas()
  animate(true)
  enter(pill)
}

function showMessage(tone: 'info' | 'error', text: string): void {
  animate(false)
  msg.textContent = text
  pill.className = `text ${tone}${pill.classList.contains('on') ? ' on' : ''}`
  hideCard()
  enter(pill)
}

// ---- the copy card --------------------------------------------------------

let cardTimer: number | undefined
let hovering = false

function showCard(text: string, note: string): void {
  animate(false)
  pill.classList.remove('on')
  $('text').textContent = text
  $('note').textContent = note
  $('copy').textContent = 'Copy'
  card.classList.add('shown')
  enter(card)
  armCardTimer()
}

function hideCard(): void {
  clearTimeout(cardTimer)
  card.classList.remove('on', 'shown')
  if (hovering) setHover(false)
}

function armCardTimer(): void {
  clearTimeout(cardTimer)
  cardTimer = window.setTimeout(() => !hovering && window.pill.dismiss(), 8000)
}

function setHover(over: boolean): void {
  hovering = over
  window.pill.hover(over)
  if (!over && card.classList.contains('shown')) armCardTimer()
}

card.addEventListener('mouseenter', () => setHover(true))
card.addEventListener('mouseleave', () => setHover(false))
$('copy').addEventListener('click', () => {
  window.pill.copy()
  $('copy').textContent = 'Copied'
  setTimeout(() => window.pill.dismiss(), 900)
})
$('close').addEventListener('click', () => window.pill.dismiss())

// ---- recording ------------------------------------------------------------

async function start(): Promise<void> {
  // Dim bars until the mic is really capturing, so it's clear when to start talking.
  showWave('opening')
  const t0 = Date.now()
  try {
    await Promise.race([
      recorder.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mic took over 5 s to open')), 5000))
    ])
    window.pill.ready(Date.now() - t0)
    if (mode === 'opening') mode = 'live'
  } catch (err) {
    window.pill.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  }
}

async function stop(send: boolean): Promise<void> {
  if (send) mode = 'thinking'
  const samples = await recorder.stop()
  if (send) window.pill.audio(samples)
}

recorder.warm().catch((err) => console.warn('mic warm-up failed', err))

window.pill.onCommand((cmd: PillCommand) => {
  switch (cmd.type) {
    case 'start':
      void start()
      break
    case 'stop':
      void stop(true)
      break
    case 'cancel':
      void stop(false)
      break
    case 'thinking':
      showWave('thinking')
      break
    case 'message':
      showMessage(cmd.tone, cmd.text)
      break
    case 'card':
      showCard(cmd.text, cmd.note)
      break
    case 'leave':
      animate(false)
      pill.classList.remove('on')
      card.classList.remove('on')
      clearTimeout(cardTimer)
      break
  }
})
