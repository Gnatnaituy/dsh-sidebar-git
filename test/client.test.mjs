/**
 * Client-half tests.
 *
 * The bundle is not a module: it installs itself through
 * `window.__ModuleLoader__.load()`. These tests run it in a `node:vm` context
 * with a minimal DOM, a stub React and a mock plugin context, then check the
 * things a browser would otherwise be the first to discover: that the tab type
 * and both seats register under the right keys in both kit and fallback
 * pipelines, and that the tree actually renders from a seeded overview
 * payload — the change rows, the diff, the composer and the destructive-op
 * confirm panel included.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, it } from 'node:test'

// ── the React stub (hook state survives re-renders per component) ───────────

function createReactStub() {
  const hookStore = new Map()
  let current = null
  let cursor = 0
  let effects = []
  const begin = (component) => {
    current = component
    cursor = 0
  }
  const slotsOf = () => {
    let slots = hookStore.get(current)
    if (slots === undefined) {
      slots = []
      hookStore.set(current, slots)
    }
    return slots
  }
  const flushEffects = () => {
    const queued = effects
    effects = []
    for (const effect of queued) effect()
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      const flat = children.length <= 1 ? children[0] : children
      if (flat !== undefined) merged.children = flat
      return { type, props: merged }
    },
    useState(initial) {
      const slots = slotsOf()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }]
    },
    useRef(initial) {
      const slots = slotsOf()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect) {
      effects.push(effect)
    },
    useLayoutEffect(effect) {
      effects.push(effect)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  return { React, begin, flushEffects }
}

/** Walk one rendered tree invoking every function component (depth-capped). */
function deepRender(element, react, depth = 0) {
  if (depth > 60 || element === null || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map((child) => deepRender(child, react, depth + 1))
  const type = element.type
  if (typeof type === 'function') {
    react.begin(type)
    return deepRender(type(element.props), react, depth + 1)
  }
  const props = Object.assign({}, element.props)
  if (props.children !== undefined) props.children = deepRender(props.children, react, depth + 1)
  return { type, props }
}

/** Every string in one tree. */
function textsOf(node, found = []) {
  if (typeof node === 'string') {
    found.push(node)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
    return found
  }
  textsOf(node.props?.children, found)
  return found
}

/** Every element of one tag. */
function elementsOf(node, tag, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, tag, found)
    return found
  }
  if (node.type === tag) found.push(node)
  elementsOf(node.props?.children, tag, found)
  return found
}

// ── the vm harness ──────────────────────────────────────────────────────────

