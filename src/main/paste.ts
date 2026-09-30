import { clipboard, ClipboardItem } from 'electron'
import { focusWindow, foregroundWindow, sameWindow, sendKeys, VK, waitForModifiersReleased, type Hwnd } from './win32'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Copies every format currently on the clipboard so it can be restored later. */
async function snapshotClipboard(): Promise<ClipboardItem[]> {
  const items = await clipboard.read().catch(() => [])
  return Promise.all(
    items.map(async (item) => {
      const data: Record<string, Blob | string> = {}
      for (const type of item.types) {
        const value = await item.getType(type).catch(() => undefined)
        if (value instanceof Blob || typeof value === 'string') data[type] = value
      }
      return new ClipboardItem(data)
    })
  )
}

/**
 * Types `text` into `target` by pasting it, then puts the user's clipboard (all formats) back.
 * The pill never takes focus, so the target is normally still in front.
 */
export async function pasteInto(target: Hwnd, text: string, restore: boolean): Promise<void> {
  // A held Ctrl+Shift would turn our Ctrl+V into Ctrl+Shift+V.
  await waitForModifiersReleased()
  const saved = restore ? await snapshotClipboard() : []
  await clipboard.writeText(text)
  if (!sameWindow(foregroundWindow(), target)) {
    focusWindow(target)
    await sleep(80)
  }
  sendKeys([VK.CONTROL, VK.V], false)
  sendKeys([VK.CONTROL, VK.V], true)
  // Give the app time to read the clipboard before we swap it back.
  await sleep(400)
  if (saved.length) await clipboard.write(saved).catch(() => {})
}
