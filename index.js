/**
 * DSH Message Board — host half.
 *
 * Owns the board store on disk, the browser HTTP API, and the optional agent
 * tools. The Client half (`./client.js`) renders the panel and talks to this
 * file through `ctx.webServer` routes, authenticated by the shared
 * `ctx.connection` browser session — the same cookie that admits `/api`.
 *
 * Zero runtime dependencies: only `node:` builtins. That is what makes the
 * package installable on any DSH profile without a build step.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Loader row/package identity. */
export const name = 'dsh-plugin-message-board'

/**
 * Activation waits for the HTTP carrier; without it this plugin has no
 * transport and stays inactive instead of throwing.
 */
export const inject = ['webServer']

/** Hard cap on a request body, so a stray upload cannot exhaust memory. */
const MAX_BODY_BYTES = 128 * 1024
/** Longest accepted note body. */
const MAX_TEXT_LENGTH = 4000
/** Longest accepted author label. */
const MAX_AUTHOR_LENGTH = 32
/** Longest accepted board label. */
const MAX_LABEL_LENGTH = 120

const SCOPE_GLOBAL = 'global'
const SCOPE_PROJECT = 'project'
const SCOPE_SESSION = 'session'

const DEFAULT_CONFIG = {
  /**
   * Prefix route registered on `ctx.webServer`. Stored without a trailing
   * slash: a prefix route matches `p` and `p/<anything>`, so a trailing slash
   * here would only ever match `p//<anything>`. `/` is refused because it would
   * claim every request.
   */
  routePath: '/dsh-message-board',
  /** Board database file. Empty means `$DSH_HOME/message-board/board.json`. */
  dataFile: '',
  /**
   * Optional request header carrying the authenticated user name, for
   * deployments that put their own authenticating proxy in front of DSH
   * (for example an HTTP basic-auth gateway). Empty disables the lookup.
   */
  identityHeader: '',
  /** Users may delete their own notes. */
  allowDelete: true,
  /** Register the `message_board_*` agent tools. */
  agentTools: true,
  /** Default author used by the agent tools. */
  agentAuthor: 'DSH Agent',
  /** Oldest notes are dropped past this count per board. */
  maxMessagesPerBoard: 2000,
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** @returns {string} a trimmed, control-character-free, length-capped label. */
function clean(value, maxLength) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped
}

/** Resolve the per-profile data directory without importing DSH internals. */
function defaultDataFile() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'message-board', 'board.json')
}

/** Normalize a raw loader `config` object onto {@link DEFAULT_CONFIG}. */
function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }
  if (typeof input.routePath === 'string' && input.routePath.startsWith('/')) {
    const trimmed = input.routePath.replace(/\/+$/, '')
    if (trimmed) config.routePath = trimmed
  }
  if (typeof input.dataFile === 'string' && input.dataFile.trim()) {
    config.dataFile = input.dataFile.trim()
  }
  if (typeof input.identityHeader === 'string') config.identityHeader = input.identityHeader.trim()
  if (typeof input.allowDelete === 'boolean') config.allowDelete = input.allowDelete
  if (typeof input.agentTools === 'boolean') config.agentTools = input.agentTools
  if (typeof input.agentAuthor === 'string' && input.agentAuthor.trim()) {
    config.agentAuthor = clean(input.agentAuthor, MAX_AUTHOR_LENGTH) || DEFAULT_CONFIG.agentAuthor
  }
  if (Number.isInteger(input.maxMessagesPerBoard) && input.maxMessagesPerBoard > 0) {
    config.maxMessagesPerBoard = input.maxMessagesPerBoard
  }
  return config
}

/** Compose the stable board key for one scope/target pair. */
function boardKey(scope, target) {
  if (scope === SCOPE_GLOBAL) return SCOPE_GLOBAL
  return `${scope}:${target}`
}

/** Split a board key back into its scope and target. */
function parseBoardKey(key) {
  if (!key || key === SCOPE_GLOBAL) return { scope: SCOPE_GLOBAL, target: '' }
  const index = key.indexOf(':')
  if (index < 0) return { scope: SCOPE_GLOBAL, target: '' }
  const scope = key.slice(0, index)
  const target = key.slice(index + 1)
  if (scope !== SCOPE_PROJECT && scope !== SCOPE_SESSION) return { scope: SCOPE_GLOBAL, target: '' }
  return { scope, target }
}

/** An empty, valid database. */
function emptyStore() {
  return { version: 1, boards: {}, messages: [] }
}

