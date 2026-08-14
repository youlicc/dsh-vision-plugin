// Browser half of the dsh-vision-plugin: paste-to-path.
//
// A capture-phase paste listener runs before the composer's own handler.
// When the clipboard carries image files and the host verdict says the
// currently selected model is text-only, the default intake (attachment ->
// host image admission -> "model does not support images" for text-only
// models) is suppressed; the bytes go to the plugin's host route
// (POST /vision-plugin/paste), land as a private temp file, and the returned
// path is inserted into the composer as plain text. A text-only model then
// sees exactly what Pi, OpenCode, and Claude Code hand their models: a file
// path, which is also the describe_image tool's primary trigger.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-vision-plugin',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/vision-plugin/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/select model|current model|选择模型|当前模型/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET
    // /vision-plugin/paste with the selector label; the host resolves it
    // against real model metadata). Until a label has a cached `true`,
    // pastes stay native — the safe direction for both a vision model (keeps
    // its thumbnail) and a text-only one (keeps only its old error message,
    // once). A 404 means the route is off, so the client stands down
    // entirely instead of swallowing pastes into a dead endpoint.
    var routeAvailable = true
    var verdicts = {}
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
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
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      if (!routeAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = verdicts[label]
      refreshVerdict(label)
      // No fresh confirmed host verdict: leave the paste native. Wrong only
      // for a text-only model's very first paste, and self-correcting.
      if (!cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      var target = event.target
      Promise.all(files.map(uploadOne))
        .then((results) => {
          var text = results
            .map((r) => r.path)
            .filter(Boolean)
            .join(' ')
          if (text) insertText(target, `${text} `)
        })
        .catch((error) => {
          if (error && error.status === 404) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[dsh-vision-plugin] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
    }

    function apply() {
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('paste', onPaste, true)
      return () => {
        document.removeEventListener('focusin', onFocusIn, true)
        document.removeEventListener('paste', onPaste, true)
      }
    }

    exports.apply = apply
    return module.exports
  },
})
