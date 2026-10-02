/**
 * Markdown renderer tests.
 *
 * The renderer lives inside `client.js`, which is a browser artifact with no
 * module graph of its own. Rather than duplicate it here, these tests extract
 * the block between the `markdown:start` / `markdown:end` markers from the real
 * shipped file and evaluate it against a stub `createElement`. What is asserted
 * is therefore the code that actually runs in the browser.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

/** Minimal stand-in for `React.createElement`, returning a plain tree. */
function h(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    flat.push(value)
  }
  for (const child of children) push(child)
  return { type, props: props ?? {}, children: flat }
}

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('/* --- markdown:start --- */')
const end = source.indexOf('/* --- markdown:end --- */')
assert.ok(start > 0 && end > start, 'the markdown block markers must exist in client.js')
const block = source.slice(start, end)
const { renderMarkdown } = new Function('h', `${block}\nreturn { renderMarkdown }`)(h)

/** All text of a tree, concatenated. Accepts nodes, arrays and strings. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return textOf(node.children)
}

/** Every element type used anywhere in a tree. */
function typesOf(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) typesOf(child, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  found.add(node.type)
  return typesOf(node.children, found)
}

/** The first element of a given type, depth first. */
function first(node, type) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = first(child, type)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  if (node.type === type) return node
  return first(node.children, type)
}

describe('blocks', () => {
  it('renders a paragraph as one block', () => {
    const blocks = renderMarkdown('hello world')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'p')
    assert.equal(textOf(blocks[0]), 'hello world')
  })

  it('keeps a single newline as a hard break, the way a message box works', () => {
    const blocks = renderMarkdown('line one\nline two')
    assert.equal(blocks.length, 1)
    assert.deepEqual(blocks[0].children.map((c) => (typeof c === 'string' ? c : c.type)), ['line one', 'br', 'line two'])
  })

  it('splits on a blank line', () => {
    const blocks = renderMarkdown('first\n\nsecond')
    assert.equal(blocks.length, 2)
    assert.equal(textOf(blocks[0]), 'first')
    assert.equal(textOf(blocks[1]), 'second')
  })

  it('demotes headings so a note cannot outrank the page', () => {
    assert.equal(renderMarkdown('# Title')[0].type, 'h3')
    assert.equal(renderMarkdown('### Title')[0].type, 'h5')
    assert.equal(renderMarkdown('###### Title')[0].type, 'h6')
  })

  it('renders unordered and ordered lists', () => {
    const ul = renderMarkdown('- one\n- two')[0]
    assert.equal(ul.type, 'ul')
    assert.deepEqual(ul.children.map((li) => textOf(li)), ['one', 'two'])

    const ol = renderMarkdown('1. one\n2. two')[0]
    assert.equal(ol.type, 'ol')
    assert.deepEqual(ol.children.map((li) => textOf(li)), ['one', 'two'])
  })

  it('renders a blockquote and a rule', () => {
    assert.equal(renderMarkdown('> quoted')[0].type, 'blockquote')
    assert.equal(renderMarkdown('---')[0].type, 'hr')
  })

  it('keeps a fenced block verbatim, markers and all', () => {
    const blocks = renderMarkdown(['```js', 'const a = **1**', '// - not a list', '```'].join('\n'))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'pre')
    assert.equal(textOf(blocks[0]), 'const a = **1**\n// - not a list')
    assert.equal(first(blocks[0], 'code').props.className, 'dsh-mb-code language-js')
  })

  it('tolerates an unterminated fence', () => {
    const blocks = renderMarkdown('```\nno closing fence')
    assert.equal(blocks[0].type, 'pre')
    assert.equal(textOf(blocks[0]), 'no closing fence')
  })
})

describe('inline', () => {
  it('renders emphasis', () => {
    assert.ok(first(renderMarkdown('**bold**')[0], 'strong'))
    assert.ok(first(renderMarkdown('*italic*')[0], 'em'))
    assert.ok(first(renderMarkdown('~~gone~~')[0], 'del'))
    assert.ok(first(renderMarkdown('`code`')[0], 'code'))
  })

  it('nests inline markup inside emphasis', () => {
    const strong = first(renderMarkdown('**bold with `code`**')[0], 'strong')
    assert.ok(first(strong, 'code'))
    assert.equal(textOf(strong), 'bold with code')
  })

  it('leaves a lone asterisk as text', () => {
    assert.equal(textOf(renderMarkdown('2 * 3 = 6')[0]), '2 * 3 = 6')
  })

  it('leaves snake_case alone', () => {
    assert.equal(textOf(renderMarkdown('a snake_case_name here')[0]), 'a snake_case_name here')
    assert.equal(typesOf(renderMarkdown('a snake_case_name here')[0]).has('em'), false)
  })
})

describe('links', () => {
  it('renders an http link', () => {
    const anchor = first(renderMarkdown('[docs](https://example.com/a)')[0], 'a')
    assert.equal(anchor.props.href, 'https://example.com/a')
    assert.equal(anchor.props.rel, 'noreferrer noopener')
    assert.equal(textOf(anchor), 'docs')
  })

  it('autolinks a bare URL', () => {
    const anchor = first(renderMarkdown('see https://example.com/x now')[0], 'a')
    assert.equal(anchor.props.href, 'https://example.com/x')
  })

  it('refuses to link a dangerous scheme and keeps the literal text', () => {
    const tree = renderMarkdown('[click](javascript:alert(1))')[0]
    assert.equal(typesOf(tree).has('a'), false)
    assert.equal(textOf(tree), '[click](javascript:alert(1))')
  })

  it('refuses a data: URL', () => {
    assert.equal(typesOf(renderMarkdown('[x](data:text/html,<b>hi</b>)')[0]).has('a'), false)
  })
})

describe('notes cannot inject markup', () => {
  it('keeps an img/onerror payload as text', () => {
    const tree = renderMarkdown('<img src=x onerror="alert(1)">')[0]
    assert.equal(typesOf(tree).has('img'), false)
    assert.equal(textOf(tree), '<img src=x onerror="alert(1)">')
  })

  it('keeps a script tag as text', () => {
    const tree = renderMarkdown('<script>alert(1)</script>')[0]
    assert.equal(typesOf(tree).has('script'), false)
    assert.equal(textOf(tree), '<script>alert(1)</script>')
  })

  it('never emits raw HTML for a markup-looking note', () => {
    const allowed = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'h3', 'h4', 'h5', 'h6'])
    const tree = renderMarkdown('# h\n<b>x</b>\n- <i>y</i>\n\n```\n<div>\n```')
    for (const type of typesOf(tree)) {
      assert.ok(allowed.has(type), `unexpected element type: ${type}`)
    }
  })
})

describe('robustness', () => {
  it('handles empty and non-string input', () => {
    assert.deepEqual(renderMarkdown(''), [])
    assert.deepEqual(renderMarkdown(null), [])
    assert.deepEqual(renderMarkdown(undefined), [])
  })

  it('normalizes CRLF', () => {
    assert.equal(textOf(renderMarkdown('a\r\nb')[0]), 'ab')
  })

  it('does not loop forever on a line that starts a block', () => {
    const blocks = renderMarkdown('- a\n\n> b\n\n```\nc\n```')
    assert.deepEqual(blocks.map((b) => b.type), ['ul', 'blockquote', 'pre'])
  })
})