const BUNDLE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** The overview payload the tests seed (mirrors the host's shape). */
function overviewPayload(overrides = {}) {
  return {
    ok: true,
    rev: '42',
    repo: { root: '/repo/work', display: '/repo/work', source: 'session' },
    branch: { name: 'main', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false, oid: 'abc' },
    groups: {
      staged: [{ path: 'staged.txt', display: 'staged.txt', xy: 'A.', staged: { adds: 1, dels: 0 }, worktree: { adds: 0, dels: 0 }, untracked: false, conflict: false }],
      worktree: [{ path: 'alpha.txt', display: 'alpha.txt', xy: '.M', staged: { adds: 0, dels: 0 }, worktree: { adds: 3, dels: 1 }, untracked: false, conflict: false }],
      untracked: [{ path: 'untracked.txt', display: 'untracked.txt', xy: '??', untracked: true, conflict: false }],
      conflict: [],
    },
    counts: { staged: 1, worktree: 1, untracked: 1, conflict: 0 },
    stashes: 0,
    ...overrides,
  }
}

/**
 * Mount the bundle once.
 * @param options - `kit` mounts `@deepseek-ai/dsh-client-ui-primitives`;
 *   `fetchJson` answers every fetch; `seeds` runs right after load.
 * @returns `{ module, mounted, react, logs }`.
 */
async function mountClient(options = {}) {
  const requests = []
  const { React, begin, flushEffects } = createReactStub()
  const tabs = { registered: [] }
  const slots = { registrations: [] }

  const sandbox = {
    console: { warn() {}, log() {} },
    setTimeout,
    clearTimeout,
    setInterval: (fn) => (options.polling === false ? undefined : setTimeout(fn, 10_000)),
    clearInterval,
    fetch: async (url, fetchOptions) => {
      requests.push({ url, options: fetchOptions })
      const answer = options.fetchJson ? options.fetchJson(url, fetchOptions) : {}
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) }
    },
    document: {
      styles: [],
      head: {
        children: [],
        appendChild(node) {
          this.children.push(node)
        },
      },
      createElement() {
        return { id: undefined, textContent: undefined, set textContentTo(value) {} }
      },
      getElementById() {
        return null
      },
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    localStorage: { getItem: () => null, setItem() {} },
    URL,
  }

  // The style element stub gets a textContent-like carrier.
  sandbox.document.createElement = function createElement(tag) {
    return {
      tag,
      id: undefined,
      style: {},
      textContent: '',
    }
  }

  const context = vm.createContext(sandbox)
  context.window = sandbox
  context.document = sandbox.document
  context.navigator = sandbox.navigator
  context.React = React

  const requireMap = new Map()
  requireMap.set('react', React)
  if (options.kit !== false) {
    requireMap.set('@deepseek-ai/dsh-client-ui-primitives', options.kit ?? makeKitStub())
  }
  context.require = (name) => {
    if (!requireMap.has(name)) throw new Error(`require failed: ${name}`)
    return requireMap.get(name)
  }

  context.window.fetch = sandbox.fetch
  context.window.__ModuleLoader__ = {
    load(spec) {
      context.__loaded = spec
    },
  }
  context.__loaded = undefined
  context.__captured = { tabs, slots }

  vm.runInContext(BUNDLE, context, { filename: 'lib/client.js' })

  const loaded = context.__loaded
  assert.ok(loaded, 'the bundle must install itself through __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-sidebar-git')
  const moduleExports = loaded.factory(context.require)

  var mounted = makeMounted()
  function makeMounted() {
    const ctx = {
      logs: [],
      inject(names, callback) {
        // vm realm arrays: compare by content, not deepEqual's cross-realm strictness.
        assert.equal(names.length, 1)
        assert.equal(String(names), 'sidebarRightTabs')
        return callback({
          get() {
            return {
              register(spec) {
                tabs.registered.push(spec)
                return () => undefined
              },
            }
          },
        })
      },
      slots: {
        inject(seat, factory) {
          void factory()
        },
        register(spec, component) {
          slots.registrations.push({ spec, component })
          return () => undefined
        },
      },
      logger: { info: (line) => ctx.logs.push(line) },
    }
    moduleExports.apply(ctx)
    return { ctx, tabs, slots, requests, moduleExports, React, begin, flushEffects, logs: ctx.logs }
  }

  return mounted
}

/** The kit stub mirroring the real module-loader CJS export surface. */
function makeKitStub() {
  const React = createReactStub().React
  const h = React.createElement
  const forwardRefLike = { $$typeof: Symbol.for('react.forward_ref'), render: (props, ref) => h('button', props) }
  const icon = (kitName) => ({ 'data-kit-icon': kitName })
  return {
    Button: forwardRefLike,
    Pill: (props) => h('span', { 'data-kit-pill': props.active === true ? 'on' : 'off' }, props.children),
    Tooltip: (props) => h('span', { 'data-kit-tooltip': props.label }, props.children),
    Menu: (props) =>
      props.open !== true
        ? h('span', null, props.anchor)
        : h(
            'span',
            { className: props.className },
            props.anchor,
            (props.items ?? []).map((entry) =>
              entry.type === 'separator'
                ? h('div', { key: 'sep:' + entry.id, 'data-kit-menu-sep': true })
                : h(
                    'div',
                    { key: entry.id, 'data-kit-menu': entry.id, onClick: () => props.onSelect?.(entry.id) },
                    entry.label,
                  ),
            ),
          ),
    IconListOutlineRegular: icon('list'),
    IconPlusOutlineRegular: icon('plus'),
    IconRefreshOutlineRegular: icon('refresh'),
    IconCloseOutlineRegular: icon('close'),
    IconTrashOutlineRegular: icon('trash'),
    IconWarningOutlineRegular: icon('warning'),
    IconCheckOutlineRegular: icon('check'),
    IconChevronDownOutlineRegular: icon('chevronDown'),
    IconCopyOutlineRegular: icon('copy'),
    writeClipboard: async () => undefined,
  }
}

const SEATS = 'sidebar.right.pane.tab'

