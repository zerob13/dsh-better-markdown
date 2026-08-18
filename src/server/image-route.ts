/**
 * Same-origin local image route: `GET /dsh-img?p=<absolute path>` serves one
 * local file from the dsh web server itself, so assistant Markdown can embed
 * workspace images without a separate static file server. The browser resolves
 * the root-relative URL against the GUI origin; no CORS is involved.
 */

import { createReadStream, promises as fsp, realpathSync, statSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, platform } from 'node:os'
import { extname, resolve, sep } from 'node:path'

/** Image extensions the route serves by default (lowercase, leading dot). */
export const DEFAULT_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.svg',
] as const

/** Content types for the served extensions. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** Magic-byte signatures checked before the first extension-only trust. */
const SIGNATURES: Array<[Buffer, number]> = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0], // png
  [Buffer.from([0xff, 0xd8, 0xff]), 0], // jpeg
  [Buffer.from('GIF8'), 0], // gif
  [Buffer.from('RIFF'), 0], // webp (RIFF container; subtype verified below)
  [Buffer.from('BM'), 0], // bmp
]

/** Route configuration with safe defaults. */
export interface ImageRouteConfig {
  /** Hard cap on served file size in bytes. */
  maxBytes: number
  /** Additional directories allowed beyond the registered workspaces. */
  extraRoots: string[]
  /** When true, any readable local file is served (loopback convenience). */
  allowAny: boolean
  /** Extensions accepted by the route; empty serves nothing. */
  extensions: readonly string[]
}

/** Rejection reasons with their HTTP status. */
export type ImageRejectReason = 'bad-path' | 'not-found' | 'extension' | 'too-large' | 'signature'

/** One resolved candidate for a request path. */
export interface ResolvedImage {
  /** Canonical absolute path after `~` expansion and realpath. */
  real: string
  /** Lowercased extension of the requested basename (empty when none). */
  ext: string
}

/**
 * Expand a leading `~/` against the home directory; any other spelling is
 * returned unchanged so the caller can validate its shape.
 * @param raw - The raw `p` query value.
 * @returns The expanded absolute-path candidate.
 */
export function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return raw
}

/**
 * Validate the spelling of one requested path for this platform.
 * @param raw - The `~`-expanded request value.
 * @returns true when the shape is a plausible absolute local file path.
 */
export function looksLikeLocalPath(raw: string): boolean {
  if (raw.length === 0) return false
  if (platform() === 'win32') {
    // Drive-letter paths in either slash spelling, or UNC shares. Markdown escape
    // processing may collapse a leading backslash pair to one, so accept both.
    return /^[A-Za-z]:[\\/]/.test(raw) || /^\\{1,2}/.test(raw)
  }
  return raw.startsWith('/')
}

/**
 * Check the leading bytes of one file against known image signatures.
 * Extension-only formats (svg/avif) pass unless a conflicting signature is
 * present, so unknown-but-valid encodings are not rejected by mistake.
 * @param head - The first 16 bytes of the file.
 * @returns true when the bytes do not contradict an image format.
 */
export function matchesImageSignature(head: Buffer): boolean {
  if (head.length === 0) return true
  const isWebp = head.length >= 12 && head.subarray(8, 12).toString('ascii') === 'WEBP'
  for (const [signature, offset] of SIGNATURES) {
    if (offset + signature.length > head.length) continue
    if (!head.subarray(offset, offset + signature.length).equals(signature)) continue
    // RIFF matches only when the WEBP subtype is present.
    if (signature[0] === 0x52 && !isWebp) return false
    return true
  }
  return true
}

/**
 * Expand `~`, validate the spelling, and canonicalize one request path.
 * @param raw - The raw query value.
 * @returns The resolved candidate, or undefined when missing/malformed.
 */
