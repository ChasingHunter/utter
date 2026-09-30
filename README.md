# Utter

Push-to-talk dictation for Windows. Hold Left Alt, talk, let go, and the text gets typed into whatever app you're in: Slack, Word, a browser, a terminal.

Speech-to-text runs on your own CPU with NVIDIA's Parakeet TDT 0.6B v2 (int8) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). No account, no word limit, and your audio never leaves the PC. If you add an Anthropic API key, Claude Haiku also tidies the text for the app you're in, which is the part that makes it feel like Wispr Flow. English only for now.

I built it as a free, local stand-in for Wispr Flow after running out of Wispr's weekly words.

## Using it

| Do this | What happens |
|---|---|
| Hold Left Alt, talk, let go | The text is pasted where your cursor is |
| Double-tap Left Alt | Hands-free: keep talking, tap Left Alt again to paste |
| Tap Left Alt, or Alt+Tab, Alt+F4 | Nothing new. Normal Alt shortcuts keep working |
| Esc while recording | Throws it away |

A small black capsule at the bottom of the screen shows what's going on. Bars move with your voice while it's listening (they sit dim for a moment while the mic opens), then turn into a travelling pulse while it transcribes.

If there's nowhere to type (you were on the desktop or the taskbar), the text goes on your clipboard and a card shows up with a Copy button. The tray menu also has Copy last dictation, for when a paste lands somewhere you didn't mean.

Normally your clipboard is put back the way it was after pasting.

## Polishing with Claude Haiku

Out of the box Utter pastes exactly what it heard. With an API key it sends the transcript to Claude Haiku 4.5 first, along with the app name and window title, and pastes the cleaned-up version:

- filler words and false starts go ("um, so, like")
- spoken corrections are applied ("at 3, no wait, 4" becomes "at 4")
- punctuation and lists get fixed
- tone follows the app: casual in Slack, full sentences in email, hands-off in a terminal or code editor

Put your key in settings (`anthropicApiKey`) or set `ANTHROPIC_API_KEY`. It adds about half a second and costs roughly a dollar per thousand dictations. If the call fails or takes longer than 5 seconds, the raw text is pasted instead. Turn it off from the tray menu.

The transcript, app name and window title go to Anthropic's API when polishing is on. The audio never does.

## Install

Run `Utter-Setup-0.2.0.exe` from `dist/`. It installs per user (no admin), adds a Start menu entry, and starts with Windows by default (tray menu, Start with Windows). On first launch it offers to download the speech model (482 MB) into `%APPDATA%\Utter\models`. If [Orbit](https://github.com/ChasingHunter/orbit) already downloaded it, Utter uses that copy.

Utter has no window. Look for the waveform icon in the tray (it may be behind the `^` arrow). A green "Ready" message shows at the bottom of the screen when it starts.

## Settings

Tray icon, then Edit settings, opens `%APPDATA%\Utter\settings.json`. After editing, use Reload settings.

| Key | Default | What it does |
|---|---|---|
| `hotkey` | `LeftAlt` | One key on its own (`LeftAlt`, `RightAlt`, `LeftCtrl`, `RightCtrl`, `RightShift`, `CapsLock`, `F13`, `F24`) or a combo like `Control+Shift+Space` |
| `polish` | `auto` | `auto` polishes when there's an API key, `off` never does |
| `anthropicApiKey` | `""` | Key for polishing. Empty means use `ANTHROPIC_API_KEY` |
| `polishTimeoutMs` | `5000` | Paste the raw text if Haiku takes longer than this |
| `trailingSpace` | `true` | Adds a space after each dictation so back-to-back ones don't run together |
| `restoreClipboard` | `true` | Puts your previous clipboard back after pasting |
| `maxSeconds` | `300` | Recording stops by itself after this |
| `startAtLogin` | `true` | Start with Windows (installed app only) |
| `modelDir` | `""` | Use a model folder somewhere else |

## Running from source

```bash
npm install
node node_modules/electron/install.js   # only if npm skipped the Electron download
npm start                               # runs until you quit it from the tray
npm run dist                            # builds dist/Utter-Setup-<version>.exe
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

The full app, with Chromium's fake mic playing a WAV (screenshots of the pill go to `out/e2e/`):

```bash
npm run test:e2e              # or: npm run test:e2e -- me.wav
```

The keyboard hook, using F23/F24 so nothing else reacts:

```bash
npm run test:hook
```

None of the tests paste anything or touch your clipboard, since they run on your real desktop.

## How the Alt key works

Electron can't bind a lone modifier, so Utter installs a low-level keyboard hook (`src/main/keyhook.ts`). It only watches; every key still reaches your apps. Recording starts the moment Left Alt goes down, so your first word isn't lost, but the capsule only shows once you've held it for 250 ms. If you press another key first (Alt+Tab), the recording is thrown away. At the 250 ms mark Utter sends an unused key code (0xE8), so that letting go of Alt doesn't open the menu bar in the app you're typing in.

One side effect: the Windows microphone indicator flickers briefly on Alt+Tab, because the mic opens on every Alt press.

## Known limits

- No text appears until you stop talking. Parakeet transcribes the whole clip at the end: 1.3 to 3.3 seconds for 6 seconds of speech on an i5-10th gen, depending on what else is running. Polish adds about 0.5 seconds.
- "Nowhere to type" only catches the desktop and taskbar. A paste into an app with no text box focused just does nothing, so use Copy last dictation from the tray.
- The first dictation after launch can take up to a second for the mic to open. After that it's usually under 250 ms.
- Pasted text shows up in Windows clipboard history (`Win+V`).

## License

MIT