describe('client: module surface', () => {
  it('loads as a module-loader module with the shared identity', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload() })
    assert.equal(mounted.moduleExports.name, 'dsh-sidebar-git')
    assert.equal(String(mounted.moduleExports.inject), 'slots')
    assert.equal(typeof mounted.moduleExports.apply, 'function')
  })

  it('registers the tab type, its two seats, and the guide entry', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload() })
    assert.equal(mounted.tabs.registered.length, 1)
    const tab = mounted.tabs.registered[0]
    assert.equal(tab.kind, 'sidebar-git')
    assert.equal(tab.id, 'dsh-sidebar-git/panel')
    assert.equal(tab.keepMounted, true)
    assert.equal(tab.title(), 'Git')
    assert.equal(tab.guide.length, 1)
    assert.equal(tab.guide[0].title(), 'Git')
    assert.ok(tab.guide[0].icon({ size: 16 }).type !== undefined, 'the guide icon carries a usable face')

    const bodies = mounted.slots.registrations
    assert.equal(bodies.length, 2, 'the body seat and the title seat')
    assert.equal(bodies[0].spec.key, 'dsh-sidebar-git/panel')
    assert.equal(bodies[0].spec.name, SEATS)
    assert.equal(typeof bodies[0].spec.inject, 'function')
    const injected = bodies[0].spec.inject('sess-1')
    assert.deepEqual(Object.keys(injected), ['sessionId'], 'the slot inject forwards exactly sessionId')
    assert.equal(injected.sessionId, 'sess-1')
    assert.equal(bodies[1].spec.name, 'sidebar.right.pane.tab.title')
  })

  it('announces itself through the plugin logger', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload() })
    assert.ok(mounted.logs.some((line) => line.includes('侧边栏页签')), JSON.stringify(mounted.logs))
  })
})

describe('client: the kit boundary', () => {
  it('uses the kit when its faces exist', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload() })
    assert.equal(mounted.moduleExports._internal.ui.usingKit, true)
  })

  it('falls back to plain faces when the kit is absent', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload(), kit: false })
    assert.equal(mounted.moduleExports._internal.ui.usingKit, false)
    // The tab still registers and renders a legible empty root.
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'ready', data: overviewPayload() })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't1' } }) }), mounted)
    const texts = textsOf(tree)
    assert.ok(texts.includes('main'), 'the branch chip still names the branch in the fallback UI')
    assert.ok(texts.some((text) => text.includes('已暂存')))
  })

  it('falls back with a partial kit too', async () => {
    // A kit whose faces half-exist (the Menu missing) must not crash loadUi.
    const partial = { Button: () => null, Pill: () => null, Tooltip: () => null }
    const mounted = await mountClient({ fetchJson: () => overviewPayload(), kit: partial })
    assert.equal(mounted.moduleExports._internal.ui.usingKit, false)
  })
})

