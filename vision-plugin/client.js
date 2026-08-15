// Browser half of the dsh-vision-plugin: paste-to-path + the composer
// vision-model menu.
//
// Paste interception: a capture-phase paste listener runs before the
// composer's own handler. When the clipboard carries image files and the
// host verdict says the currently selected model is text-only, the default
// intake (attachment -> host image admission -> "model does not support
// images" for text-only models) is suppressed; the bytes go to the plugin's
// host route (POST /vision-plugin/paste), land as a private temp file, and
// the returned path is inserted into the composer as plain text. A text-only
// model then sees exactly what Pi, OpenCode, and Claude Code hand their
// models: a file path, which is also the describe_image tool's primary
// trigger.
//
// Vision-model menu: a "视觉：<模型>" button registered into the composer's
// `conversation.input.right` tool-row seat (right end, before the send
// button — the same mechanism the model select uses for its own seat). The
// dropdown lists the offered free vision models grouped by provider, from
// GET /vision-plugin/vision-models (the plugin-maintained FREE_VISION_MODELS
// catalog intersected with the configured llm topology); clicking a row
// POSTs /vision-plugin/vision-model and re-reads the selection. Hidden
// entirely when no configured provider offers a free vision model.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages beyond the platform seed words (react).
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-vision-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback
    var h = React.createElement

    // ---- paste-to-path -------------------------------------------------

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

    function installPaste() {
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('paste', onPaste, true)
      return () => {
        document.removeEventListener('focusin', onFocusIn, true)
        document.removeEventListener('paste', onPaste, true)
      }
    }

    // ---- vision-model menu ----------------------------------------------

    // Menu surface tokens mirror the shipped Menu primitive (ui-primitives)
    // and the model select's dropdown so every composer popup reads as the
    // same material; the panel opens UPWARD from the tool row.
    var menuStyles = {
      root: { position: 'relative', display: 'inline-flex', flex: 'none', minWidth: 0 },
      // Layout and type ALL live in the .dsh-vision-trigger class (see
      // MENU_CSS): skins that restyle the composer trigger row override the
      // class, and an inline style would outrank the skin and drift from the
      // sibling model select. Nothing stays inline for the trigger.
      trigger: {},
      triggerLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { flex: '0 0 auto', color: 'var(--dsw-alias-label-caption)' },
      panel: {
        position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 20,
        display: 'flex', flexDirection: 'column', width: 'min(280px, calc(100vw - 32px))',
        maxHeight: 'min(360px, calc(100vh - 96px))', overflow: 'hidden', padding: 4,
        border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 12,
        background: 'var(--dsw-specific-menu)', boxShadow: 'var(--dsw-shadow-lv3)',
        color: 'var(--dsw-alias-label-primary)',
      },
      list: { minHeight: 0, overflowY: 'auto' },
      groupTitle: {
        position: 'sticky', top: 0, zIndex: 1, padding: '5px 8px 3px',
        background: 'var(--dsw-specific-menu)', color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12, lineHeight: '18px', fontWeight: 500,
      },
      option: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 38,
        padding: '6px 8px', border: 'none', borderRadius: 10, outline: 'none',
        color: 'inherit', textAlign: 'left', cursor: 'pointer',
      },
      optionName: {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        // Same no-font-family rule as the trigger: the model select's menu
        // rows declare only size/weight and inherit the rest, so these rows
        // must do the same to render in the identical face.
        fontSize: 14, lineHeight: '20px', fontWeight: 500,
      },
      optionHint: {
        flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px',
      },
      check: { display: 'grid', placeItems: 'center', flex: '0 0 18px', color: 'var(--dsw-alias-label-primary)' },
      status: { padding: 10, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' },
      error: {
        marginBottom: 4, padding: '7px 8px', borderRadius: 8,
        background: 'var(--dsw-alias-interactive-bg-hover-danger)', color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12, lineHeight: '18px',
      },
    }

    // :hover and the selected-cell emphasis need real CSS (React inline
    // styles cannot express pseudo-classes). Injected at materialization with
    // the module-system style tag so HMR/unload claims and removes it. The
    // selected cell takes the theme's interactive-accent wash (0.14 light /
    // 0.24 dark — plainly DEEPER than the 0.06/0.08 hover wash) plus a
    // bluish-400 rim, so the current selection never loses to a hovered row.
    // The trigger hover mirrors the model select's trigger so both tool-row
    // controls respond alike. Backgrounds live in these classes ONLY — an
    // inline `background` would outrank the classes and erase the selected
    // fill (inline style beats class specificity).
    //
    // The trigger's FULL face also lives here, not inline: the model select's
    // `.trigger` is a class, and skins restyle the composer trigger row with
    // a HIGHER-specificity selector (`[class*='trailing']
    // button[aria-haspopup='menu']`) that matches both buttons. An inline
    // font-size/weight would outrank that skin rule and leave this button at
    // the default weight while the model select renders the skin's (observed:
    // skin sets 600, the inline 500 won). As classes, both buttons follow
    // the skin together, and both fall back to the same default face when no
    // skin is active.
    var MENU_CSS = [
      '.dsh-vision-trigger {'
        + ' display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 220px; height: 28px;'
        + ' padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none;'
        + ' font-size: 13px; line-height: 20px; font-weight: 500;'
        + ' color: var(--dsw-alias-label-secondary); cursor: pointer; background: transparent; }',
      '.dsh-vision-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsh-vision-option { background: transparent; }',
      '.dsh-vision-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsh-vision-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsh-vision-option.selected { background: var(--dsw-alias-interactive-bg-hover-accent);'
        + ' box-shadow: inset 0 0 0 1px var(--dsw-static-neutral-bluish-400); }',
      '.dsh-vision-option.selected:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-accent); }',
    ].join('\n')

    function installMenuCss() {
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', 'dsh-vision-menu')
      tag.textContent = MENU_CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    function fetchJson(url, init) {
      return fetch(url, init).then((res) => {
        if (!res.ok) {
          return res
            .json()
            .catch(() => ({}))
            .then((body) => {
              var error = new Error(body.error || `request failed (${res.status})`)
              error.status = res.status
              throw error
            })
        }
        return res.json()
      })
    }

    // The button copy for one route: the catalog display name when known,
    // else the model id.
    function routeLabel(groups, current) {
      if (!current) return ''
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].provider !== current.provider) continue
        for (var m = 0; m < groups[g].models.length; m++) {
          if (groups[g].models[m].id === current.model) return groups[g].models[m].name || current.model
        }
      }
      return current.model
    }

    // One composer-instance menu: mounts with the seat, so each session's
    // composer owns a copy; the selection itself lives on the HOST (shared
    // across sessions), so every instance converges on the same POST result.
    function VisionModelMenu() {
      var state = useState({
        open: false, loading: true, error: '', groups: [], current: null,
      })
      var snap = state[0]
      var setSnap = state[1]
      var rootRef = useRef(null)

      var load = useCallback(() => {
        fetchJson('/vision-plugin/vision-models', { headers: { accept: 'application/json' } })
          .then((body) => {
            setSnap((prev) => ({
              ...prev, loading: false, error: '', groups: body.groups || [], current: body.current || null,
            }))
          })
          .catch((error) => {
            setSnap((prev) => ({ ...prev, loading: false, error: error.message }))
          })
      }, [])

      // Mount-time load resolves the trigger label; every open refreshes the
      // offered groups (provider topology changes land here).
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (snap.open) load()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open is the refresh trigger
      }, [snap.open])

      // Outside click and Escape close the panel (mouse-first v1).
      useEffect(() => {
        if (!snap.open) return
        var closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) setSnap((prev) => ({ ...prev, open: false }))
        }
        var closeOnEscape = (event) => {
          if (event.key === 'Escape') setSnap((prev) => ({ ...prev, open: false }))
        }
        document.addEventListener('mousedown', closeOutside)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
          document.removeEventListener('mousedown', closeOutside)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [snap.open, setSnap])

      var choose = (provider, model) => {
        fetchJson('/vision-plugin/vision-model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, model }),
        })
          .then((route) => {
            setSnap((prev) => ({ ...prev, open: false, error: '', current: route }))
          })
          .catch((error) => {
            setSnap((prev) => ({ ...prev, error: error.message }))
          })
      }

      // No offered free vision model anywhere: the seat renders nothing at
      // all (requirement: menu hidden when nothing is configured).
      if (!snap.loading && snap.groups.length === 0) return null

      var label = routeLabel(snap.groups, snap.current)
      var triggerText = snap.current ? `视觉：${label}` : '视觉：选择'
      var triggerAria = snap.current ? `视觉模型：${label}` : '选择视觉模型'
      var open = snap.open

      return h('div', { ref: rootRef, style: menuStyles.root },
        h('button', {
          type: 'button', className: 'dsh-vision-trigger', style: menuStyles.trigger,
          'aria-label': triggerAria, 'aria-haspopup': 'menu', 'aria-expanded': open,
          title: triggerText,
          onClick: () => setSnap((prev) => ({ ...prev, open: !prev.open })),
        },
          h('span', { style: menuStyles.triggerLabel }, triggerText),
          h('span', { style: menuStyles.chevron, 'aria-hidden': true }, '▾'),
        ),
        open && h('div', { role: 'menu', 'aria-label': '视觉模型', style: menuStyles.panel },
          snap.error !== '' && h('div', { style: menuStyles.error }, snap.error),
          snap.loading
            ? h('div', { style: menuStyles.status }, '加载中…')
            : h('div', { style: menuStyles.list },
              snap.groups.map((group) =>
                h('div', { key: group.provider },
                  h('div', { style: menuStyles.groupTitle }, group.displayName),
                  group.models.map((model) => {
                    var selected = snap.current !== null
                      && snap.current.provider === group.provider && snap.current.model === model.id
                    return h('button', {
                      key: model.id, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
                      className: selected ? 'dsh-vision-option selected' : 'dsh-vision-option',
                      style: menuStyles.option, title: model.name || model.id,
                      onClick: () => choose(group.provider, model.id),
                    },
                      h('span', { style: menuStyles.optionName }, model.name || model.id),
                      selected && h('span', { style: menuStyles.check, 'aria-hidden': true }, '✓'),
                    )
                  }),
                ),
              ),
            ),
        ),
      )
    }

    // ---- plugin body ----------------------------------------------------

    /** Required services: the slot registry owning the composer input seats. */
    exports.inject = ['slots']

    function apply(ctx) {
      // The menu rides the same declaration-inject mechanism as the model
      // select: register into `conversation.input.right` once the composer
      // declares it (and re-register if that declaration reloads).
      var disposeMenu = ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register({
          name: 'conversation.input.right',
          id: 'vision-model-menu',
          order: 10,
        }, VisionModelMenu))

      var disposeMenuCss = installMenuCss()
      var disposePaste = installPaste()
      return () => {
        disposeMenu()
        disposeMenuCss()
        disposePaste()
      }
    }

    exports.apply = apply
    return module.exports
  },
})
