/** User-message renderer: keeps DSH's right-aligned bubble shape and renders
 *  the text blocks through the same Markstream renderer used for assistant
 *  output. Images, extra blocks, copy action and the date-aware clock follow
 *  the built-in user bubble behavior. */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, JsonBlock, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery, type ImageLoader } from '@deepseek-ai/dsh-client-ui-attachment'
import type {
  SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps, ChatViewSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MarkstreamMarkdown } from './renderer.tsx'

type UserMessageData = UserMessageNode | SteeringMessageNode
type UserContent = UserMessageData['content']
type UserImage = Extract<UserContent[number], { type: 'image' }>

function contentParts(content: UserContent): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      texts.push(block.text)
    } else if (block.type === 'image') {
      images.push({ attachment: block.attachment })
    } else {
      rest.push(block)
    }
  }
  return { text: texts.join(''), images, rest }
}

/** DSH conversation-locale labels for the chat-history image gallery. */
function messageImageLabels(t: ChatViewSlotProps['t']) {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: (label: string) => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: {
      dialog: t('image.preview'),
      close: t('image.closePreview'),
    },
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function msUntilNextLocalMidnight(ms: number): number {
  const next = new Date(ms)
  next.setHours(24, 0, 0, 0)
  return Math.max(next.getTime() - ms, 1)
}

/** Date-aware clock used by the built-in user IconActions row. */
function formatMessageClock(time: number, t: ChatViewSlotProps['t'], now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (
    d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate()
  ) {
    return clock
  }
  const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
  const md = d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)
  return `${md} ${clock}`
}

/** Component-local calendar-day tick (re-fires at the next local midnight). */
function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = Date.now()
      setDay(startOfLocalDay(now))
      timer = setTimeout(arm, msUntilNextLocalMidnight(now))
    }
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
    return () => { clearTimeout(timer) }
  }, [])
  return day
}

function UserCopyActions({ text, time, t }: {
  text: string
  time: number
  t: ChatViewSlotProps['t']
}) {
  const day = useCalendarDay()
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = () => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }
  return (
    <div className="dsh-better-markdown__user-actions">
      <span className="dsh-better-markdown__user-time">{formatMessageClock(time, t, day)}</span>
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button
          type="button"
          className="dsh-better-markdown__user-action"
          aria-label={copied ? t('copied') : t('copy')}
          onClick={onCopy}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
    </div>
  )
}

/** Right-aligned user bubble with Markstream-rendered text. */
export function UserMarkdownBubble({ content, time, loadImage, t }: {
  content: UserContent
  time: number
  loadImage?: ImageLoader | undefined
  t: ChatViewSlotProps['t']
}): ReactNode {
  const imageLoader = loadImage ?? (() => Promise.reject(new Error(t('image.serviceUnavailable'))))
  const { text, images, rest } = useMemo(() => contentParts(content), [content])
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  const hasCodeBlock = /(^|\n)\s*(```|~~~)/.test(text)
  const stackClassName = hasCodeBlock
    ? 'dsh-better-markdown__user-stack dsh-better-markdown__user-stack--code'
    : 'dsh-better-markdown__user-stack'
  const bubbleClassName = hasCodeBlock
    ? 'dsh-better-markdown__user-bubble dsh-better-markdown__user-bubble--code'
    : 'dsh-better-markdown__user-bubble'
  return (
    <div className="dsh-better-markdown__user-row" data-time-hover-root>
      <div className={stackClassName}>
        <ImageGallery images={images} load={imageLoader} align="end" labels={messageImageLabels(t)} />
        {showBubble && (
          <div className={bubbleClassName}>
            {text !== '' && <MarkstreamMarkdown text={text} streaming={false} />}
            {rest.map((block, i) => (
              <JsonBlock
                key={i}
                label={t('message.extraBlock')}
                payload={block}
                truncatedLabel={truncated}
              />
            ))}
          </div>
        )}
      </div>
      <UserCopyActions text={text} time={time} t={t} />
    </div>
  )
}

/** Shadow renderer for `conversation.chat.node` keys `user` and `steering`. */
export const BetterUserNodeView = memo(function BetterUserNodeView({
  node, loadImage, t,
}: ChatNodeViewProps<'user' | 'steering'>) {
  const data = node.data
  return (
    <UserMarkdownBubble
      content={data.content}
      time={data.time}
      loadImage={loadImage}
      t={t}
    />
  )
})