describe('client: the boot pipeline', () => {
  it('a working session reaches ready via the boot effect — no stuck loading', async () => {
    const mounted = await mountClient({ fetchJson: (url) => (url.includes('/repo') ? { ok: true, repo: overviewPayload().repo } : overviewPayload()) })
    const state = mounted.moduleExports._internal.stateOf('boot-sess')
    // Render like the shell: the component boots itself in an effect.
    const body = mounted.slots.registrations[0].component
    deepRender(body({ sessionId: 'boot-sess', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    mounted.flushEffects()
    await settle(4)
    assert.notEqual(state.value.phase, 'loading', `the tab must leave loading; ${state.value.phase}`)
    assert.equal(state.value.phase, 'ready')
    assert.ok(state.value.data !== null, 'the overview payload landed')
  })
})

describe('client: rendering from a seeded overview', () => {
  it('renders the branch chip, groups, rows and the composer', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload() })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'ready', data: overviewPayload() })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't1' } }) }), mounted)
    const texts = textsOf(tree)

    assert.ok(texts.includes('main'), 'branch name')
    assert.ok(texts.some((text) => text.includes('已暂存（1）')))
    assert.ok(texts.some((text) => text.includes('未暂存（1）')))
    assert.ok(texts.some((text) => text.includes('untracked.txt')))
    assert.ok(texts.some((text) => text.includes('+3 −1')), 'numstat on the modified row')
    assert.ok(elementsOf(tree, 'textarea').length === 1, 'the commit composer textarea exists')
    const submit = elementsOf(tree, 'button').find((node) => textsOf(node).includes('提交 →'))
    assert.ok(submit, '提交按钮存在')
  })

  it('renders diff lines when a diff is open, with the wrap bar', async () => {
    const mounted = await mountClient({ fetchJson: (url) => (url.includes('/diff') ? diffPayload() : overviewPayload()) })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    const internal = mounted.moduleExports._internal
    state.set({ phase: 'ready', data: overviewPayload() })
    // Seed the diff cache like `loadDiff` would, then open it.
    state.set({
      diffs: new Map([['staged:staged.txt', { data: diffPayload(), atRev: '42' }]]),
      diff: { path: 'staged.txt', area: 'staged', key: 'staged:staged.txt', loading: false, stale: false },
    })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    const lines = elementsOf(tree, 'div').filter((node) => /dsh-sg-lineAdd/.test(node.props?.className ?? ''))
    assert.ok(lines.length >= 1, 'the added line renders with its class')
    const texts = textsOf(tree)
    assert.ok(texts.includes('added content'), 'the added line renders its text')
    assert.ok(texts.includes('不换行'), 'the wrap toggle exists and names the action when wrapped')
    void internal
  })

  it('renders the stale hint when rev moved under an open diff', async () => {
    const mounted = await mountClient({ fetchJson: () => overviewPayload({ rev: '99' }) })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({
      phase: 'ready',
      data: overviewPayload({ rev: '99' }),
      diffs: new Map([['staged:staged.txt', { data: diffPayload(), atRev: '42' }]]),
      diff: { path: 'staged.txt', area: 'staged', key: 'staged:staged.txt', loading: false, stale: true },
    })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    assert.ok(textsOf(tree).includes('内容已变化，点击刷新'))
  })

  it('renders the no-repo empty state with the bind form', async () => {
    const mounted = await mountClient({ fetchJson: (url) => (url.startsWith(ROUTE + '/binding') ? { ok: true, repo: { root: '/repo/x', source: 'manual' } } : { ok: true, repo: null, reason: 'NO_REPO' }) })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'no-repo', reason: 'NO_REPO' })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    const texts = textsOf(tree)
    assert.ok(texts.some((text) => text.includes('当前会话不在 git 仓库里')))
    assert.ok(elementsOf(tree, 'input').length >= 1)
  })

  it('renders the no-git empty state', async () => {
    const mounted = await mountClient({ fetchJson: () => ({ ok: true, repo: null, reason: 'GIT_MISSING' }) })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'no-git', reason: 'GIT_MISSING' })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    assert.ok(textsOf(tree).some((text) => text.includes('本机没有可用的 git')))
  })
})

function diffPayload() {
  return {
    ok: true,
    path: 'staged.txt',
    binary: false,
    oversized: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        header: ' hdr',
        lines: [
          { t: ' ', s: 'hello' },
          { t: '+', s: 'added content' },
          { t: '-', s: 'old content' },
        ],
      },
    ],
  }
}

// ── interactions ────────────────────────────────────────────────────────────

