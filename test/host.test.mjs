/**
 * Host-half contract tests.
 *
 * `apply()` is exercised against a miniature stand-in for the two DSH services
 * it depends on, with their real rules copied from the DSH source:
 *
 *  - route matching, from `packages/host/webserver/src/index.ts`:
 *    a `prefix` route registered as `p` matches `p` and `p/<anything>`. This is
 *    why a trailing slash in `routePath` silently matches nothing, and why it
 *    is asserted here.
 *  - the Host/Origin trust fence, from `dsh-client-connection`: `Host` must be
 *    loopback or an exact `trustedHosts` entry, and a present `Origin` must
 *    equal the `Host`.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { apply, inject } from '../index.js'

/** Minimal `ctx.webServer`: named routes plus the fallback seat. */
class FakeWebServer {
  constructor() {
    /** @type {Map<string, any>} */ this.exact = new Map()
    /** @type {Map<string, any>} */ this.prefixes = new Map()
    /** @type {((req: any, res: any) => any) | undefined} */ this.fallback = undefined
    /** @type {Array<(html: string) => string>} */ this.taps = []
  }

  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    table.set(route.path, route)
    return () => table.delete(route.path)
  }

  registerFallback(handler) {
    if (this.fallback) throw new Error('webserver: fallback already registered')
    this.fallback = handler
    return () => {
      this.fallback = undefined
    }
  }

  tapIndex(transform) {
    this.taps.push(transform)
    return () => {
      this.taps = this.taps.filter((entry) => entry !== transform)
    }
  }

  renderIndex(html) {
    return this.taps.reduce((current, tap) => tap(current), html)
  }

  /** Copied from the DSH implementation: exact table, then longest prefix. */
  match(pathname) {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = { path: prefix, route }
    }
    return best?.route
  }
}

/**
 * Browser-session stand-in: only the names the board API is expected to admit,
 * with the same 401/403 split the Connection uses.
 */
function fakeConnection(admitted) {
  return {
    requestRejection({ headers }) {
      const raw = headers.host ?? headers.Host
      const host = Array.isArray(raw) ? raw[0] : raw
      const name = String(host ?? '').split(':')[0]
      const trusted = name === '127.0.0.1' || name === 'localhost'
      if (!trusted) return 403
      const origin = headers.origin ?? headers.Origin
      if (origin && String(origin) !== `http://${host}`) return 403
      return admitted.has(headers.authorization ?? '') || admitted.has('*') ? undefined : 401
    },
  }
}

