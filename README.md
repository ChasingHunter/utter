# Utter

Push-to-talk dictation for Windows. Hold Left Alt, talk, let go, and the text gets typed into whatever app you're in: Slack, Word, a browser, a terminal.

Speech-to-text runs on your own CPU with NVIDIA's Parakeet TDT 0.6B v2 (int8) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). No account, no word limit, and your audio never leaves the PC. If you have Claude Code installed, Claude Haiku also tidies the text for the app you're in, using your Claude plan. That's the part that makes it feel like Wispr Flow. English only for now.

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

Utter can send the transcript to Claude Haiku before pasting, along with the app name and window title, and paste the cleaned-up version:

- filler words and false starts go ("um, so, like")
- spoken corrections are applied ("before three, no wait, four" becomes "before 4")
- punctuation and lists get fixed
- tone follows the app: casual in Slack, full sentences in email, hands-off in a terminal or code editor

It reaches Haiku one of two ways, picked automatically:

1. Your Claude plan, through the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) you already have installed. Nothing to configure in Utter, but Claude Code has to be logged in: if you've never used it, run `claude` once in a terminal and follow the login. The first clean-up takes about 1.5 seconds (Claude Code starting up, which begins the moment you press Alt, so most of it overlaps your talking), then about 0.8 seconds each. Claude Code quits after 10 idle minutes. This uses your plan's normal usage limits, under Anthropic's terms for it.
2. An API key, if Claude Code isn't installed: put it in settings (`anthropicApiKey`) or set `ANTHROPIC_API_KEY`. About 0.5 seconds, roughly a dollar per thousand dictations.

If neither is available, or a call fails or takes longer than 5 seconds, the raw transcript is pasted. Turn polishing off from the tray menu.

The transcript, app name and window title go to Anthropic when polishing is on. The audio never does.

## Install

Run `Utter-Setup-<version>.exe` (build it with `npm run dist`, it lands in `dist/`). It installs per user (no admin), adds a Start menu entry, and starts with Windows by default (tray menu, Start with Windows). On first launch it offers to download the speech model (482 MB) into `%APPDATA%\Utter\models`. If [Orbit](https://github.com/ChasingHunter/orbit) already downloaded it, Utter uses that copy.

Utter has no window. Look for the waveform icon in the tray (it may be behind the `^` arrow). A green "Ready" message shows at the bottom of the screen when it starts.

## Running from a fresh clone

You need Windows 10 or 11 and Node 22 or newer. Claude Code is optional (for polishing).

```bash
git clone <this repo> utter
cd utter
npm install        # also fetches Electron's binary if npm skipped it
npm start          # first launch offers the 482 MB model download
```

`npm start` keeps running until you quit Utter from the tray. `npm run dist` builds the installer.

What lives where, so the repo stays small:

| Thing | Where it comes from | In git? |
|---|---|---|
| Source, lockfile, two short test WAVs | the repo | yes |
| `node_modules/` | `npm install` | no |
| `out/` (bundled app), `dist/` (installer), `build/icon.png` | `npm start` / `npm run dist` generate them | no |
| Speech model (482 MB) | downloaded on first launch, or `npm run model` | no, it's too big and has its own release on GitHub |
| Settings | `%APPDATA%\Utter\settings.json`, created on first launch | no |

## Settings

Tray icon, then Edit settings, opens `%APPDATA%\Utter\settings.json`. After editing, use Reload settings.

| Key | Default | What it does |
|---|---|---|
| `hotkey` | `LeftAlt` | One key on its own (`LeftAlt`, `RightAlt`, `LeftCtrl`, `RightCtrl`, `RightShift`, `CapsLock`, `F13`, `F24`) or a combo like `Control+Shift+Space` |
| `polish` | `auto` | `auto` uses your Claude plan, else an API key, else nothing. `subscription` or `api` forces one. `off` never polishes |
| `anthropicApiKey` | `""` | Key for the API route. Empty means use `ANTHROPIC_API_KEY` |
| `polishTimeoutMs` | `5000` | Paste the raw text if Haiku takes longer than this |
| `trailingSpace` | `true` | Adds a space after each dictation so back-to-back ones don't run together |
| `restoreClipboard` | `true` | Puts your previous clipboard back after pasting |
| `maxSeconds` | `300` | Recording stops by itself after this |
| `startAtLogin` | `true` | Start with Windows (installed app only) |
| `modelDir` | `""` | Use a model folder somewhere else |

## Testing

Speech-to-text alone, no app, no mic (run `npm run model` first on a new machine):

```bash
npm run bench -- test/fixtures/speech0.wav your-recording.wav
```

It prints load time, decode time, real-time factor and the transcript. To record your own clip:

```bash
ffmpeg -f dshow -list_devices true -i dummy
ffmpeg -f dshow -i audio="Microphone (your mic)" -ar 16000 -ac 1 -t 10 me.wav
```

The full app, with Chromium's fake mic playing a WAV (screenshots of the pill go to `out/e2e/`). It downloads the model first if there isn't one, and makes two small Haiku calls if Claude Code is installed:

```bash
npm run test:e2e              # or: npm run test:e2e -- me.wav
```

Set `UTTER_FRESH=1` to ignore Orbit's copy of the model and test a clean machine.

The keyboard hook, using F23/F24 so nothing else reacts:

```bash
npm run test:hook
```

None of the tests paste anything or touch your clipboard, since they run on your real desktop.

## How the Alt key works

Electron can't bind a lone modifier, so Utter installs a low-level keyboard hook (`src/main/keyhook.ts`). It only watches; every key still reaches your apps. Recording starts the moment Left Alt goes down, so your first word isn't lost, but the capsule only shows once you've held it for 250 ms. If you press another key first (Alt+Tab), the recording is thrown away. At the 250 ms mark Utter sends an unused key code (0xE8), so that letting go of Alt doesn't open the menu bar in the app you're typing in.

One side effect: the Windows microphone indicator flickers briefly on Alt+Tab, because the mic opens on every Alt press.

## Known limits

- No text appears until you stop talking. Parakeet transcribes the whole clip at the end: 0.5 to 3.3 seconds for 4 to 7 seconds of speech on an i5-10th gen, depending on what else is running. Polish adds about 0.8 seconds.
- "Nowhere to type" only catches the desktop and taskbar. A paste into an app with no text box focused just does nothing, so use Copy last dictation from the tray.
- The first dictation after launch can take up to a second for the mic to open. After that it's usually under 250 ms.
- Pasted text shows up in Windows clipboard history (`Win+V`).

## License

MIT
