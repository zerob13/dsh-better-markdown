// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeCustomComponents } from 'markstream-react'
import { apply } from '../src/client/index.ts'
import { MarkstreamMarkdown } from '../src/client/renderer.tsx'

function mountPlugin() {
  const register = vi.fn(() => () => {})
  const slots = {
    inject: vi.fn((_name: string, setup: () => unknown) => setup()),
    register,
  }
  const disposers: Array<() => void> = []
  const ctx = {
    slots,
    effect: vi.fn((setup: () => void | (() => void)) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
    }),
  }
  apply(ctx as never)
  return { register, slots, dispose: () => disposers.reverse().forEach(dispose => { dispose() }) }
}

afterEach(() => {
  removeCustomComponents('dsh-better-markdown')
})

describe('browser plugin', () => {
  it('shadows the built-in assistant renderer and leaves it as fallback', () => {
    const plugin = mountPlugin()
    expect(plugin.slots.inject).toHaveBeenCalledWith('conversation.chat.node', expect.any(Function))
    expect(plugin.register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: -100,
    }), expect.objectContaining({ type: expect.any(Function) }))
    plugin.dispose()
  })

  it('renders streamed Markdown through markstream-react', () => {
    const plugin = mountPlugin()
    const view = render(<MarkstreamMarkdown text={'# Stream\n\n**partial'} streaming />)
    expect(view.container.querySelector('[data-markdown-renderer="markstream-react"] .markstream-react')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Stream' })).toBeTruthy()
    view.rerender(<MarkstreamMarkdown text={'# Stream\n\n**complete**'} streaming={false} />)
    expect(screen.getByText('complete').closest('strong')).not.toBeNull()
    plugin.dispose()
  })

  it('keeps raw HTML inert and unsafe links non-interactive', () => {
    const plugin = mountPlugin()
    const view = render(
      <MarkstreamMarkdown
        text={'<script>alert(1)</script>\n\n[local](./secret) [safe](https://example.com)'}
        streaming={false}
      />,
    )
    expect(view.container.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy()
    expect(screen.getByText('local').closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'safe' }).getAttribute('href')).toBe('https://example.com')
    plugin.dispose()
  })

  it('uses Markstream Shiki code blocks and only resolves file mentions after streaming', async () => {
    const plugin = mountPlugin()
    const open = vi.fn()
    const fileMentions = {
      resolve: vi.fn((value: string) => value === 'src/index.ts'
        ? { label: 'Open src/index.ts', title: 'src/index.ts', open }
        : undefined),
    }
    const view = render(
      <MarkstreamMarkdown
        text={'```\nplain text\n```\n\nAfter the first block\n\n```ts\nconst value = 1\n```\n\n`src/index.ts`'}
        streaming
        fileMentions={fileMentions}
      />,
    )
    expect(view.container.querySelector('.code-block-container')).not.toBeNull()
    expect(view.container.querySelector('.md-code-block')).toBeNull()
    expect(view.container.querySelector('.monaco-editor')).toBeNull()
    expect(view.container.querySelector('.node-placeholder')).toBeNull()
    expect(screen.getByText('After the first block')).toBeTruthy()
    await waitFor(() => {
      expect(view.container.querySelector('.code-block-render .shiki')).not.toBeNull()
    })
    expect(screen.queryByRole('button', { name: 'Open src/index.ts' })).toBeNull()
    view.rerender(
      <MarkstreamMarkdown
        text={'```\nplain text\n```\n\nAfter the first block\n\n```ts\nconst value = 1\n```\n\n`src/index.ts`'}
        streaming={false}
        fileMentions={fileMentions}
      />,
    )
    expect(screen.getByRole('button', { name: 'Open src/index.ts' })).toBeTruthy()
    plugin.dispose()
  })

  it('routes Mermaid fences to the bundled Markstream renderer', () => {
    const plugin = mountPlugin()
    const view = render(
      <MarkstreamMarkdown
        text={'```mermaid\ngraph TD\n  A --> B\n```'}
        streaming={false}
      />,
    )
    expect(view.container.querySelector('[data-markstream-mermaid="1"]')).not.toBeNull()
    expect(view.container.querySelector('.md-code-block')).toBeNull()
    plugin.dispose()
  })

  it('follows the DSH shell dark theme and reacts to live switches', async () => {
    const plugin = mountPlugin()
    document.body.setAttribute('data-ds-dark-theme', '')
    const view = render(
      <MarkstreamMarkdown text={'```python\nprint(1)\n```'} streaming={false} />,
    )
    await waitFor(() => {
      expect(view.container.querySelector('.markstream-react.dark')).not.toBeNull()
    })
    document.body.removeAttribute('data-ds-dark-theme')
    await waitFor(() => {
      expect(view.container.querySelector('.markstream-react.dark')).toBeNull()
    })
    view.unmount()
    plugin.dispose()
  })
})
