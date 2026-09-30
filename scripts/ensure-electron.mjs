// Runs after `npm install`. npm sometimes skips Electron's own binary download
// (then `npm start` fails with "Electron failed to install correctly"), so fetch it if it's missing.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const dir = join('node_modules', 'electron')
if (existsSync(dir) && !existsSync(join(dir, 'dist', 'electron.exe')) && !existsSync(join(dir, 'dist', 'electron'))) {
  console.log('Electron binary missing, downloading it…')
  const r = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
