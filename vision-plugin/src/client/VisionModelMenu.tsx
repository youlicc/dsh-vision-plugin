/**
 * The composer vision-model menu. Registered into `conversation.input.right`
 * (right end of the tool row, before the send button) by the client plugin
 * body. The dropdown lists the offered free vision models grouped by
 * provider (GET /vision-plugin/vision-models); clicking a row POSTs
 * /vision-plugin/vision-model and re-reads the selection. Hidden entirely
 * when no configured provider offers a free vision model.
 * @module @dsh-external/dsh-vision-plugin/client/VisionModelMenu
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadVisionGroups, routeLabel, saveVisionRoute } from './fetch.ts'
import type { VisionModelGroup, VisionRoute } from './fetch.ts'
import css from './VisionMenu.module.css'

interface MenuState {
  open: boolean
  loading: boolean
  error: string
  groups: readonly VisionModelGroup[]
  current: VisionRoute | null
}

/**
 * One composer-instance menu: mounts with the seat, so each session's
 * composer owns a copy; the selection itself lives on the HOST (shared
 * across sessions), so every instance converges on the same POST result.
 */
export function VisionModelMenu(): React.JSX.Element | null {
  const [snap, setSnap] = useState<MenuState>({
    open: false, loading: true, error: '', groups: [], current: null,
  })
  const rootRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(() => {
    loadVisionGroups()
      .then((body) => {
        setSnap((prev) => ({
          ...prev, loading: false, error: '', groups: body.groups, current: body.current,
        }))
      })
      .catch((error: Error) => {
        setSnap((prev) => ({ ...prev, loading: false, error: error.message }))
      })
  }, [])

  // Mount-time load resolves the trigger label; every open refreshes the
  // offered groups (provider topology changes land here).
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (snap.open) load()
  }, [snap.open, load])

  // Outside click and Escape close the panel (mouse-first).
  useEffect(() => {
    if (!snap.open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setSnap((prev) => ({ ...prev, open: false }))
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSnap((prev) => ({ ...prev, open: false }))
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [snap.open])

  const choose = (provider: string, model: string): void => {
    saveVisionRoute({ provider, model })
      .then((route) => {
        setSnap((prev) => ({ ...prev, open: false, error: '', current: route }))
      })
      .catch((error: Error) => {
        setSnap((prev) => ({ ...prev, error: error.message }))
      })
  }

  // No offered free vision model anywhere: the seat renders nothing at all
  // (requirement: menu hidden when nothing is configured).
  if (!snap.loading && snap.groups.length === 0) return null

  const label = routeLabel(snap.groups, snap.current)
  const triggerText = snap.current !== null ? `视觉：${label}` : '视觉：选择'
  const triggerAria = snap.current !== null ? `视觉模型：${label}` : '选择视觉模型'

  return (
    <div ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={snap.open}
        title={triggerText}
        onClick={() => setSnap((prev) => ({ ...prev, open: !prev.open }))}
      >
        <span className={css.triggerLabel}>{triggerText}</span>
        <span className={css.chevron} aria-hidden>▾</span>
      </button>

      {snap.open && (
        <div role="menu" aria-label="视觉模型" className={css.panel}>
          {snap.error !== '' && <div className={css.error}>{snap.error}</div>}
          {snap.loading
            ? <div className={css.status}>加载中…</div>
            : (
              <div className={css.list}>
                {snap.groups.map((group) => (
                  <div key={group.provider}>
                    <div className={css.groupTitle}>{group.displayName}</div>
                    {group.models.map((model) => {
                      const selected = snap.current !== null
                        && snap.current.provider === group.provider
                        && snap.current.model === model.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={selected ? `${css.option} ${css.selected}` : css.option}
                          title={model.name || model.id}
                          onClick={() => choose(group.provider, model.id)}
                        >
                          <span className={css.optionName}>{model.name || model.id}</span>
                          {selected && <span className={css.check} aria-hidden>✓</span>}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
