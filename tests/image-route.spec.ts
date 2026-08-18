import { Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fsp, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Config } from '../src/index.ts'
import {
  DEFAULT_IMAGE_EXTENSIONS,
  expandHome,
  imageHeaders,
  looksLikeLocalPath,
  matchesImageSignature,
  resolveImage,
  serveImage,
} from '../src/server/image-route.ts'
import type { ImageRouteConfig } from '../src/server/image-route.ts'

/** One real 1x1 transparent PNG. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const DEFAULT_CONFIG: ImageRouteConfig = {
  maxBytes: 1024 * 1024,
  extraRoots: [],
  allowAny: false,
  extensions: [...DEFAULT_IMAGE_EXTENSIONS],
}

interface CapturedResponse extends Writable {
  statusCode?: number | undefined
  headers: Record<string, string>
  chunks: Buffer[]
}

/** Minimal ServerResponse surface used by serveImage (structural mock). */
interface MockServerResponse extends Writable {
  statusCode?: number | undefined
  headers: Record<string, string>
  chunks: Buffer[]
  headersSent: boolean
  setHeader(key: string, value: string): void
  writeHead(status: number, maybeHeaders?: Record<string, string> | string): void
}

describe('Config', () => {
  it('applies defaults when the loader passes no config', async () => {
    expect(await Config['~standard'].validate(undefined)).toEqual({
      value: {
        maxBytes: 20 * 1024 * 1024,
        extraRoots: [],
        allowAny: false,
        extensions: [...DEFAULT_IMAGE_EXTENSIONS],
      },
    })
  })
})

function mockRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

async function request(
  method: string,
  url: string,
  config: ImageRouteConfig = DEFAULT_CONFIG,
  roots: readonly string[] = [],
  headers: Record<string, string> = {},
): Promise<CapturedResponse> {
  const res: MockServerResponse = new Writable({ write(chunk, _enc, cb) { res.chunks.push(Buffer.from(chunk)); cb() } }) as unknown as MockServerResponse
  res.headers = {}
  res.statusCode = undefined
  res.chunks = []
  res.headersSent = false
  res.setHeader = (key: string, value: string) => { res.headers[key.toLowerCase()] = String(value) }
  res.writeHead = (status: number, maybeHeaders?: Record<string, string> | string) => {
    res.statusCode = status
    if (typeof maybeHeaders === 'object' && maybeHeaders !== null) {
      for (const [key, value] of Object.entries(maybeHeaders)) res.headers[key.toLowerCase()] = String(value)
    }
    res.headersSent = true
  }
  const req = mockRequest(method, url) as IncomingMessage & { headers: Record<string, string> }
  req.headers = { ...headers }
  await serveImage(req, res as unknown as ServerResponse, config, roots)
  // The body stream finishes after serveImage returns; wait for drain.
  const state = (res as unknown as { _writableState?: { ended?: boolean; closing?: boolean } })._writableState
  if (!state?.ended && !state?.closing) {
    await new Promise<void>(resolvePromise => { res.once('finish', () => resolvePromise()) })
  }
  return res
}

describe('expandHome', () => {
  it('expands ~/ and bare ~ against the home directory', () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    expect(expandHome('~')).toBe(home)
    expect(expandHome('~/x/y.png')).toBe(join(home, 'x/y.png'))
  })

  it('leaves other spellings unchanged', () => {
    expect(expandHome('/abs/path.png')).toBe('/abs/path.png')
    expect(expandHome('relative.png')).toBe('relative.png')
  })
})

describe('looksLikeLocalPath', () => {
  it('accepts absolute POSIX paths and rejects relatives on posix', () => {
    if (process.platform === 'win32') return
    expect(looksLikeLocalPath('/a/b/c.png')).toBe(true)
    expect(looksLikeLocalPath('relative.png')).toBe(false)
    expect(looksLikeLocalPath('')).toBe(false)
  })

  it('accepts drive and UNC paths on win32', () => {
    if (process.platform !== 'win32') return
    expect(looksLikeLocalPath('C:\\a\\b.png')).toBe(true)
    expect(looksLikeLocalPath('//server/share/b.png')).toBe(true)
  })
})

describe('matchesImageSignature', () => {
  it('accepts png and empty heads', () => {
    expect(matchesImageSignature(PNG_BYTES.subarray(0, 16))).toBe(true)
    expect(matchesImageSignature(Buffer.alloc(0))).toBe(true)
  })

  it('rejects RIFF containers that are not WEBP', () => {
    const riff = Buffer.from('RIFF\x00\x00\x00\x00AVI ')
    expect(matchesImageSignature(riff)).toBe(false)
  })
})