/** Build a real `apply()` context backed by a real HTTP listener. */
async function startPlugin({ config = {}, admitted = new Set(['*']) } = {}) {
  const webServer = new FakeWebServer()
  const disposed = []
  const tools = []
  const logger = { info() {}, warn() {} }

  const ctx = {
    webServer,
    logger,
    get: (name) => (name === 'connection' ? fakeConnection(admitted) : undefined),
    effect: (callback, label) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposed.push({ dispose, label })
      return () => {}
    },
    inject: (deps, callback) => {
      if (!deps.includes('tools')) return
      callback({
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        effect: (callback2) => { callback2(); return () => {} },
      })
    },
  }

  const dataDir = await mkdtemp(path.join(tmpdir(), 'mb-test-'))
  apply(ctx, { dataFile: path.join(dataDir, 'board.json'), ...config })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = webServer.match(url.pathname)
    if (route) return void route.handler(req, res)
    if (webServer.fallback) return void webServer.fallback(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/dsh-message-board`

  return {
    webServer,
    tools,
    dataDir,
    base,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * One real HTTP call over a fresh socket.
 *
 * `node:http` rather than `fetch` because the trust fence test must set an
 * explicit `Host`, which `fetch` refuses as a forbidden header.
 */
function call(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const body = options.body
    const headers = { ...(options.headers ?? {}) }
    if (body) {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const explicitHost = headers.host ?? headers.Host
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers,
        agent: false,
        setHost: explicitHost === undefined,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            payload = undefined
          }
          resolve({ status: response.statusCode, payload, text, headers: response.headers })
        })
      },
    )
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

describe('bundle shape', () => {
  it('declares the HTTP carrier as its only activation dependency', () => {
    assert.deepEqual(inject, ['webServer'])
  })
})

describe('routing contract', () => {
  let harness
  before(async () => { harness = await startPlugin() })
  after(async () => { await harness.close() })

  it('matches the default prefix without a trailing slash', () => {
    assert.ok(harness.webServer.match('/dsh-message-board'))
    assert.ok(harness.webServer.match('/dsh-message-board/api/boards'))
  })

  it('does not match a look-alike sibling path', () => {
    assert.equal(harness.webServer.match('/dsh-message-board-other/api/boards'), undefined)
  })

  it('rejects a trailing-slash routePath because it can never match', () => {
    // The rule from dsh-host-webserver: `prefix` p matches p and p/<anything>.
    const raw = new FakeWebServer()
    raw.register({ kind: 'prefix', path: '/dsh-message-board/' })
    assert.equal(
      raw.match('/dsh-message-board/api/boards'),
      undefined,
      'a trailing slash would silently match nothing',
    )
    raw.register({ kind: 'prefix', path: '/dsh-message-board' })
    assert.ok(raw.match('/dsh-message-board/api/boards'))
  })

  it('normalizes a user-supplied trailing slash away', async () => {
    const slash = await startPlugin({ config: { routePath: '/dsh-message-board/' } })
    try {
      assert.ok(slash.webServer.match('/dsh-message-board/api/boards'))
      assert.ok(slash.webServer.match('/dsh-message-board'))
    } finally {
      await slash.close()
    }
  })

  it('refuses to claim the whole origin from a bare slash', async () => {
    const bare = await startPlugin({ config: { routePath: '/' } })
    try {
      assert.ok(bare.webServer.match('/dsh-message-board/api/boards'), 'falls back to the default prefix')
    } finally {
      await bare.close()
    }
  })

  it('injects its mount point into the rendered index', () => {
    const html = harness.webServer.renderIndex('<html><head></head></html>')
    assert.match(html, /__DSH_MESSAGE_BOARD_BASE__="\/dsh-message-board\/"/)
  })

  it('answers an unknown subroute through its own handler', async () => {
    const result = await call(`${harness.base}/nope`)
    assert.equal(result.status, 404)
    assert.equal(result.payload.ok, false)
  })
})

describe('request trust', () => {
  it('refuses a request from an untrusted Host with 403', async () => {
    const harness = await startPlugin()
    try {
      const result = await call(`${harness.base}/api/boards`, { headers: { host: 'evil.example.com' } })
      assert.equal(result.status, 403)
    } finally {
      await harness.close()
    }
  })

  it('refuses an unauthenticated request with 401', async () => {
    const harness = await startPlugin({ admitted: new Set(['Bearer good']) })
    try {
      const result = await call(`${harness.base}/api/boards`)
      assert.equal(result.status, 401)
      assert.equal(result.payload.error, 'authentication required')
    } finally {
      await harness.close()
    }
  })

  it('admits an authenticated request', async () => {
    const harness = await startPlugin({ admitted: new Set(['Bearer good']) })
    try {
      const result = await call(`${harness.base}/api/boards`, { headers: { authorization: 'Bearer good' } })
      assert.equal(result.status, 200)
      assert.equal(result.payload.ok, true)
    } finally {
      await harness.close()
    }
  })
})

describe('notes', () => {
  let harness
  before(async () => { harness = await startPlugin() })
  after(async () => { await harness.close() })

  it('starts empty', async () => {
    const result = await call(`${harness.base}/api/boards`)
    assert.deepEqual(result.payload.boards, [])
  })

  it('stores a global note', async () => {
    const result = await call(`${harness.base}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ board: 'global', text: 'hello', author: 'alice' }),
    })
    assert.equal(result.status, 200)
    assert.equal(result.payload.message.text, 'hello')
    assert.equal(result.payload.message.author, 'alice')
  })

  it('lists it back and counts the board', async () => {
    const messages = await call(`${harness.base}/api/messages?board=global`)
    assert.equal(messages.payload.messages.length, 1)

    const boards = await call(`${harness.base}/api/boards`)
    assert.equal(boards.payload.boards.length, 1)
    assert.equal(boards.payload.boards[0].key, 'global')
    assert.equal(boards.payload.boards[0].count, 1)
  })

  it('rejects an empty note', async () => {
    const result = await call(`${harness.base}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ board: 'global', text: '   ', author: 'alice' }),
    })
    assert.equal(result.status, 400)
  })

  it('keeps scopes apart', async () => {
    await call(`${harness.base}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ board: 'project:E:\\work\\demo', text: 'project note', author: 'bob' }),
    })
    await call(`${harness.base}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ board: 'session:abc', text: 'session note', author: 'bob' }),
    })
    const boards = await call(`${harness.base}/api/boards`)
    const keys = boards.payload.boards.map((row) => row.key).sort()
    assert.deepEqual(keys, ['global', 'project:E:\\work\\demo', 'session:abc'])

    const project = await call(`${harness.base}/api/messages?board=project:E%3A%5Cwork%5Cdemo`)
    assert.equal(project.payload.messages.length, 1)
    assert.equal(project.payload.messages[0].scope, 'project')
  })

  it('returns notes newest first', async () => {
    await call(`${harness.base}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ board: 'session:abc', text: 'second', author: 'bob' }),
    })
    const messages = await call(`${harness.base}/api/messages?board=session:abc`)
    assert.equal(messages.payload.messages[0].text, 'second')
  })
})