/** Coerce an arbitrary parsed file into the current store shape. */
function normalizeStore(raw) {
  const store = emptyStore()
  if (!raw || typeof raw !== 'object') return store
  if (raw.boards && typeof raw.boards === 'object') store.boards = raw.boards
  if (Array.isArray(raw.messages)) {
    store.messages = raw.messages.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        typeof entry.board === 'string' &&
        typeof entry.text === 'string',
    )
  }
  return store
}

/** One note as the API and the UI consume it. */
function publicMessage(entry) {
  return {
    id: entry.id,
    board: entry.board,
    scope: entry.scope,
    target: entry.target,
    author: entry.author,
    text: entry.text,
    createdAt: entry.createdAt,
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Activate the message board: mount the store, the HTTP API, and the tools.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the loader row's `config`, normalized here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const dataFile = config.dataFile || defaultDataFile()

  /** In-memory database, loaded once and written back through {@link persist}. */
  let store = emptyStore()
  /** Memoized first load. Deliberately outside {@link queue}: a queued
   *  operation awaits it, so it must never enqueue behind that operation. */
  let loading = null
  /** Serializes read-modify-write cycles inside this process. */
  let queue = Promise.resolve()

  /** Run one operation after every previously queued operation has settled. */
  const run = (operation) => {
    const next = queue.then(operation, operation)
    // Keep the chain alive after a failure so one bad request cannot wedge it.
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Read the database from disk once; a missing or unreadable file is empty. */
  const ensureLoaded = () => {
    if (!loading) {
      loading = (async () => {
        try {
          store = normalizeStore(JSON.parse(await readFile(dataFile, 'utf8')))
        } catch {
          store = emptyStore()
        }
      })()
    }
    return loading
  }

  const persist = async () => {
    await mkdir(path.dirname(dataFile), { recursive: true })
    const temporary = `${dataFile}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temporary, dataFile)
  }

  /** Read-modify-write one mutation atomically with respect to other requests. */
  const mutate = (operation) =>
    run(async () => {
      await ensureLoaded()
      const result = await operation(store)
      await persist()
      return result
    })

  const read = (operation) =>
    run(async () => {
      await ensureLoaded()
      return operation(store)
    })

  /** All boards, newest activity first. */
  const listBoards = () =>
    read((current) => {
      const grouped = new Map()
      for (const entry of current.messages) {
        let bucket = grouped.get(entry.board)
        if (!bucket) {
          bucket = { count: 0, lastAt: '' }
          grouped.set(entry.board, bucket)
        }
        bucket.count += 1
        if (entry.createdAt > bucket.lastAt) bucket.lastAt = entry.createdAt
      }
      const boards = []
      for (const [key, meta] of Object.entries(current.boards)) {
        const bucket = grouped.get(key)
        boards.push({
          key,
          scope: meta.scope,
          target: meta.target,
          label: meta.label ?? '',
          readAt: meta.readAt ?? {},
          count: bucket ? bucket.count : 0,
          lastAt: bucket ? bucket.lastAt : meta.createdAt ?? '',
        })
      }
      for (const [key, bucket] of grouped) {
        if (current.boards[key]) continue
        const { scope, target } = parseBoardKey(key)
        boards.push({ key, scope, target, label: '', readAt: {}, count: bucket.count, lastAt: bucket.lastAt })
      }
      boards.sort((left, right) => (left.lastAt < right.lastAt ? 1 : left.lastAt > right.lastAt ? -1 : 0))
      return boards
    })

  /** Newest-first notes of one board. */
  const listMessages = (key) =>
    read((current) =>
      current.messages
        .filter((entry) => entry.board === key)
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
        .map(publicMessage),
    )

  /**
   * Append one note, creating the board on first use.
   * @returns the stored note.
   */
  const postMessage = ({ scope, target, author, text, label }) =>
    mutate((current) => {
      const key = boardKey(scope, target)
      const at = new Date().toISOString()
      const entry = {
        id: `mb_${randomUUID()}`,
        board: key,
        scope,
        target,
        author,
        text,
        createdAt: at,
      }
      const board = current.boards[key] ?? {
        scope,
        target,
        label: '',
        createdAt: at,
        readAt: {},
      }
      if (label) board.label = label
      board.readAt = { ...board.readAt, [author]: at }
      current.boards[key] = board

      current.messages.push(entry)
      const own = current.messages.filter((candidate) => candidate.board === key)
      if (own.length > config.maxMessagesPerBoard) {
        const drop = new Set(own.slice(0, own.length - config.maxMessagesPerBoard).map((candidate) => candidate.id))
        current.messages = current.messages.filter((candidate) => !drop.has(candidate.id))
      }
      return publicMessage(entry)
    })

  /** Record that one reader has seen everything currently in a board. */
  const markRead = (key, author) =>
    mutate((current) => {
      const at = new Date().toISOString()
      const { scope, target } = parseBoardKey(key)
      const board = current.boards[key] ?? { scope, target, label: '', createdAt: at, readAt: {} }
      board.readAt = { ...board.readAt, [author]: at }
      current.boards[key] = board
      return board.readAt
    })

  /** Remove one note the caller wrote. */
  const deleteMessage = (id, author) =>
    mutate((current) => {
      const index = current.messages.findIndex((entry) => entry.id === id)
      if (index < 0) return { ok: false, reason: 'not-found' }
      if (current.messages[index].author !== author) return { ok: false, reason: 'not-owner' }
      current.messages.splice(index, 1)
      return { ok: true }
    })

  /* ---------------------------------------------------------------- *
   * HTTP API
   * ---------------------------------------------------------------- */

  /** Enforce the same Host/Origin/browser-session policy `/api` uses. */
  const rejectionFor = (req) => {
    const connection = ctx.get('connection')
    if (!connection || typeof connection.requestRejection !== 'function') return undefined
    try {
      return connection.requestRejection({ headers: req.headers })
    } catch {
      return undefined
    }
  }

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  }

  /**
   * Resolve who a request speaks for.
   *
   * A configured identity header is authoritative — a deployment that
   * authenticates its users in front of DSH knows better than the browser — and
   * wins over anything the caller declares. Otherwise the caller's own name is
   * used, which is all a single-operator instance can offer.
   */
  const resolveIdentity = (req, declared) => {
    if (config.identityHeader) {
      const raw = req.headers[config.identityHeader.toLowerCase()]
      const value = Array.isArray(raw) ? raw[0] : raw
      const fromHeader = clean(value, MAX_AUTHOR_LENGTH)
      if (fromHeader) return { author: fromHeader, source: 'header' }
    }
    return { author: clean(declared, MAX_AUTHOR_LENGTH) || '匿名', source: 'declared' }
  }

  /** Shorthand for the operations that only need the name. */
  const resolveAuthor = (req, declared) => resolveIdentity(req, declared).author

  /**
   * Dispatch one API call.
   *
   * Routes are relative to {@link DEFAULT_CONFIG.routePath}; every response is
   * JSON, and every failure keeps the same `{ ok: false, error }` envelope.
   */
  const handleRequest = async (req, res) => {
    const rejection = rejectionFor(req)
    if (rejection) {
      sendJson(res, rejection, { ok: false, error: rejection === 403 ? 'forbidden' : 'authentication required' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(config.routePath.length).replace(/^\/+/, '')
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && route === 'api/boards') {
      const identity = resolveIdentity(req, url.searchParams.get('author'))
      sendJson(res, 200, {
        ok: true,
        author: identity.author,
        // The browser half mirrors the authoritative name instead of asking for
        // it, so "mine" markers and delete keep working behind a proxy.
        identitySource: identity.source,
        identityHeader: identity.source === 'header' ? config.identityHeader : '',
        boards: await listBoards(),
      })
      return
    }

    if (method === 'GET' && route === 'api/messages') {
      const key = url.searchParams.get('board') ?? SCOPE_GLOBAL
      sendJson(res, 200, { ok: true, board: key, messages: await listMessages(key) })
      return
    }

    if (method === 'POST' && route === 'api/post') {
      const body = await readJsonBody(req)
      const text = clean(body.text, MAX_TEXT_LENGTH)
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'text is required' })
        return
      }
      const { scope, target } = parseBoardKey(typeof body.board === 'string' ? body.board : SCOPE_GLOBAL)
      const message = await postMessage({
        scope,
        target,
        author: resolveAuthor(req, body.author),
        text,
        label: clean(body.label, MAX_LABEL_LENGTH),
      })
      sendJson(res, 200, { ok: true, message })
      return
    }

    if (method === 'POST' && route === 'api/read') {
      const body = await readJsonBody(req)
      const key = typeof body.board === 'string' ? body.board : SCOPE_GLOBAL
      const readAt = await markRead(key, resolveAuthor(req, body.author))
      sendJson(res, 200, { ok: true, board: key, readAt })
      return
    }

    if (method === 'POST' && route === 'api/delete') {
      if (!config.allowDelete) {
        sendJson(res, 403, { ok: false, error: 'deleting notes is disabled' })
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const outcome = await deleteMessage(id, resolveAuthor(req, body.author))
      sendJson(res, outcome.ok ? 200 : 403, { ok: outcome.ok, error: outcome.ok ? undefined : outcome.reason })
      return
    }

    sendJson(res, 404, { ok: false, error: 'unknown message board route' })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: config.routePath,
        handler: (req, res) => {
          handleRequest(req, res).catch((error) => {
            ctx.logger?.warn?.('message board request failed: %s', error?.message ?? error)
            if (res.headersSent) {
              res.destroy()
              return
            }
            sendJson(res, 400, { ok: false, error: error?.message ?? 'bad request' })
          })
        },
      }),
    'message-board: http api',
  )

  // Tell the browser half which prefix it was mounted under, so a customized
  // `routePath` needs no matching edit in client.js.
  if (typeof ctx.webServer.tapIndex === 'function') {
    const snippet = `<script>window.__DSH_MESSAGE_BOARD_BASE__=${JSON.stringify(`${config.routePath}/`)}</script>`
    ctx.effect(
      () =>
        ctx.webServer.tapIndex((html) =>
          html.includes('</head>') ? html.replace('</head>', `${snippet}</head>`) : `${snippet}${html}`,
        ),
      'message-board: route base injection',
    )
  }

  /* ---------------------------------------------------------------- *
   * Agent tools (optional)
   * ---------------------------------------------------------------- */

  if (config.agentTools) {
    ctx.inject(['tools'], (toolsCtx) => {
      /** Map a tool call onto a concrete board, defaulting to the agent's session. */
      const boardFor = (args, fallbackSessionId) => {
        const scope = typeof args?.scope === 'string' ? args.scope : SCOPE_GLOBAL
        if (scope === SCOPE_SESSION) {
          const target = clean(args?.target, 200) || String(fallbackSessionId ?? '')
          return target ? boardKey(SCOPE_SESSION, target) : SCOPE_GLOBAL
        }
        if (scope === SCOPE_PROJECT) {
          const target = clean(args?.target, 400)
          return target ? boardKey(SCOPE_PROJECT, target) : SCOPE_GLOBAL
        }
        return SCOPE_GLOBAL
      }

      toolsCtx.effect(
        () =>
          toolsCtx.tools.register({
            name: 'message_board_read',
            description:
              'Read notes humans left on the shared DSH message board. Scope `global` reads the team board, `project` reads the board of one workspace directory, and `session` reads the board attached to one session (defaults to the current session).',
            parameters: {
              type: 'object',
              properties: {
                scope: { type: 'string', enum: [SCOPE_GLOBAL, SCOPE_PROJECT, SCOPE_SESSION], description: 'Which board to read.' },
                target: { type: 'string', description: 'Workspace path for project scope, session id for session scope. Omitted means the current session.' },
                limit: { type: 'integer', description: 'Maximum notes to return, newest first (default 20).' },
              },
              additionalProperties: false,
            },
            output: {
              schema: { type: 'object' },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
            },
            execute: async (args, exec) => {
              const key = boardFor(args, exec.agent?.id)
              const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
              const messages = (await listMessages(key)).slice(0, limit)
              if (!messages.length) {
                return { text: `The message board "${key}" is empty.`, board: key, count: 0 }
              }
              const lines = messages
                .slice()
                .reverse()
                .map((entry) => `[${entry.createdAt}] ${entry.author}: ${entry.text}`)
              return { text: `Message board "${key}" (${messages.length} shown):\n${lines.join('\n')}`, board: key, count: messages.length }
            },
          }),
        'message-board: read tool',
      )

      toolsCtx.effect(
        () =>
          toolsCtx.tools.register({
            name: 'message_board_post',
            description:
              'Leave a note on the shared DSH message board for the humans working in this deployment. Use `session` scope for notes about the current session and `project` scope for notes about a workspace.',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The note body.' },
                scope: { type: 'string', enum: [SCOPE_GLOBAL, SCOPE_PROJECT, SCOPE_SESSION], description: 'Which board to write to (default global).' },
                target: { type: 'string', description: 'Workspace path for project scope, session id for session scope. Omitted means the current session.' },
                label: { type: 'string', description: 'Optional human-facing board title to record alongside the note.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
            output: {
              schema: { type: 'object' },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
            },
            execute: async (args, exec) => {
              const text = clean(args?.text, MAX_TEXT_LENGTH)
              if (!text) return { text: 'A note needs a non-empty `text`.' }
              const key = boardFor(args, exec.agent?.id)
              const { scope, target } = parseBoardKey(key)
              const message = await postMessage({
                scope,
                target,
                author: config.agentAuthor,
                text,
                label: clean(args?.label, MAX_LABEL_LENGTH),
              })
              return { text: `Note recorded on "${key}" as ${message.author}.`, board: key, id: message.id }
            },
          }),
        'message-board: post tool',
      )
    })
  }

  ctx.logger?.info?.('message board ready: %s (store: %s)', config.routePath, dataFile)
}