describe('resolveImage', () => {
  it('resolves existing absolute paths and rejects missing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-img-'))
    const file = join(dir, 'a.png')
    writeFileSync(file, PNG_BYTES)
    expect(resolveImage(file)).toEqual({ real: file, ext: '.png' })
    if (process.platform !== 'win32') {
      expect(resolveImage(join(dir, 'missing.png'))).toBeUndefined()
      expect(resolveImage('relative.png')).toBeUndefined()
    }
  })
})

describe('serveImage', () => {
  let root: string
  let outsideDir: string
  let pngPath: string
  let txtPath: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bm-root-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bm-outside-'))
    pngPath = join(root, 'shot.png')
    writeFileSync(pngPath, PNG_BYTES)
    txtPath = join(root, 'notes.txt')
    writeFileSync(txtPath, 'hello world\n')
  })

  it('serves an image inside the allowed root with correct headers', async () => {
    const res = await request('GET', `/dsh-img?p=${encodeURIComponent(pngPath)}`, DEFAULT_CONFIG, [root])
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.concat(res.chunks).equals(PNG_BYTES)).toBe(true)
  })

  it('rejects paths outside the allowed roots with 403', async () => {
    const outside = join(outsideDir, 'x.png')
    writeFileSync(outside, PNG_BYTES)
    const res = await request('GET', `/dsh-img?p=${encodeURIComponent(outside)}`, DEFAULT_CONFIG, [root])
    expect(res.statusCode).toBe(403)
  })

  it('rejects unserved extensions with 415 even for valid image bytes', async () => {
    const res = await request('GET', `/dsh-img?p=${encodeURIComponent(txtPath)}`, DEFAULT_CONFIG, [root])
    expect(res.statusCode).toBe(415)
  })

  it('rejects missing p with 400 and unknown files with 404', async () => {
    expect((await request('GET', '/dsh-img', DEFAULT_CONFIG, [root])).statusCode).toBe(400)
    const missing = join(root, 'nope.png')
    expect((await request('GET', `/dsh-img?p=${encodeURIComponent(missing)}`, DEFAULT_CONFIG, [root])).statusCode).toBe(404)
  })

  it('rejects oversize files with 413', async () => {
    const big = join(root, 'big.png')
    writeFileSync(big, Buffer.concat([PNG_BYTES, Buffer.alloc(2048)]))
    const res = await request('GET', `/dsh-img?p=${encodeURIComponent(big)}`, { ...DEFAULT_CONFIG, maxBytes: 1024 }, [root])
    expect(res.statusCode).toBe(413)
  })

  it('honors If-None-Match with a 304 revalidation', async () => {
    const first = await request('GET', `/dsh-img?p=${encodeURIComponent(pngPath)}`, DEFAULT_CONFIG, [root])
    const etag = first.headers['etag'] ?? ''
    expect(etag.length).toBeGreaterThan(0)
    const second = await request(
      'GET',
      `/dsh-img?p=${encodeURIComponent(pngPath)}`,
      DEFAULT_CONFIG,
      [root],
      { 'if-none-match': etag },
    )
    expect(second.statusCode).toBe(304)
  })

  it('serves any readable file when allowAny is set', async () => {
    const res = await request('GET', `/dsh-img?p=${encodeURIComponent(txtPath)}`, { ...DEFAULT_CONFIG, allowAny: true }, [root])
    expect(res.statusCode).toBe(200)
    expect(Buffer.concat(res.chunks).toString()).toBe('hello world\n')
  })

  it('rejects non-GET methods with 405', async () => {
    const res = await request('POST', `/dsh-img?p=${encodeURIComponent(pngPath)}`, DEFAULT_CONFIG, [root])
    expect(res.statusCode).toBe(405)
  })
})

describe('imageHeaders', () => {
  it('emits a weak size+mtime ETag and no-cache policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-etag-'))
    const file = join(dir, 'a.png')
    writeFileSync(file, PNG_BYTES)
    const candidate = resolveImage(file)
    expect(candidate).not.toBeUndefined()
    const stat = await fsp.stat(file)
    const headers = imageHeaders(candidate!, stat)
    expect(headers['Cache-Control']).toBe('no-cache')
    expect(headers.ETag).toMatch(/^W\/".+-\d+"$/)
    expect(headers['Content-Type']).toBe('image/png')
  })
})
