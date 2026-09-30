# Utter

Push-to-talk dictation for Windows. Hold Right Alt, talk, let go, and the text gets typed into whatever app you're in: Slack, Word, a browser, a terminal.

Speech-to-text runs on your own CPU with NVIDIA's Parakeet TDT 0.6B v2 through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). No account, no word limit, and your audio never leaves the PC. If you have Claude Code installed, Claude Haiku also tidies the text for the app you're in, using your Claude plan. That's the part that makes it feel like Wispr Flow. English only for now.

I built it as a free, local stand-in for Wispr Flow after running out of Wispr's weekly words.

## Using it

| Do this | What happens |
|---|---|
| Hold Right Alt, talk, let go | The text is pasted where your cursor is |
| Double-tap Right Alt | Hands-free: keep talking, tap Right Alt again to paste |
| Tap Right Alt, or use it with another key | Nothing. It works as usual |
| Esc while recording | Throws it away |

A small black capsule at the bottom of the screen shows what's going on. The bars move with your voice once the mic is on (they sit dim for a moment first), then turn into a travelling pulse while it transcribes.

If there's nowhere to paste (you were on the desktop, or the paste fails), the text goes on your clipboard and a card shows up with a Copy button. The tray menu also has Copy last dictation. Otherwise your clipboard is put back the way it was.

## Polishing with Claude Haiku

Before pasting, Utter can send the transcript to Claude Haiku along with the app name and window title, and paste the cleaned-up version: filler words gone, spoken corrections applied ("before three, no wait, four" becomes "before 4"), punctuation fixed, and the tone matched to the app, casual in Slack and hands-off in a terminal.

It uses your Claude plan through the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) you already have installed, so there's nothing to set up (if you've never used Claude Code, run `claude` once and log in). It adds under a second per dictation and counts toward your plan's usage. Without Claude Code, it can use an Anthropic API key instead (`anthropicApiKey` in settings). If neither works, the raw transcript is pasted. Turn it off from the tray menu.

The transcript, app name and window title go to Anthropic when polishing is on. The audio never does.

## Install

Run `Utter-Setup-<version>.exe` from `dist/` (build it with `npm run dist`). It installs per user and starts with Windows. On first launch it offers to download the speech model (482 MB). If [Orbit](https://github.com/ChasingHunter/orbit) already downloaded it, Utter uses that copy.

Utter has no window. Look for the waveform icon in the tray (it may be behind the `^` arrow).

## Running from source

You need Windows 10 or 11 and Node 22 or newer.

```bash
git clone <this repo> utter
cd utter
npm install
npm start
```

The speech model isn't in the repo. The app downloads it on first launch, or run `npm run model`.

## Settings

Tray icon, then Edit settings, opens `%APPDATA%\Utter\settings.json`. After editing, use Reload settings.

| Key | Default | What it does |
|---|---|---|
| `hotkey` | `RightAlt` | One key on its own (`RightAlt`, `LeftAlt`, `LeftCtrl`, `RightCtrl`, `RightShift`, `CapsLock`, `F13`, `F24`) or a combo like `Control+Shift+Space` |
| `polish` | `auto` | `auto` uses your Claude plan, else an API key, else nothing. `subscription` or `api` forces one. `off` never polishes |
| `anthropicApiKey` | `""` | Key for the API route. Empty means use `ANTHROPIC_API_KEY` |
| `polishTimeoutMs` | `5000` | Paste the raw text if Haiku takes longer than this |
| `trailingSpace` | `true` | Adds a space after each dictation so back-to-back ones don't run together |
| `restoreClipboard` | `true` | Puts your previous clipboard back after pasting |
| `maxSeconds` | `300` | Recording stops by itself after this |
| `startAtLogin` | `true` | Start with Windows (installed app only) |
| `modelDir` | `""` | Use a model folder somewhere else |

## Testing

```bash
npm run bench -- test/fixtures/speech0.wav   # speech-to-text alone: speed and transcript
npm run test:e2e                             # the whole app, with a fake mic playing a WAV
npm run test:hook                            # the keyboard hook
```

None of them paste anything or touch your clipboard. Set `UTTER_FRESH=1` on the e2e test to ignore Orbit's model and test a clean machine.

## Known limits

- Text appears only after you stop talking, usually within a couple of seconds.
- Right Alt does nothing while a window running as administrator is focused. Windows doesn't let normal apps see those keys.
- The Windows microphone indicator flickers on a quick Right Alt tap, because the mic opens as soon as you press it.
- Pasted text shows up in Windows clipboard history (`Win+V`).

## When something doesn't work

Tray icon, then Open log, shows what happened with each press: the key, the mic, the transcription and the paste, so you can see where it stopped.

## License

MIT
