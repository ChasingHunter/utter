# Dictate

Offline push-to-talk dictation for Windows. Hold a hotkey, talk, let go, and the text gets typed into whatever app you're in: Slack, Word, a browser, a terminal.

It runs NVIDIA's Parakeet TDT 0.6B v2 (int8) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on your CPU. No account, no word limit, and your audio never leaves the PC. English only for now.

I built it as a free, local stand-in for Wispr Flow after running out of Wispr's weekly words.

## Using it

Hold `Ctrl+Shift+Space`, talk, let go. A small pill at the bottom of the screen shows what's happening:

- grey dot: mic is opening, wait a beat
- red dot with a level meter: recording
- amber dot: transcribing

A quick tap starts recording and leaves it running; tap again to paste. `Esc` cancels while recording. The tray menu switches between hold-to-talk and press-to-start/press-to-stop.

The text is pasted via the clipboard, and whatever you had on the clipboard is put back afterwards.

## Settings

Tray icon → Edit settings opens `%APPDATA%\Dictate\settings.json`. After editing, use Reload settings.

| Key | Default | What it does |
|---|---|---|
| `hotkey` | `Control+Shift+Space` | Any [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator). Needs a non-modifier key. |
| `mode` | `hold` | `hold` or `toggle` |
| `trailingSpace` | `true` | Adds a space after each dictation so back-to-back ones don't run together |
| `restoreClipboard` | `true` | Puts your previous clipboard back after pasting |
| `maxSeconds` | `300` | Recording stops by itself after this |
| `modelDir` | `""` | Use a model folder somewhere else |

## Speech model

On first run it offers to download the model (482 MB) into `%APPDATA%\Dictate\models`. If [Orbit](https://github.com/ChasingHunter/orbit) already downloaded it, Dictate uses that copy instead.

## Running from source

```bash
npm install
node node_modules/electron/install.js   # only if npm skipped the Electron download
npm start
```

## Testing

Speech-to-text alone, no app, no mic:

```bash
npm run bench -- test/fixtures/speech0.wav your-recording.wav
```

It prints load time, decode time, real-time factor and the transcript. To record your own clip:

```bash
ffmpeg -f dshow -list_devices true -i dummy
ffmpeg -f dshow -i audio="Microphone (your mic)" -ar 16000 -ac 1 -t 10 me.wav
```

The full app, with Chromium's fake mic playing a WAV:

```bash
npm run test:e2e              # or: npm run test:e2e -- me.wav
```

This covers record, transcribe, cancel and an instant tap. It never pastes, since it runs on your real desktop.

## Known limits

- No text appears until you stop talking. Parakeet is an offline model, so it transcribes the whole clip at the end. On an i5-10th gen that's roughly 0.15 to 0.45 seconds per second of speech, depending on what else is running.
- The first dictation after launch can take up to a second for the mic to open. After that it's usually under 250 ms.
- Modifier-only hotkeys like Wispr's `Ctrl+Win` aren't supported yet. Electron can't register them, and doing it properly needs a low-level keyboard hook.
- Pasted text shows up in Windows clipboard history (`Win+V`).

## License

MIT