export function resolveImage(raw: string): ResolvedImage | undefined {
  const expanded = expandHome(raw)
  if (!looksLikeLocalPath(expanded)) return undefined
  let real: string
  try {
    real = realpathSync(expanded)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    // An untraversable parent directory is effectively a missing file for this client.
    if (code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
  return { real, ext: extname(real).toLowerCase() }
}

/**
 * Whether one canonical path sits inside any of the allowed roots.
 * @param real - The realpath of the requested file.
 * @param roots - Canonical directory prefixes (already realpathed).
 * @returns true when the file is under at least one root.
 */
export function underAnyRoot(real: string, roots: readonly string[]): boolean {
  return roots.some(root => real === root || real.startsWith(root + sep))
}

/**
 * Build the response headers for one resolved image.
 * @param candidate - The validated candidate.
 * @param stat - Its filesystem stats.
 * @returns Header values including a size+mtime weak ETag.
 */
export function imageHeaders(candidate: ResolvedImage, stat: Stats): Record<string, string> {
  return {
    'Content-Type': CONTENT_TYPES[candidate.ext] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
    ETag: `W/"${stat.mtimeMs.toString(16)}-${stat.size}"`,
    // Files are frequently regenerated mid-session; always revalidate.
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  }
}

/**
 * Serve one `/dsh-img?p=<path>` request.
 * @param req - The incoming HTTP request (method GET or HEAD).
 * @param res - The response to own from here on.
 * @param config - Validated route configuration.
 * @param workspaceRoots - Canonical registered workspace directories.
 */
export async function serveImage(
  req: IncomingMessage,
  res: ServerResponse,
  config: ImageRouteConfig,
  workspaceRoots: readonly string[],
): Promise<void> {
  const fail = (status: number, message: string): void => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(message)
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return fail(405, `method ${req.method} not allowed`)
  }

  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return fail(400, 'bad request target')
  }
  const raw = url.searchParams.get('p')
  if (raw === null || raw.length === 0) return fail(400, "missing query parameter 'p'")

  const resolved = resolveImage(raw)
  if (resolved === undefined) return fail(404, 'file not found or bad path')

  let stat: Stats
  try {
    stat = statSync(resolved.real)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fail(404, 'file not found')
    // Permission loss between resolve and stat is a controlled rejection, not a crash.
    if (code === 'EACCES' || code === 'EPERM') return fail(403, 'file is inaccessible')
    throw error
  }
  if (!stat.isFile()) return fail(404, 'not a regular file')
  if (stat.size > config.maxBytes) return fail(413, `larger than ${config.maxBytes} bytes`)

  // Canonical allowed roots: registered workspaces plus configured extras.
  const roots: string[] = []
  for (const candidate of [...workspaceRoots, ...config.extraRoots]) {
    try {
      roots.push(realpathSync(candidate))
    } catch {
      // A missing extra root simply allows nothing under it.
    }
  }

  if (!config.allowAny && !underAnyRoot(resolved.real, roots)) return fail(403, 'outside allowed directories')
  // allowAny serves any readable file; otherwise the extension gate applies and an
  // empty list denies every extension (serving nothing).
  if (!config.allowAny && !config.extensions.includes(resolved.ext)) {
    return fail(415, `extension '${resolved.ext || '(none)'}' not served`)
  }

  let handle: FileHandle
  try {
    handle = await fsp.open(resolved.real, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fail(404, 'file not found')
    // Mode bits can drop between stat and open; keep the failure controlled.
    if (code === 'EACCES' || code === 'EPERM') return fail(403, 'file is inaccessible')
    throw error
  }
  try {
    const head = Buffer.alloc(Math.min(16, stat.size))
    await handle.read(head, 0, head.length, 0).catch(() => undefined)
    if (!matchesImageSignature(head)) return fail(415, 'bytes do not match a known image signature')

    const headers = imageHeaders(resolved, stat)
    const etag = headers['ETag'] ?? ''
    const inm = req.headers['if-none-match']
    if (typeof inm === 'string' && inm.includes(etag)) res.writeHead(304, { ETag: etag })
    else res.writeHead(200, headers)
  } finally {
    await handle.close().catch(() => undefined)
  }

  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(resolved.real)
  stream.on('error', () => { if (!res.headersSent) fail(500, 'read failed'); else res.destroy() })
  stream.pipe(res)
}
