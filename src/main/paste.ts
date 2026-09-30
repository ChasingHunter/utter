import { clipboard, ClipboardItem } from 'electron'
import { focusWindow, foregroundWindow, sameWindow, sendKeys, VK, waitForModifiersReleased, type Hwnd } from './win32'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Copies whatever it can of the current clipboard so it can be restored later.
 * Formats Chromium can't read are skipped, and an item with nothing readable is dropped
 * (an empty ClipboardItem throws "at least one MIME type is required"). Never throws:
 * losing the old clipboard is better than losing the dictation.
 */
async function snapshotClipboard(): Promise<ClipboardItem[]> {
  try {
    const items = await clipboard.read()
    const saved: ClipboardItem[] = []
    for (const item of items) {
      const data: Record<string, Blob | string> = {}
      for (const type of item.types) {
        const value = await item.getType(type).catch(() => undefined)
        if (value instanceof Blob || typeof value === 'string') data[type] = value
      }
      if (Object.keys(data).length) saved.push(new ClipboardItem(data))
    }
    return saved
  } catch (err) {
    console.warn('[paste] could not save the clipboard, it will not be restored:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Types `text` into `target` by pasting it, then puts the user's clipboard back if it could be saved.
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
  if (saved.length) {
    await clipboard.write(saved).catch((err) => console.warn('[paste] could not restore the clipboard:', err instanceof Error ? err.message : err))
  }
}
