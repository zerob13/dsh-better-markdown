/** Browser half: shadow the built-in assistant and user renderers at a lower slot priority. */

import type { Context } from '@deepseek-ai/cordis'
import { removeCustomComponents, setCustomComponents } from 'markstream-react'
import 'markstream-react/index.css'
import './styles.css'
import {
  BetterAssistantNodeView,
  DshCodeBlockNode,
  DshImageNode,
  DshInlineCodeNode,
  DshLinkNode,
} from './renderer.tsx'
import { BetterUserNodeView } from './user.tsx'

const CUSTOM_COMPONENT_SCOPE = 'dsh-better-markdown'

/** Services required in the browser Cordis tree. */
export const inject = ['slots']

/**
 * Replace the `assistant-step`, `user`, and `steering` slot cells while
 * preserving the built-in renderers as fallbacks.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    setCustomComponents(CUSTOM_COMPONENT_SCOPE, {
      code_block: DshCodeBlockNode,
      image: DshImageNode,
      inline_code: DshInlineCodeNode,
      link: DshLinkNode,
    })
    return () => { removeCustomComponents(CUSTOM_COMPONENT_SCOPE) }
  }, 'dsh-better-markdown: markstream component policy')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    priority: -100,
    locale: 'conversation',
  }, BetterAssistantNodeView))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: -100,
    locale: 'conversation',
  }, BetterUserNodeView))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'steering',
    priority: -100,
    locale: 'conversation',
  }, BetterUserNodeView))
}