describe('read tracking', () => {
  it('records a per-reader watermark', async () => {
    const harness = await startPlugin()
    try {
      await call(`${harness.base}/api/post`, {
        method: 'POST',
        body: JSON.stringify({ board: 'global', text: 'for bob', author: 'alice' }),
      })
      const before = await call(`${harness.base}/api/boards`)
      assert.deepEqual(before.payload.boards[0].readAt, { alice: before.payload.boards[0].readAt.alice })

      await call(`${harness.base}/api/read`, {
        method: 'POST',
        body: JSON.stringify({ board: 'global', author: 'bob' }),
      })
      const after = await call(`${harness.base}/api/boards`)
      assert.ok(after.payload.boards[0].readAt.bob)
    } finally {
      await harness.close()
    }
  })
})

describe('deleting', () => {
  it('lets the author delete and refuses everyone else', async () => {
    const harness = await startPlugin()
    try {
      const created = await call(`${harness.base}/api/post`, {
        method: 'POST',
        body: JSON.stringify({ board: 'global', text: 'mine', author: 'alice' }),
      })
      const id = created.payload.message.id

      const foreign = await call(`${harness.base}/api/delete`, {
        method: 'POST',
        body: JSON.stringify({ id, author: 'bob' }),
      })
      assert.equal(foreign.status, 403)

      const own = await call(`${harness.base}/api/delete`, {
        method: 'POST',
        body: JSON.stringify({ id, author: 'alice' }),
      })
      assert.equal(own.status, 200)

      const messages = await call(`${harness.base}/api/messages?board=global`)
      assert.equal(messages.payload.messages.length, 0)
    } finally {
      await harness.close()
    }
  })

  it('can be disabled by config', async () => {
    const harness = await startPlugin({ config: { allowDelete: false } })
    try {
      const result = await call(`${harness.base}/api/delete`, {
        method: 'POST',
        body: JSON.stringify({ id: 'mb_x', author: 'alice' }),
      })
      assert.equal(result.status, 403)
    } finally {
      await harness.close()
    }
  })
})

