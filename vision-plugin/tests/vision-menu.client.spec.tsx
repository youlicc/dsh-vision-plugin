// @vitest-environment jsdom
/**
 * VisionModelMenu component behavior: renders the trigger with the current
 * selection, opens a provider-grouped dropdown, marks the current row, posts
 * a selection and converges on the accepted route, and hides entirely when
 * no provider offers a free vision model. Fetch is mocked; the component
 * reads nothing else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VisionModelMenu } from '../src/client/VisionModelMenu.tsx'
import type { VisionGroupsPayload } from '../src/client/fetch.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GROUPS: VisionGroupsPayload = {
  groups: [
    {
      provider: 'openrouter', displayName: 'openrouter',
      models: [
        { id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)' },
        { id: 'google/gemma-4-26b-a4b-it:free', name: 'Google: Gemma 4 26B A4B (free)' },
      ],
    },
    {
      provider: 'opencode', displayName: 'opencode',
      models: [{ id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' }],
    },
  ],
  current: { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
}

function mockFetch(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(json), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('VisionModelMenu', () => {
  it('renders the trigger with the current selection label', async () => {
    mockFetch(GROUPS)
    render(<VisionModelMenu />)
    await screen.findByRole('button', { name: /视觉模型：Google: Gemma 4 31B/ })
    expect(screen.getByText('视觉：Google: Gemma 4 31B (free)')).toBeTruthy()
  })

  it('opens a provider-grouped dropdown and marks the current row', async () => {
    mockFetch(GROUPS)
    render(<VisionModelMenu />)
    const trigger = await screen.findByRole('button', { name: /视觉模型：Google: Gemma 4 31B/ })
    fireEvent.click(trigger)

    await screen.findByRole('menu', { name: '视觉模型' })
    // Both providers are listed with their display names.
    expect(screen.getByText('openrouter')).toBeTruthy()
    expect(screen.getByText('opencode')).toBeTruthy()
    // The current model row is aria-checked.
    const checked = screen.getByRole('menuitemradio', { name: /Google: Gemma 4 31B/ })
    expect(checked.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /MiMo V2.5 Free/ }).getAttribute('aria-checked')).toBe('false')
  })

  it('posts a selection and converges the trigger label on the accepted route', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      // The list endpoint returns the offered groups; the POST echoes the
      // accepted route.
      const body = url === '/vision-plugin/vision-model' && init?.method === 'POST'
        ? JSON.parse(String(init.body))
        : GROUPS
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<VisionModelMenu />)
    const trigger = await screen.findByRole('button', { name: /视觉模型：Google: Gemma 4 31B/ })
    fireEvent.click(trigger)
    await screen.findByRole('menu', { name: '视觉模型' })

    const mimo = screen.getByRole('menuitemradio', { name: /MiMo V2.5 Free/ })
    fireEvent.click(mimo)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/vision-plugin/vision-model',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ provider: 'opencode', model: 'mimo-v2.5-free' }),
        }),
      )
    })
    // Converged label after the accepted route echoes back.
    await screen.findByText('视觉：MiMo V2.5 Free')
  })

  it('hides entirely when no provider offers a free vision model', async () => {
    mockFetch({ groups: [], current: null })
    render(<VisionModelMenu />)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /视觉/ })).toBeNull()
    })
  })

  it('closes on Escape', async () => {
    mockFetch(GROUPS)
    render(<VisionModelMenu />)
    const trigger = await screen.findByRole('button', { name: /视觉模型：Google: Gemma 4 31B/ })
    fireEvent.click(trigger)
    await screen.findByRole('menu', { name: '视觉模型' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