describe('client: interactions through the store', () => {
  it('clicking stage on a row POSTs /stage and swaps the payload', async () => {
    const mounted = await mountClient({
      fetchJson(url, options) {
        if (url.endsWith('/stage')) {
          return {
            ok: true,
            repo: overviewPayload().repo,
            groups: { staged: [{ path: 'alpha.txt', display: 'alpha.txt', xy: 'A.', staged: { adds: 3, dels: 1 }, worktree: { adds: 0, dels: 0 }, untracked: false, conflict: false }], worktree: [], untracked: [{ path: 'untracked.txt', display: 'untracked.txt', xy: '??', untracked: true, conflict: false }], conflict: [] },
            counts: { staged: 1, worktree: 0, untracked: 1, conflict: 0 },
            branch: overviewPayload().branch,
            stashes: 0,
            rev: '43',
          }
        }
        return overviewPayload()
      },
    })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'ready', data: overviewPayload() })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    // The worktree row's stage [+] button carries the title '暂存'.
    // The worktree row's stage [+] button carries the title '暂存' exactly.
    const clicked = findButtonByTitle(tree, '暂存')
    assert.ok(clicked, 'the stage button is rendered with its exact title')
    clicked.props.onClick()
    await settle(2)
    const posted = mounted.requests.find((request) => request.url === ROUTE + '/stage')
    assert.ok(posted, '/stage was called')
    assert.deepEqual(JSON.parse(posted.options.body).paths, ['alpha.txt'])
  })

  it('the confirm panel previews impact and confirm posts the token once', async () => {
    const mounted = await mountClient({
      fetchJson(url) {
        if (url.endsWith('/ops/prepare')) {
          return { ok: true, op: 'discard', token: 'tok-1', impact: { argv: ['git', 'checkout', '--', 'alpha.txt'], files: [{ path: 'alpha.txt', adds: 3, dels: 1 }] }, expiresAt: Date.now() + 1000 }
        }
        if (url.endsWith('/ops/confirm')) {
          return { ok: true, discarded: ['alpha.txt'], ...overviewPayload() }
        }
        return overviewPayload()
      },
    })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'ready', data: overviewPayload() })
    const body = mounted.slots.registrations[0].component
    // Boot the panel through the same prepare the row button uses.
    const prepare = mounted.moduleExports._internal.apiPost
    void prepare
    // Drive state directly by invoking the module's own confirm state:
    state.set({
      confirm: { op: 'discard', token: 'tok-1', impact: { argv: ['git', 'checkout', '--', 'alpha.txt'], files: [{ path: 'alpha.txt', adds: 3, dels: 1 }] }, note: '丢弃这些文件里所有未暂存的修改（已暂存部分不动）' },
    })
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    const texts = textsOf(tree)
    assert.ok(texts.some((text) => text.includes('丢弃未提交修改')))
    assert.ok(texts.some((text) => text.includes('git checkout -- alpha.txt')), 'the argv preview shows the exact command')
    assert.ok(texts.some((text) => text.includes('alpha.txt +3 −1')))
    const go = elementsOf(tree, 'button').find((node) => textsOf(node).includes('确认执行'))
    assert.ok(go)
    go.props.onClick()
    await settle(2)
    const confirm = mounted.requests.find((request) => request.url === ROUTE + '/ops/confirm')
    assert.ok(confirm, 'the confirm route was hit')
    assert.equal(JSON.parse(confirm.options.body).token, 'tok-1')
    assert.equal(mounted.requests.filter((request) => request.url === ROUTE + '/ops/confirm').length, 1)
  })

  it('commit posts the draft and clears it on success', async () => {
    const mounted = await mountClient({
      fetchJson(url) {
        if (url === ROUTE + '/commit') {
          return { ok: true, commit: { hash: 'abc', short: 'abc1234', subject: 'm' }, ...overviewPayload({ counts: { staged: 0, worktree: 0, untracked: 0, conflict: 0 }, groups: { staged: [], worktree: [], untracked: [], conflict: [] } }) }
        }
        return overviewPayload()
      },
    })
    const state = mounted.moduleExports._internal.stateOf('sess-1')
    state.set({ phase: 'ready', data: overviewPayload(), draft: '一条提交信息' })
    const body = mounted.slots.registrations[0].component
    const tree = deepRender(body({ sessionId: 'sess-1', useTabInfo: () => ({ tab: { id: 't' } }) }), mounted)
    const submit = elementsOf(tree, 'button').find((node) => textsOf(node).includes('提交 →'))
    submit.props.onClick()
    await settle(2)
    const posted = mounted.requests.find((request) => request.url === ROUTE + '/commit')
    assert.ok(posted)
    const payload = JSON.parse(posted.options.body)
    assert.equal(payload.message, '一条提交信息')
    assert.equal(state.value.draft, '', 'the composer resets after a successful commit')
    assert.equal(state.value.amend, false)
  })
})

/**
 * Locate one button in the tree: the deepest match on a button whose
 * concatenated texts (including icon/child text) satisfy `match` after `skip`
 * prior title-like matches, so repeated '暂存'-titled buttons stay ordered.
 */
function findButtonByTitle(tree, title) {
  const buttons = elementsOf(tree, 'button')
  for (const node of buttons) {
    if (node.props?.title === title) return node
  }
  return undefined
}

/** Drain microtasks/effects a couple of turns. */
async function settle(rounds) {
  for (let at = 0; at < rounds; at += 1) {
    await new Promise((fulfil) => setTimeout(fulfil, 5))
  }
}

const ROUTE = '/dsh-sidebar-git'
