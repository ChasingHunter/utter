// Draws build/icon.png (512 px): white waveform on a black rounded square. Used by the installer and the exe.
// Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const SIZE = 512
const SS = 3 // supersampling per axis

const BARS = [0.28, 0.5, 0.7, 0.42, 0.22].map((h, i) => ({ cx: 0.26 + i * 0.12, h }))
const BAR_W = 0.07

function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Returns [r, g, b, a] for one point in unit coordinates. */
function paint(x, y) {
  if (!roundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) return [0, 0, 0, 0]
  for (const { cx, h } of BARS) {
    if (roundRect(x, y, cx - BAR_W / 2, 0.5 - h / 2, cx + BAR_W / 2, 0.5 + h / 2, BAR_W / 2)) return [245, 245, 244, 255]
  }
  return [12, 12, 14, 255]
}

const rows = []
for (let py = 0; py < SIZE; py++) {
  const row = Buffer.alloc(1 + SIZE * 4)
  for (let px = 0; px < SIZE; px++) {
    const acc = [0, 0, 0, 0]
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const [r, g, b, a] = paint((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE)
        acc[0] += r * a
        acc[1] += g * a
        acc[2] += b * a
        acc[3] += a
      }
    const a = acc[3] / (SS * SS)
    const k = acc[3] || 1
    row.set([Math.round(acc[0] / k), Math.round(acc[1] / k), Math.round(acc[2] / k), Math.round(a)], 1 + px * 4)
  }
  rows.push(row)
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr.set([8, 6, 0, 0, 0], 8)
mkdirSync('build', { recursive: true })
writeFileSync(
  'build/icon.png',
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
)
console.log('wrote build/icon.png')
