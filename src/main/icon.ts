import { nativeImage, type NativeImage } from 'electron'
import { crc32, deflateSync } from 'node:zlib'

// Tray icons are drawn here instead of shipped as files: a mic-ish dot whose colour shows the state.

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Anti-aliased filled circle with a ring, as an RGBA PNG. */
function dotPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const rows: Buffer[] = []
  const c = (size - 1) / 2
  const outer = size / 2 - 0.5
  const inner = outer * 0.55
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4) // leading 0 = no filter
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      // Ring (outer edge .. 80%) plus a solid centre dot, with a 1px soft edge.
      const ring = Math.min(Math.max(outer - d, 0), 1) * Math.min(Math.max(d - outer * 0.78, 0), 1)
      const dot = Math.min(Math.max(inner - d + 0.5, 0), 1)
      const a = Math.max(ring, dot)
      row.set([r, g, b, Math.round(a * 255)], 1 + x * 4)
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

export type IconState = 'idle' | 'recording' | 'busy' | 'error'

const COLORS: Record<IconState, [number, number, number]> = {
  idle: [150, 160, 175],
  recording: [239, 68, 68],
  busy: [245, 158, 11],
  error: [120, 120, 120]
}

const cache = new Map<IconState, NativeImage>()

export function trayIcon(state: IconState): NativeImage {
  let img = cache.get(state)
  if (!img) {
    img = nativeImage.createFromBuffer(dotPng(16, COLORS[state]))
    img.addRepresentation({ scaleFactor: 2, buffer: dotPng(32, COLORS[state]) })
    cache.set(state, img)
  }
  return img
}
