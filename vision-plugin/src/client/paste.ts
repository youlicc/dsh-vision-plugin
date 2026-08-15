/**
 * Paste-to-path interception, browser half. A capture-phase paste listener
 * runs before the composer's own handler: when the clipboard carries image
 * files and the host verdict says the currently selected model is text-only,
 * the default intake (attachment -> host image admission -> "model does not
 * support images") is suppressed; the bytes go to the plugin's host route
 * (POST /vision-plugin/paste), land as a private temp file, and the returned
 * path is inserted into the composer as plain text. A text-only model then
 * sees exactly what Pi, OpenCode, and Claude Code hand their models: a file
 * path, which is also the describe_image tool's primary trigger.
 * @module @dsh-external/dsh-vision-plugin/client/paste
 */

/** Paste temp paths live for a while; only a fresh verdict counts. */
const VERDICT_MAX_AGE_MS = 60_000

interface VerdictEntry {
  pending: boolean
  takeover: boolean
  at: number
}

/** Extract the image files from a clipboard event, if any. */
function imageFilesOf(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items
  if (items === undefined) return []
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined || item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null && /^image\//.test(file.type)) files.push(file)
  }
  return files
}

/** Insert text into the composer target (or the focused input), firing the input event. */
function insertText(target: EventTarget | null, text: string): void {
  const el = target !== null && (target as HTMLElement).tagName === 'TEXTAREA'
    ? target as HTMLTextAreaElement
    : target !== null && (target as HTMLElement).tagName === 'INPUT'
      ? target as HTMLInputElement
      : document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
  if (el === null || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
  el.focus()
  // execCommand fires the input event React's controlled textarea needs; the
  // prototype-setter dance is the fallback for engines dropping it.
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch {
    inserted = false
  }
  if (!inserted) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter === undefined) return
    setter.call(el, el.value + text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Upload one image file to the paste endpoint; resolves to its temp path. */
async function uploadOne(file: File): Promise<{ path: string }> {
  const buffer = await file.arrayBuffer()
  const res = await fetch('/vision-plugin/paste', { method: 'POST', body: buffer })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    const error = new Error(body.error ?? `paste upload failed (${res.status})`) as Error & { status?: number }
    error.status = res.status
    throw error
  }
  return res.json() as Promise<{ path: string }>
}

/** The model-selector label the paste verdict resolves against. */
function currentModelLabel(): string {
  const buttons = document.querySelectorAll('button[aria-label]')
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i]
    const label = button?.getAttribute('aria-label') ?? ''
    if (/select model|current model|选择模型|当前模型/i.test(label)) return label
  }
  return ''
}

/**
 * Install the paste interception. Whether to take a paste over is the HOST's
 * call (GET /vision-plugin/paste with the selector label; the host resolves
 * it against real model metadata). Until a label has a cached `true`, pastes
 * stay native — the safe direction for both a vision model (keeps its
 * thumbnail) and a text-only one (keeps only its old error message, once). A
 * 404 means the route is off, so the client stands down entirely instead of
 * swallowing pastes into a dead endpoint.
 * @returns the disposer removing both capture listeners.
 */
export function installPasteInterception(): () => void {
  let routeAvailable = true
  const verdicts = new Map<string, VerdictEntry>()

  function refreshVerdict(label: string): void {
    if (!routeAvailable) return
    const cached = verdicts.get(label)
    if (cached?.pending) return
    const entry: VerdictEntry = { pending: true, takeover: cached?.takeover ?? false, at: cached?.at ?? 0 }
    verdicts.set(label, entry)
    fetch(`/vision-plugin/paste?model=${encodeURIComponent(label)}`)
      .then((res) => {
        if (res.status === 404) {
          routeAvailable = false
          entry.pending = false
          return null
        }
        if (!res.ok) throw new Error(`policy ${res.status}`)
        return res.json()
      })
      .then((body: { takeover?: boolean } | null) => {
        entry.pending = false
        if (body !== null) {
          entry.takeover = body.takeover === true
          entry.at = Date.now()
        }
      })
      .catch(() => { entry.pending = false })
  }

  // A paste needs the composer focused first, so a focus-time prefetch has
  // the verdict ready before the first paste can land.
  function onFocusIn(): void {
    refreshVerdict(currentModelLabel())
  }

  function onPaste(event: ClipboardEvent): void {
    if (!routeAvailable) return
    const files = imageFilesOf(event)
    if (files.length === 0) return
    const label = currentModelLabel()
    const cached = verdicts.get(label)
    refreshVerdict(label)
    // No fresh confirmed host verdict: leave the paste native. Wrong only
    // for a text-only model's very first paste, and self-correcting.
    if (cached === undefined || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return
    // Take the paste before the composer's intake starts an attachment (and
    // with it the host-side image admission a text-only model fails).
    event.preventDefault()
    event.stopImmediatePropagation()
    const target = event.target
    Promise.all(files.map(uploadOne))
      .then((results) => {
        const text = results.map((r) => r.path).filter(Boolean).join(' ')
        if (text !== '') insertText(target, `${text} `)
      })
      .catch((error: Error & { status?: number }) => {
        if (error.status === 404) {
          routeAvailable = false
          verdicts.clear()
        }
        console.error(`[dsh-vision-plugin] paste-to-path failed: ${error.message}`)
      })
  }

  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('paste', onPaste, true)
  return () => {
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('paste', onPaste, true)
  }
}
