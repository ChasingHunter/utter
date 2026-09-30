import { nativeImage, type NativeImage } from 'electron'
import { crc32, deflateSync } from 'node:zlib'

// Tray icons are drawn here instead of shipped as files: a small waveform whose colour shows the state.

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA PNG from a coverage function (0..1 per pixel), supersampled 4x4 for smooth edges. */
function png(size: number, [r, g, b]: [number, number, number], cover: (x: number, y: number) => boolean): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4) // leading 0 = no filter
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (cover((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)) hits++
      row.set([r, g, b, Math.round((hits / 16) * 255)], 1 + x * 4)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Four rounded bars, in unit coordinates.
const BARS = [0.45, 0.8, 1, 0.6].map((h, i) => ({ cx: 0.17 + i * 0.22, h: h * 0.84 }))
const BAR_W = 0.13

function inBars(x: number, y: number): boolean {
  for (const { cx, h } of BARS) {
    const top = 0.5 - h / 2
    const bottom = 0.5 + h / 2
    const r = BAR_W / 2
    if (Math.abs(x - cx) > r) continue
    if (y >= top + r && y <= bottom - r) return true
    const cy = y < top + r ? top + r : bottom - r
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true
  }
  return false
}

export type IconState = 'idle' | 'recording' | 'busy'

const COLORS: Record<IconState, [number, number, number]> = {
  idle: [156, 163, 175],
  recording: [239, 68, 68],
  busy: [245, 158, 11]
}

const cache = new Map<IconState, NativeImage>()

export function trayIcon(state: IconState): NativeImage {
  let img = cache.get(state)
  if (!img) {
    img = nativeImage.createFromBuffer(png(16, COLORS[state], inBars))
    img.addRepresentation({ scaleFactor: 2, buffer: png(32, COLORS[state], inBars) })
    cache.set(state, img)
  }
  return img
}
