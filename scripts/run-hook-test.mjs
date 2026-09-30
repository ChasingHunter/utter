// Launches the bundled hook test in Electron with injected keys counted as real.
import { spawnSync } from 'node:child_process'
import electron from 'electron'

const r = spawnSync(electron, ['out/hook-test.js'], { stdio: 'inherit', env: { ...process.env, UTTER_HOOK_TEST: '1' } })
process.exit(r.status ?? 1)
