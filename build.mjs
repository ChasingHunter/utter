// Bundles main, preload and the pill renderer with esbuild. `--watch` rebuilds on change.
import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')
mkdirSync('out', { recursive: true })
copyFileSync('src/renderer/index.html', 'out/index.html')

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Native addons must stay in node_modules next to their DLLs.
  external: ['electron', 'sherpa-onnx-node', 'koffi'],
  logLevel: 'info'
}

const configs = [
  { ...node, entryPoints: ['src/main/index.ts'], outfile: 'out/main.js' },
  { ...node, entryPoints: ['src/preload.ts'], outfile: 'out/preload.js' },
  { bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', entryPoints: ['src/renderer/pill.ts'], outfile: 'out/pill.js', logLevel: 'info' }
]

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch()
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)))
}