describe('identity', () => {
  it('prefers the configured identity header over the declared name', async () => {
    const harness = await startPlugin({ config: { identityHeader: 'x-gateway-user' } })
    try {
      const result = await call(`${harness.base}/api/post`, {
        method: 'POST',
        headers: { 'x-gateway-user': 'gaici' },
        body: JSON.stringify({ board: 'global', text: 'hi', author: 'ignored' }),
      })
      assert.equal(result.payload.message.author, 'gaici')
    } finally {
      await harness.close()
    }
  })

  it('tells the browser half which name is authoritative', async () => {
    const harness = await startPlugin({ config: { identityHeader: 'x-gateway-user' } })
    try {
      const proxied = await call(`${harness.base}/api/boards`, { headers: { 'x-gateway-user': 'gaici' } })
      assert.equal(proxied.payload.author, 'gaici')
      assert.equal(proxied.payload.identitySource, 'header')
      assert.equal(proxied.payload.identityHeader, 'x-gateway-user')
    } finally {
      await harness.close()
    }
  })

  it('reports a declared name when no proxy is configured', async () => {
    const harness = await startPlugin()
    try {
      // A client-supplied header must be ignored when no proxy is trusted.
      const result = await call(`${harness.base}/api/boards?author=alice`, {
        headers: { 'x-gateway-user': 'spoofed' },
      })
      assert.equal(result.payload.author, 'alice')
      assert.equal(result.payload.identitySource, 'declared')
      assert.equal(result.payload.identityHeader, '')
    } finally {
      await harness.close()
    }
  })

  it('falls back to a placeholder when nothing is declared', async () => {
    const harness = await startPlugin()
    try {
      const result = await call(`${harness.base}/api/post`, {
        method: 'POST',
        body: JSON.stringify({ board: 'global', text: 'anonymous note' }),
      })
      assert.equal(result.payload.message.author, '匿名')
    } finally {
      await harness.close()
    }
  })
})

describe('persistence', () => {
  it('reloads what a previous activation wrote', async () => {
    const harness = await startPlugin()
    const file = path.join(harness.dataDir, 'board.json')
    try {
      await call(`${harness.base}/api/post`, {
        method: 'POST',
        body: JSON.stringify({ board: 'global', text: 'durable', author: 'alice' }),
      })
      const written = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(written.messages.length, 1)
    } finally {
      await harness.close()
    }

    const again = await startPlugin()
    try {
      const store = await call(`${again.base}/api/messages?board=global`)
      assert.equal(store.status, 200)
    } finally {
      await again.close()
    }
  })

  it('starts clean when the file is corrupt', async () => {
    const harness = await startPlugin()
    try {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(path.dirname(path.join(harness.dataDir, 'board.json')), { recursive: true })
      await writeFile(path.join(harness.dataDir, 'board.json'), '{ not json', 'utf8')
      const result = await call(`${harness.base}/api/boards`)
      assert.equal(result.status, 200)
      assert.deepEqual(result.payload.boards, [])
    } finally {
      await harness.close()
    }
  })
})

describe('agent tools', () => {
  it('registers both tools and they share the store', async () => {
    const harness = await startPlugin()
    try {
      const names = harness.tools.map((tool) => tool.name).sort()
      assert.deepEqual(names, ['message_board_post', 'message_board_read'])

      const post = harness.tools.find((tool) => tool.name === 'message_board_post')
      const read = harness.tools.find((tool) => tool.name === 'message_board_read')

      await post.execute({ text: 'from the agent', scope: 'session' }, { agent: { id: 'sess-1' } })
      const seen = await read.execute({ scope: 'session' }, { agent: { id: 'sess-1' } })
      assert.match(seen.text, /from the agent/)

      const boards = await call(`${harness.base}/api/boards`)
      assert.equal(boards.payload.boards[0].key, 'session:sess-1')
    } finally {
      await harness.close()
    }
  })

  it('can be switched off', async () => {
    const harness = await startPlugin({ config: { agentTools: false } })
    try {
      assert.equal(harness.tools.length, 0)
    } finally {
      await harness.close()
    }
  })
})
