/**
 * Host half of dsh-better-markdown: registers the same-origin `/dsh-img`
 * route on the dsh web server so assistant Markdown can embed local image
 * files by absolute path without a separate static file server.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports for the host service augmentations (no runtime cost).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_IMAGE_EXTENSIONS, serveImage } from './server/image-route.ts'
import type { ImageRouteConfig } from './server/image-route.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-better-markdown'

/** Route configuration with safe defaults (validated by the Loader). */
export interface Config extends ImageRouteConfig {}

/**
 * Configuration schema: deployment-varying bounds stay tunable from the
 * profile patch (`- id: better-markdown, config: {...}`). The callable form
 * accepts partial input and yields the full defaults.
 */
export const Config = z.object({
  maxBytes: z.natural().min(1).default(20 * 1024 * 1024),
  extraRoots: z.array(z.string()).default([]),
  allowAny: z.boolean().default(false),
  extensions: z.array(z.string()).default([...DEFAULT_IMAGE_EXTENSIONS]),
})

/** The `/dsh-img` route path (root-relative; the browser resolves it against the GUI origin). */
export const IMAGE_ROUTE_PATH = '/dsh-img'

/** Services required before load. */
export const inject = ['webServer', 'workspaceRegistry']

/**
 * Register the same-origin local image route and keep the host row active so
 * the client-module registry discovers this package's `dsh.client` entry.
 * @param ctx - Host cordis context carrying the web server and workspace registry.
 * @param config - Validated plugin configuration (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = (config !== undefined ? config : Config({})) as unknown as ImageRouteConfig

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: IMAGE_ROUTE_PATH,
      handler: (req, res) => {
        // The registry is a synchronous projection; no persistence reads per request.
        void serveImage(req, res, resolved, ctx.workspaceRegistry.list().map(workspace => workspace.path))
          .catch(() => { if (!res.headersSent) res.writeHead(500); res.end('image route failed') })
      },
    })
  }, 'dsh-better-markdown: /dsh-img route')
}
