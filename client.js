/**
 * DSH Message Board — Client half.
 *
 * A browser module for the DSH Web UI. It renders three contributions:
 *
 *  - `sidebar.panellist` — the panel icon that selects the board panel.
 *  - `main`              — the board panel itself (boards, notes, composer).
 *  - `conversation.session.header.utilities` — a per-session note counter that
 *    jumps straight to that session's board.
 *
 * React comes from the browser module table (`require('react')`); no Harness
 * Client package is imported, so only theme tokens are shared with the host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-message-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace and panel identity share one name. */
    const NS = 'message-board'
    const PANEL_ID = 'message-board'
    /** Base path, overridden by the host half through an index tap. */
    const BASE = window.__DSH_MESSAGE_BOARD_BASE__ || '/dsh-message-board/'
    /** localStorage key holding this browser's display name. */
    const AUTHOR_KEY = 'dsh-message-board:author'

    const zh = {
      panel: '留言板',
      title: '留言板',
      subtitle: '在这里留下消息，彼此可见',
      scopeGlobal: '全局',
      scopeProject: '项目',
      scopeSession: '会话',
      empty: '这里还没有留言',
      emptyHint: '写下第一条，对方打开留言板时就能看到。',
      placeholder: '写下留言… 支持 Markdown（Ctrl/⌘ + Enter 发送）',
      send: '发送',
      sending: '发送中…',
      refresh: '刷新',
      del: '删除',
      confirmDelete: '删除这条留言？',
      nickname: '昵称',
      nicknamePlaceholder: '你的名字',
      nicknameSave: '保存',
      me: '我',
      read: '已读',
      unread: '未读',
      readBy: '已读：',
      noSessions: '暂无会话',
      noProjects: '暂无项目',
      loading: '加载中…',
      failed: '操作失败',
      retry: '重试',
      jumpToSession: '打开本会话的留言板',
      notes: '条留言',
      identityFrom: '署名来自认证代理：',
    }

    const en = {
      panel: 'Message Board',
      title: 'Message Board',
      subtitle: 'Leave notes here — both of you can read them',
      scopeGlobal: 'Global',
      scopeProject: 'Projects',
      scopeSession: 'Sessions',
      empty: 'No notes here yet',
      emptyHint: 'Write the first one and it is waiting when the other person opens the board.',
      placeholder: 'Write a note… Markdown supported (Ctrl/⌘ + Enter to send)',
      send: 'Send',
      sending: 'Sending…',
      refresh: 'Refresh',
      del: 'Delete',
      confirmDelete: 'Delete this note?',
      nickname: 'Name',
      nicknamePlaceholder: 'Your name',
      nicknameSave: 'Save',
      me: 'me',
      read: 'read',
      unread: 'unread',
      readBy: 'Read by: ',
      noSessions: 'No sessions',
      noProjects: 'No projects',
      loading: 'Loading…',
      failed: 'Request failed',
      retry: 'Retry',
      jumpToSession: 'Open this session’s board',
      notes: 'notes',
      identityFrom: 'Name supplied by the authenticating proxy: ',
    }

    /* ---------------------------------------------------------------- *
     * Cross-slot focus: the session button asks the panel to open a board.
     * ---------------------------------------------------------------- */

    const focusListeners = new Set()
    let focusedBoard = null

    /** Point the panel at one board and wake any mounted panel. */
    function setFocusedBoard(board) {
      focusedBoard = board
      for (const listener of focusListeners) listener(board)
    }

    /** Subscribe to focus changes from another slot entry. */
    function useFocusedBoard() {
      const [value, setValue] = React.useState(focusedBoard)
      React.useEffect(() => {
        focusListeners.add(setValue)
        setValue(focusedBoard)
        return () => {
          focusListeners.delete(setValue)
        }
      }, [])
      return value
    }

    /* ---------------------------------------------------------------- *
     * Transport
     * ---------------------------------------------------------------- */

    /** One JSON call against the host half's API. */
    async function api(route, options = {}) {
      const init = { credentials: 'same-origin', ...options }
      if (init.body !== undefined) init.headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
      const response = await fetch(`${BASE}api/${route}`, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    /** Read the locally remembered display name. */
    function readAuthor() {
      try {
        return window.localStorage.getItem(AUTHOR_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /** Remember the display name for this browser. */
    function writeAuthor(value) {
      try {
        window.localStorage.setItem(AUTHOR_KEY, value)
      } catch {
        /* storage disabled — the name simply does not persist */
      }
    }

    /** Short, locale-aware rendering of a timestamp. */
    function formatTime(iso) {
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      return at.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** Distinct directory names of every known session, newest first. */
    function projectBoards(sessions) {
      const seen = new Map()
      for (const id of sessions.ids) {
        const cwd = sessions.byId[id]?.cwd
        if (!cwd || seen.has(cwd)) continue
        seen.set(cwd, { key: `project:${cwd}`, scope: 'project', target: cwd, label: cwd })
      }
      return [...seen.values()]
    }

    /**
     * Session boards, newest first.
     *
     * Only sessions the host has actually titled are listed. `displayTitle`
     * falls back to the project basename, so an untitled (usually blank)
     * session would otherwise appear a second time under 会话, wearing the same
     * name as its project row. The session being viewed is added separately.
     */
    function sessionBoards(sessions, limit) {
      const rows = sessions.ids
        .map((id) => sessions.byId[id])
        .filter((row) => row && row.origin !== 'subagent' && row.title)
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        .slice(0, limit)
      return rows.map((row) => ({
        key: `session:${row.id}`,
        scope: 'session',
        target: row.id,
        label: row.title || row.displayTitle || row.id,
      }))
    }

    /* ---------------------------------------------------------------- *
     * Shared styles — theme tokens only, so light and dark both work.
     * ---------------------------------------------------------------- */

    const CSS = `
/* Theme tokens only. Text drawn on a \`--dsw-alias-brand-primary\` fill uses
   \`--dsw-alias-bg-base\` as its foreground: the two are inverse surfaces in both
   shipped themes, so the pairing stays legible when the theme flips. */
.dsh-mb-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-mb-head { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; }
.dsh-mb-head-title { font-size: 15px; font-weight: 600; }
.dsh-mb-head-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.dsh-mb-head-spacer { flex: 1 1 auto; }
.dsh-mb-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dsh-mb-rail { width: 230px; flex: 0 0 auto; overflow-y: auto; border-right: 1px solid var(--dsw-alias-border-l1); padding: 10px 8px; background: var(--dsw-alias-bg-layer-1); }
.dsh-mb-group { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); padding: 12px 10px 6px; }
.dsh-mb-board { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.dsh-mb-board:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-mb-board[aria-current="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsh-mb-board-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mb-badge { flex: 0 0 auto; min-width: 18px; text-align: center; font-size: 11px; line-height: 18px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dsh-mb-badge-quiet { background: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-mb-pane { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-mb-list { flex: 1 1 auto; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.dsh-mb-note { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 10px 14px; }
.dsh-mb-note-unread { border-color: var(--dsw-alias-brand-primary); }
.dsh-mb-note-meta { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-mb-note-author { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-mb-note-text { margin-top: 6px; font-size: 13px; line-height: 1.6; word-break: break-word; }
/* Rendered Markdown. Everything here is scoped to .dsh-mb-note-text so a note
   can never style the page around it. */
.dsh-mb-note-text .dsh-mb-p { margin: 0 0 8px; }
.dsh-mb-note-text .dsh-mb-p:last-child { margin-bottom: 0; }
.dsh-mb-note-text .dsh-mb-h { margin: 12px 0 6px; font-weight: 600; line-height: 1.35; }
.dsh-mb-note-text .dsh-mb-h:first-child { margin-top: 0; }
.dsh-mb-note-text h3 { font-size: 15px; }
.dsh-mb-note-text h4 { font-size: 14px; }
.dsh-mb-note-text h5, .dsh-mb-note-text h6 { font-size: 13px; }
.dsh-mb-note-text .dsh-mb-list { margin: 6px 0; padding-left: 22px; }
.dsh-mb-note-text .dsh-mb-list:last-child { margin-bottom: 0; }
.dsh-mb-note-text li { margin: 2px 0; }
.dsh-mb-note-text .dsh-mb-quote { margin: 6px 0; padding: 2px 0 2px 12px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-mb-note-text .dsh-mb-hr { margin: 10px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-mb-note-text .dsh-mb-pre { margin: 8px 0; padding: 10px 12px; border-radius: 8px; overflow-x: auto; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-mb-note-text .dsh-mb-pre:last-child { margin-bottom: 0; }
.dsh-mb-note-text .dsh-mb-code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; }
.dsh-mb-note-text .dsh-mb-pre .dsh-mb-code { font-size: 12px; line-height: 1.55; }
.dsh-mb-note-text :not(pre) > .dsh-mb-code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-mb-note-text a { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 2px; }
.dsh-mb-note-text strong { font-weight: 600; }
.dsh-mb-note-foot { margin-top: 8px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-mb-link { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: 5px; }
.dsh-mb-link:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-mb-empty { margin: auto; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-mb-composer { flex: 0 0 auto; border-top: 1px solid var(--dsw-alias-border-l1); padding: 12px 20px 16px; display: flex; gap: 10px; align-items: flex-end; }
.dsh-mb-textarea { flex: 1 1 auto; resize: none; min-height: 62px; max-height: 200px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 1.5; }
.dsh-mb-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-mb-btn { flex: 0 0 auto; padding: 9px 16px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.dsh-mb-btn:disabled { opacity: .5; cursor: default; }
.dsh-mb-btn-ghost { background: transparent; color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); font-weight: 500; }
.dsh-mb-btn-ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-mb-input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; width: 130px; }
.dsh-mb-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-mb-error { margin: 0 20px 10px; padding: 8px 12px; border-radius: 8px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-mb-name { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-mb-session { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-mb-session:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-mb-session-active { color: var(--dsw-alias-brand-primary); }
`

    /** Renders the stylesheet as an element so unmounting removes it. */
    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /* ---------------------------------------------------------------- *
     * Icons — drawn locally; no Harness Client package is imported.
     * ---------------------------------------------------------------- */

    /** Panel glyph: a pinned note. */
    function MessageBoardIcon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.9 },
        },
        h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2.5 }),
        h('path', { d: 'M7 8h10M7 11.5h6' }),
        h('path', { d: 'M12 17v4' }),
      )
    }

    /* ---------------------------------------------------------------- *
     * Markdown
     *
     * Notes are written by people, so they get a small Markdown subset. It
     * renders to React elements rather than to an HTML string: every scrap of
     * user text stays a text node, so there is no escaping step to forget and
     * no way for a note to inject markup. Link targets are matched against a
     * scheme allowlist, and anything else is shown as plain text.
     * ---------------------------------------------------------------- */

    /* --- markdown:start --- */

    /** Only these schemes may become a link; everything else stays text. */
    const SAFE_LINK = /^(?:https?:\/\/|mailto:)\S+$/i

    /** Italic/bold/strike/code/link markers, tried in that order per position. */
    const INLINE_SOURCE = '(`+)([\\s\\S]*?)\\1|\\*\\*([\\s\\S]+?)\\*\\*|__([\\s\\S]+?)__|~~([\\s\\S]+?)~~|\\*([^*\\n]+?)\\*|\\[([^\\]]*)\\]\\(([^)\\s]+)\\)|(https?:\\/\\/[^\\s<>()[\\]`*_]+)'

    /**
     * One line of inline Markdown into an array of React nodes.
     *
     * The pattern is built per call rather than shared: `renderInline` recurses
     * into emphasis and link text, and a single global regex would have its
     * `lastIndex` reset by the inner call, stranding the outer scan.
     *
     * @param source - the line.
     * @param prefix - key prefix, unique per rendered block.
     */
    function renderInline(source, prefix) {
      const pattern = new RegExp(INLINE_SOURCE, 'g')
      const nodes = []
      let cursor = 0
      let seq = 0
      const key = () => `${prefix}-${seq++}`
      let match
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
        if (match[2] !== undefined) {
          nodes.push(h('code', { key: key(), className: 'dsh-mb-code' }, match[2].trim()))
        } else if (match[3] !== undefined) {
          nodes.push(h('strong', { key: key() }, renderInline(match[3], key())))
        } else if (match[4] !== undefined) {
          nodes.push(h('strong', { key: key() }, renderInline(match[4], key())))
        } else if (match[5] !== undefined) {
          nodes.push(h('del', { key: key() }, renderInline(match[5], key())))
        } else if (match[6] !== undefined) {
          nodes.push(h('em', { key: key() }, renderInline(match[6], key())))
        } else if (match[7] !== undefined) {
          const url = match[8]
          if (SAFE_LINK.test(url)) {
            nodes.push(
              h('a', { key: key(), href: url, target: '_blank', rel: 'noreferrer noopener' },
                renderInline(match[7] || url, key())),
            )
          } else {
            // Not a scheme we will link: keep the original characters verbatim.
            nodes.push(source.slice(match.index, pattern.lastIndex))
          }
        } else {
          nodes.push(h('a', { key: key(), href: match[9], target: '_blank', rel: 'noreferrer noopener' }, match[9]))
        }
        cursor = pattern.lastIndex
        // A zero-length match would spin forever; every alternative consumes at
        // least one character, but guard anyway.
        if (pattern.lastIndex === match.index) pattern.lastIndex += 1
      }
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    /** Whether a line would start a block other than a paragraph. */
    function startsBlock(line) {
      return /^\s*(?:```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(line)
        || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    }

    /**
     * A note's Markdown into an array of block React nodes.
     *
     * A single newline is kept as a hard break, the way people write in a
     * message box, rather than joined the way CommonMark joins a paragraph.
     * Headings are demoted by two levels: a note is not a document, and an
     * `<h1>` inside one would fight the page it sits in.
     */
    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let i = 0
      let seq = 0
      const key = () => `md${seq++}`

      while (i < lines.length) {
        const line = lines[i]

        const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(line)
        if (fence) {
          const body = []
          i += 1
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(
            h('pre', { key: key(), className: 'dsh-mb-pre' },
              h('code', { className: fence[1] ? `dsh-mb-code language-${fence[1]}` : 'dsh-mb-code' }, body.join('\n'))),
          )
          continue
        }

        if (!line.trim()) {
          i += 1
          continue
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: key(), className: 'dsh-mb-hr' }))
          i += 1
          continue
        }

        const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = Math.min(heading[1].length + 2, 6)
          blocks.push(h(`h${level}`, { key: key(), className: 'dsh-mb-h' }, renderInline(heading[2], key())))
          i += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: key(), className: 'dsh-mb-quote' }, ...renderInline(body.join('\n'), key())))
          continue
        }

        const unordered = /^\s*[-*+]\s+(.*)$/
        const ordered = /^\s*\d+[.)]\s+(.*)$/
        if (unordered.test(line) || ordered.test(line)) {
          const pattern = ordered.test(line) ? ordered : unordered
          const items = []
          while (i < lines.length) {
            const item = pattern.exec(lines[i])
            if (!item) break
            items.push(h('li', { key: key() }, renderInline(item[1], key())))
            i += 1
          }
          blocks.push(h(pattern === ordered ? 'ol' : 'ul', { key: key(), className: 'dsh-mb-list' }, items))
          continue
        }

        const body = []
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
          body.push(lines[i])
          i += 1
        }
        if (body.length === 0) {
          body.push(line)
          i += 1
        }
        const children = []
        body.forEach((text, index) => {
          if (index > 0) children.push(h('br', { key: key() }))
          children.push(...renderInline(text, key()))
        })
        blocks.push(h('p', { key: key(), className: 'dsh-mb-p' }, children))
      }
      return blocks
    }

    /* --- markdown:end --- */

    /** Render a note, falling back to plain text rather than losing it. */
    function renderNote(text) {
      try {
        return renderMarkdown(text)
      } catch {
        return text
      }
    }

    /* ---------------------------------------------------------------- *
     * Panel
     * ---------------------------------------------------------------- */

    /** Group boards by scope, merging catalog rows with stored activity. */
    function buildGroups(storeBoards, sessions, focused) {
      const byKey = new Map(storeBoards.map((row) => [row.key, row]))
      const merge = (candidate) => {
        const stored = byKey.get(candidate.key)
        if (stored) {
          byKey.set(candidate.key, {
            ...stored,
            label: candidate.label || stored.label,
            scope: candidate.scope,
            target: candidate.target,
          })
        } else {
          byKey.set(candidate.key, { ...candidate, count: 0, readAt: {}, lastAt: '' })
        }
      }

      if (sessions) {
        // Titled sessions, whether or not they hold notes yet: a board has to be
        // reachable *before* someone writes in it, or the panel can never start
        // one. Older sessions still show up through their stored boards.
        for (const row of sessionBoards(sessions, 15)) merge(row)
        for (const row of projectBoards(sessions)) merge(row)
        // The session being looked at is listed even when it falls outside that
        // window, because the header button focuses it.
        const focusId = String(focused ?? '').startsWith('session:') ? String(focused).slice(8) : ''
        const focusRow = focusId ? sessions.byId?.[focusId] : undefined
        if (focusRow) {
          merge({
            key: `session:${focusId}`,
            scope: 'session',
            target: focusId,
            label: focusRow.title || focusRow.displayTitle || focusId,
          })
        }
      }

      const all = [...byKey.values()]
      const global = all.filter((row) => row.scope === 'global')
      return [
        {
          scope: 'global',
          rows: global.length
            ? global
            : [{ key: 'global', scope: 'global', target: '', label: '', count: 0, readAt: {}, lastAt: '' }],
        },
        { scope: 'project', rows: all.filter((row) => row.scope === 'project').sort(sortRows) },
        { scope: 'session', rows: all.filter((row) => row.scope === 'session').sort(sortRows) },
      ]
    }

    /** Most recent activity first. */
    function sortRows(left, right) {
      return (left.lastAt ?? '') < (right.lastAt ?? '') ? 1 : (left.lastAt ?? '') > (right.lastAt ?? '') ? -1 : 0
    }

    /** How many notes of one board this reader has not seen. */
    function unreadCount(row, author) {
      if (!author || !row.lastAt) return 0
      const seen = row.readAt?.[author]
      return !seen || row.lastAt > seen ? 1 : 0
    }

    /** Short label for a board row. */
    function boardLabel(row, t) {
      if (row.scope === 'global') return t('scopeGlobal')
      if (!row.label) {
        // A board stored before its session had a title: show a short id rather
        // than a raw uuid, and never an empty row.
        const id = String(row.target ?? '')
        if (row.scope !== 'session') return id || t('scopeProject')
        return id.length > 14 ? `${id.slice(0, 14)}…` : id || t('scopeSession')
      }
      if (row.scope === 'project') {
        const parts = String(row.label).split(/[\\/]+/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : row.label
      }
      return row.label
    }

    /** Pass-through used when a slot supplies no Session source. */
    const NO_SESSIONS = () => undefined

    /** The full-page board panel registered under the `main` slot. */
    function MessageBoardPage(props) {
      const t = props.t
      // Always one call site, so the hook order never depends on the props.
      const sessionState = (props.useSessions ?? NO_SESSIONS)((state) => state)
      const [author, setAuthor] = React.useState(() => readAuthor())
      const [draftAuthor, setDraftAuthor] = React.useState(() => readAuthor())
      const [boards, setBoards] = React.useState([])
      // Default to the global board: on a brand-new install there are no boards
      // yet, and a null selection would make the first note impossible to post.
      const [selected, setSelected] = React.useState(() => focusedBoard ?? 'global')
      const [messages, setMessages] = React.useState([])
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [loaded, setLoaded] = React.useState(false)
      // Where the display name comes from. `header` means a proxy in front of
      // DSH told us who this is, and the field becomes read-only.
      const [identity, setIdentity] = React.useState({ source: 'declared', header: '' })
      const focusBoard = useFocusedBoard()

      const groups = React.useMemo(
        () => buildGroups(boards, sessionState, focusBoard ?? selected),
        [boards, sessionState, focusBoard, selected],
      )

      const refreshBoards = React.useCallback(async () => {
        try {
          const payload = await api(`boards?author=${encodeURIComponent(author)}`)
          setBoards(payload.boards ?? [])
          setIdentity({ source: payload.identitySource ?? 'declared', header: payload.identityHeader ?? '' })
          // Adopt the authoritative name: without it, this reader would not
          // recognise their own notes as theirs.
          if (payload.identitySource === 'header' && payload.author && payload.author !== author) {
            writeAuthor(payload.author)
            setAuthor(payload.author)
            setDraftAuthor(payload.author)
          }
          setError('')
        } catch (cause) {
          setError(String(cause.message ?? cause))
        }
      }, [author])

      const loadMessages = React.useCallback(
        async (key, who) => {
          try {
            const payload = await api(`messages?board=${encodeURIComponent(key)}`)
            setMessages(payload.messages ?? [])
            setError('')
            if (who) await api('read', { method: 'POST', body: JSON.stringify({ board: key, author: who }) })
          } catch (cause) {
            setError(String(cause.message ?? cause))
          } finally {
            setLoaded(true)
          }
        },
        [],
      )

      // Follow an explicit request from the session button.
      React.useEffect(() => {
        if (focusBoard) setSelected(focusBoard)
      }, [focusBoard])

      // First load of the board index.
      React.useEffect(() => {
        refreshBoards().then(() => setLoaded(true))
      }, [refreshBoards])

      // Reload notes whenever the board or reader changes.
      React.useEffect(() => {
        if (!selected) return
        loadMessages(selected, author)
      }, [selected, author, loadMessages])

      // Light poll so a note from the other person arrives on its own.
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          refreshBoards()
          if (selected) loadMessages(selected, null)
        }, 15000)
        return () => window.clearInterval(timer)
      }, [refreshBoards, loadMessages, selected])

      const submit = React.useCallback(async () => {
        const body = text.trim()
        if (!body || !selected || busy) return
        if (!author) {
          setError(t('nicknamePlaceholder'))
          return
        }
        setBusy(true)
        try {
          const label = groups
            .flatMap((group) => group.rows)
            .find((row) => row.key === selected)?.label
          await api('post', {
            method: 'POST',
            body: JSON.stringify({ board: selected, text: body, author, label }),
          })
          setText('')
          await loadMessages(selected, author)
          await refreshBoards()
        } catch (cause) {
          setError(String(cause.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [text, selected, busy, author, groups, loadMessages, refreshBoards, t])

      const remove = React.useCallback(
        async (id) => {
          if (!window.confirm(t('confirmDelete'))) return
          try {
            await api('delete', { method: 'POST', body: JSON.stringify({ id, author }) })
            await loadMessages(selected, author)
            await refreshBoards()
          } catch (cause) {
            setError(String(cause.message ?? cause))
          }
        },
        [author, selected, loadMessages, refreshBoards, t],
      )

      const saveAuthor = React.useCallback(() => {
        if (identity.source === 'header') return
        const next = draftAuthor.trim()
        writeAuthor(next)
        setAuthor(next)
      }, [draftAuthor, identity.source])

      const fromProxy = identity.source === 'header'

      const currentRow = groups.flatMap((group) => group.rows).find((row) => row.key === selected)

      const rail = h(
        'div',
        { className: 'dsh-mb-rail' },
        groups.map((group) =>
          h(
            'div',
            { key: group.scope },
            h('div', { className: 'dsh-mb-group' }, t(`scope${group.scope[0].toUpperCase()}${group.scope.slice(1)}`)),
            group.rows.length === 0
              ? h(
                  'div',
                  { className: 'dsh-mb-group', style: { textTransform: 'none', letterSpacing: 0, paddingTop: 0 } },
                  t(group.scope === 'project' ? 'noProjects' : 'noSessions'),
                )
              : group.rows.map((row) =>
                  h(
                    'button',
                    {
                      key: row.key,
                      type: 'button',
                      className: 'dsh-mb-board',
                      'aria-current': row.key === selected ? 'true' : undefined,
                      title: row.target,
                      onClick: () => {
                        setFocusedBoard(row.key)
                        setSelected(row.key)
                        if (author) api('read', { method: 'POST', body: JSON.stringify({ board: row.key, author }) }).then(refreshBoards, () => {})
                      },
                    },
                    h(MessageBoardIcon, { size: 15, active: row.key === selected }),
                    h('span', { className: 'dsh-mb-board-label' }, boardLabel(row, t)),
                    h(
                      'span',
                      {
                        className: row.count ? 'dsh-mb-badge' : 'dsh-mb-badge dsh-mb-badge-quiet',
                        style: !row.count ? { visibility: 'hidden' } : undefined,
                      },
                      String(row.count),
                    ),
                  ),
                ),
          ),
        ),
      )

      const list = h(
        'div',
        { className: 'dsh-mb-list' },
        messages.length === 0
          ? h(
              'div',
              { className: 'dsh-mb-empty' },
              h('div', null, t(loaded ? 'empty' : 'loading')),
              loaded ? h('div', { style: { marginTop: 6, fontSize: 12 } }, t('emptyHint')) : null,
            )
          : messages.map((message) => {
              const mine = author && message.author === author
              const readers = currentRow
                ? Object.entries(currentRow.readAt ?? {})
                    .filter(([who, at]) => who !== message.author && at >= message.createdAt)
                    .map(([who]) => who)
                : []
              const unread = !mine && currentRow?.readAt?.[author] && currentRow.readAt[author] < message.createdAt
              return h(
                'div',
                { key: message.id, className: unread ? 'dsh-mb-note dsh-mb-note-unread' : 'dsh-mb-note' },
                h(
                  'div',
                  { className: 'dsh-mb-note-meta' },
                  h('span', { className: 'dsh-mb-note-author' }, `${message.author}${mine ? ` (${t('me')})` : ''}`),
                  h('span', null, formatTime(message.createdAt)),
                  unread ? h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, t('unread')) : null,
                ),
                h('div', { className: 'dsh-mb-note-text' }, renderNote(message.text)),
                h(
                  'div',
                  { className: 'dsh-mb-note-foot' },
                  mine ? h('span', null, `${readers.length ? `✓ ${t('readBy')}${readers.join('、')}` : '· ' + t('unread')}`) : null,
                  h('span', { style: { flex: '1 1 auto' } }),
                  mine ? h('button', { type: 'button', className: 'dsh-mb-link', onClick: () => remove(message.id) }, t('del')) : null,
                ),
              )
            }),
      )

      const composer = h(
        'div',
        { className: 'dsh-mb-composer' },
        h('textarea', {
          className: 'dsh-mb-textarea',
          value: text,
          placeholder: t('placeholder'),
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          },
        }),
        h('button', { type: 'button', className: 'dsh-mb-btn', disabled: busy || !text.trim(), onClick: submit }, busy ? t('sending') : t('send')),
      )

      return h(
        'div',
        { className: 'dsh-mb-root' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-mb-head' },
          h(
            'div',
            null,
            h('div', { className: 'dsh-mb-head-title' }, t('title')),
            h('div', { className: 'dsh-mb-head-sub' }, t('subtitle')),
          ),
          h('div', { className: 'dsh-mb-head-spacer' }),
          h(
            'label',
            { className: 'dsh-mb-name' },
            t('nickname'),
            h('input', {
              className: 'dsh-mb-input',
              value: draftAuthor,
              readOnly: fromProxy,
              title: fromProxy ? `${t('identityFrom')}${identity.header}` : undefined,
              placeholder: t('nicknamePlaceholder'),
              onChange: (event) => setDraftAuthor(event.target.value),
              onBlur: saveAuthor,
              onKeyDown: (event) => {
                if (event.key === 'Enter') saveAuthor()
              },
            }),
          ),
          h('button', { type: 'button', className: 'dsh-mb-btn dsh-mb-btn-ghost', onClick: () => { refreshBoards(); if (selected) loadMessages(selected, author) } }, t('refresh')),
        ),
        error ? h('div', { className: 'dsh-mb-error' }, `${t('failed')}: ${error}`) : null,
        h('div', { className: 'dsh-mb-body' }, rail, h('div', { className: 'dsh-mb-pane' }, list, composer)),
      )
    }

    /* ---------------------------------------------------------------- *
     * Session header button
     * ---------------------------------------------------------------- */

    /** Per-session shortcut showing how many notes that board holds. */
    function SessionBoardButton(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [count, setCount] = React.useState(null)

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const board = `session:${sessionId}`
        const pull = () => {
          api(`messages?board=${encodeURIComponent(board)}`)
            .then((payload) => {
              if (alive) setCount((payload.messages ?? []).length)
            })
            .catch(() => {})
        }
        pull()
        const timer = window.setInterval(pull, 20000)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [sessionId])

      if (!sessionId) return null

      return h(
        'button',
        {
          type: 'button',
          className: count ? 'dsh-mb-session dsh-mb-session-active' : 'dsh-mb-session',
          title: t('jumpToSession'),
          onClick: () => {
            setFocusedBoard(`session:${sessionId}`)
            props.openPanel()
          },
        },
        h(MessageBoardIcon, { size: 14 }),
        h('span', null, count ? String(count) : t('panel')),
      )
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'message-board: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'message-board: en dictionary')

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel'),
              locale: NS,
            },
            MessageBoardIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            MessageBoardPage,
          ),
        )

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: PANEL_ID,
              order: 30,
              locale: NS,
              inject: () => ({
                openPanel: () => ctx.layout.selectPanel(PANEL_ID),
              }),
            },
            SessionBoardButton,
          ),
        )
      },
    }
  },
})
