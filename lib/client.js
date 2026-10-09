/**
 * Browser half of dsh-sidebar-git.
 *
 * One native right-sidebar tab (`kind: 'sidebar-git'`) that follows the
 * repository the tab's own session works in: change list with in-place diffs,
 * history with per-commit details, stashes, and the composer that stages and
 * commits — plus branch push/pull and the prepare→confirm gate for anything
 * destructive. Everything the tab shows comes from the host half's
 * `/dsh-sidebar-git/*` routes.
 *
 * The UI is built from the shell's own component kit,
 * `@deepseek-ai/dsh-client-ui-primitives` — a frozen platform word whose
 * stylesheet is already in the page — so the tab is made of the same buttons,
 * menus, tooltips and icons the rest of the application uses. A kit that is
 * missing or older than this plugin degrades to plain elements styled by this
 * plugin's own stylesheet rather than an empty tab (see `loadUi`); the
 * git-flavoured glyphs (branch, commit, stash) the kit does not know are
 * carried here verbatim, the same way the chat tab carries the whale.
 *
 * The bundle is build-free plain JavaScript in the module-loader CJS form, so
 * the whole plugin stays editable in the profile without a toolchain; React
 * and the kit are the only dependencies, and both are platform words.
 *
 * @module dsh-sidebar-git/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-git',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    'use strict'

    var React = require('react')
    var h = React.createElement

    /** Package id: equals the Loader row name and the host plugin's name. */
    var PLUGIN_ID = 'dsh-sidebar-git'
    /** The tab record's discriminator, and this plugin's own kind. */
    var KIND = 'sidebar-git'
    /** Globally unique type id; also the key both slot bodies register under. */
    var TYPE_ID = PLUGIN_ID + '/panel'
    /** Path prefix the host half owns. */
    var ROUTE = '/dsh-sidebar-git'
    /** Style element id, so a reload replaces rather than stacks stylesheets. */
    var STYLE_ID = 'dsh-sidebar-git-style'
    /** Tab title, and the chip label before a repository binds. */
    var TAB_TITLE = 'Git'
    /** Where a rebind remembers which repository this session showed. */
    var LAST_REPO_KEY = 'dsh-sidebar-git:last-repo:'

    // ── the shell's component kit ───────────────────────────────────────────

    /**
     * The icon faces this tab uses (kit name → fallback name). The kit renders
     * with the shell's own glyphs; the fallback set carries hand-drawn paths so
     * a deployment without the kit still reads.
     */
    var ICON_NAMES = ['list', 'plus', 'refresh', 'close', 'trash', 'warning', 'check', 'chevronDown', 'copy', 'branch', 'commit', 'stash']

    /**
     * Fallback glyphs: 16px-square stroke paths (fill:none, stroke:currentColor,
     * stroke-width:1.6, round caps) — branch/commit/stash are this plugin's
     * own vocabulary, the rest echo the kit's names.
     */
    var FALLBACK_ICONS = {
      list: 'M5 4h10M5 8h10M5 12h10M5 16h6',
      plus: 'M8 3v10M3 8h10',
      refresh: 'M13 3a5.5 5.5 0 1 1-4 9.3M13 3v3.5H9.5M3 13a5.5 5.5 0 1 1 4-9.3M3 13V9.5H6.5',
      close: 'M4 4l8 8M12 4l-8 8',
      trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.8 9h5.4l.8-9',
      warning: 'M8 2.5 14.5 13h-13L8 2.5ZM8 7v3M8 11.6v.3',
      check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
      chevronDown: 'M4 6.5 8 10.5 12 6.5',
      copy: 'M10.5 3.5h-7a1 1 0 0 0-1 1v7M12.5 5.5h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1Z',
      branch: 'M5 2.5v6M11 13.5v-6M5 11a6 6 0 0 0 6 2.5M5 11a6 6 0 0 1 6-2.5M5 11a2 2 0 1 0 .01 0M11 7.5a2 2 0 1 0 .01 0M5 2.5a2 2 0 1 0 .01 0',
      commit: 'M2 8h4M10 8h4M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
      stash: 'M4 3h8l-1 10H5L4 3ZM4.5 6h7M4.8 9h6.4',
    }

    /**
     * A minimal stand-in for the shell kit. It exists so a deployment whose kit
     * is absent (or renamed upstream) still renders a usable tab: every element
     * the real kit would draw has a plain equivalent here, styled by this
     * plugin's own stylesheet.
     */
    function fallbackUi() {
      function Button(props) {
        var rest = Object.assign({}, props)
        var variant = rest.variant
        var size = rest.size
        var icon = rest.icon
        delete rest.icon
        delete rest.variant
        delete rest.size
        return h(
          'button',
          Object.assign({ type: 'button' }, rest, {
            className: 'dsh-sg-fbButton dsh-sg-fb' + (variant || 'ghost') + ' dsh-sg-fb' + (size || 'md') + (props.className ? ' ' + props.className : ''),
          }),
          icon != null ? h('span', { className: 'dsh-sg-fbIcon' }, icon) : null,
          props.children,
        )
      }

      function Pill(props) {
        var tag = props.onClick ? 'button' : 'span'
        var rest = Object.assign({}, props)
        delete rest.active
        delete rest.children
        if (tag === 'button') rest.type = 'button'
        return h(
          tag,
          Object.assign({}, rest, {
            className: 'dsh-sg-fbPill' + (props.active ? ' dsh-sg-fbPillOn' : '') + (props.className ? ' ' + props.className : ''),
          }),
          props.children,
        )
      }

      function Tooltip(props) {
        return h('span', { className: 'dsh-sg-fbTooltip', title: props.label }, props.children)
      }

      /**
       * A dropdown card anchored in this tab's stylesheet: rows, separators,
       * selected state, portal to the document body (a `display:none` ancestor
       * cannot hide it, which is exactly how floating layers escape).
       */
      function Menu(props) {
        if (!props.open) return h('span', { className: 'dsh-sg-fbAnchor' }, props.anchor != null ? props.anchor : null)
        var rows = []
        for (const entry of props.items || []) {
          if (entry.type === 'separator') {
            rows.push(h('div', { className: 'dsh-sg-fbMenuSep', key: 'sep-' + entry.id }))
            continue
          }
          rows.push(
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                disabled: entry.disabled === true,
                className: 'dsh-sg-fbMenuRow' + (props.selectedId === entry.id ? ' dsh-sg-fbMenuOn' : '') + (entry.danger ? ' dsh-sg-fbMenuDanger' : ''),
                onClick: function () {
                  if (entry.disabled === true) return
                  props.onSelect && props.onSelect(entry.id)
                  props.onClose && props.onClose()
                },
              },
              entry.icon != null ? entry.icon : null,
              entry.label,
            ),
          )
        }
        var cardProps = { className: 'dsh-sg-fbMenu dsh-sg-fbMenuBottom' }
        if (props.portal) cardProps = Object.assign({ 'data-dsh-sg-portal': '1' }, cardProps)
        var card = h('div', cardProps, h('div', { className: 'dsh-sg-fbMenuList' }, rows))
        return h('span', { className: 'dsh-sg-fbAnchor' }, props.anchor != null ? props.anchor : null, card)
      }

      return {
        usingKit: false,
        Button: Button,
        Pill: Pill,
        Tooltip: Tooltip,
        Menu: Menu,
        icons: fallbackIcons(),
        writeClipboard: function (text) {
          return navigator.clipboard?.writeText(String(text)) ?? Promise.resolve()
        },
      }
    }

    /** The icon set this tab draws with (pure SVG paths keyed by role). */
    function fallbackIcons() {
      var icons = {}
      for (const name of ICON_NAMES) {
        icons[name] = renderTaggedIcon(name)
      }
      return icons
    }

    /** Build one SVG element for the fallback glyph named `name`. */
    function renderTaggedIcon(name) {
      return function iconComponent(props) {
        var size = (props && props.size) || 16
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            className: 'dsh-sg-icon',
            'data-icon': name,
            'aria-hidden': 'true',
          },
          h('path', { d: FALLBACK_ICONS[name] ?? '', stroke: 'currentColor', fill: 'none', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        )
      }
    }

    /**
     * Load the shell kit, or degrade to the fallback implementation. A kit
     * whose faces are missing from this plugin's list answers with mixed
     * content ("usingKit + missingIcons"), which the tab renders around.
     */
    function loadUi(requireFn) {
      var kit = null
      try {
        kit = requireFn('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        kit = null
      }
      const isFace = (value) => value !== null && value !== undefined && (typeof value === 'function' || typeof value === 'object')
      if (kit === null || typeof kit !== 'object' || !isFace(kit.Button) || !isFace(kit.Menu) || !isFace(kit.Pill) || !isFace(kit.Tooltip)) {
        return fallbackUi()
      }
      const known = { IconListOutlineRegular: 'list', IconPlusOutlineRegular: 'plus', IconRefreshOutlineRegular: 'refresh', IconCloseOutlineRegular: 'close', IconTrashOutlineRegular: 'trash', IconWarningOutlineRegular: 'warning', IconCheckOutlineRegular: 'check', IconChevronDownOutlineRegular: 'chevronDown', IconCopyOutlineRegular: 'copy' }
      const icons = fallbackIcons()
      var usingKitIcons = false
      for (const [kitName, localName] of Object.entries(known)) {
        if (typeof kit[kitName] === 'object' && kit[kitName] !== null) {
          icons[localName] = kit[kitName]
          usingKitIcons = true
        }
      }
      return {
        usingKit: true,
        usingKitIcons: usingKitIcons,
        icons: icons,
        Button: kit.Button,
        Pill: kit.Pill,
        Tooltip: kit.Tooltip,
        Menu: kit.Menu,
        writeClipboard: typeof kit.writeClipboard === 'function' ? kit.writeClipboard : fallbackUi().writeClipboard,
      }
    }

    /** The kit this page renders with. */
    var ui = loadUi(require)
    /**
     * Render one icon as an element: the kit's faces (a mounted `<svg>`-like
     * object) or the fallback component. Name first, size optional.
     */
    function renderIcon(name, size) {
      var component = ui.icons[name] ?? renderTaggedIcon(name)
      return h(component, { size: size ?? 16 })
    }

    // ── side helpers ────────────────────────────────────────────────────────

    /** One API error carrying the host's stable code, so the UI hints by code. */
    class ApiError extends Error {
      constructor(code, message, payload) {
        super(message)
        this.name = 'ApiError'
        this.code = code ?? 'HTTP_ERROR'
        this.payload = payload
      }
    }

    /**
     * Read one plugin route.
     * @param path - after `ROUTE` (e.g. `/overview?sessionId=…`).
     * @param options - passed to fetch (method/body …).
     * @returns the parsed JSON body (an `ok:false` body rejects as ApiError).
     */
    async function api(path, options) {
      var response
      try {
        response = await fetch(ROUTE + path, options)
      } catch (error) {
        throw new ApiError('NETWORK', '无法连接 harness（' + String(error && error.message ? error.message : error) + '）')
      }
      var text = await response.text()
      var data
      try {
        data = JSON.parse(text)
      } catch {
        throw new ApiError('BAD_JSON', '响应不是 JSON：' + text.slice(0, 160))
      }
      if (data === null || typeof data !== 'object') {
        throw new ApiError('BAD_JSON', '空响应')
      }
      if (data.ok === false) {
        throw new ApiError((data.error && data.error.code) || 'HTTP_' + response.status, (data.error && data.error.message) || '请求失败', data.error)
      }
      return data
    }

    /** `GET` a read route. */
    function apiGet(path) {
      return api(path)
    }

    /** `POST` a JSON body to a write route. */
    function apiPost(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    /** Relative time for a commit date; `''` when unknown. */
    function timeAgo(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      var then = Date.parse(value)
      if (Number.isNaN(then)) return ''
      var seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return '刚刚'
      var minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      var hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      var days = Math.floor(hours / 24)
      if (days < 30) return days + ' 天前'
      var months = Math.floor(days / 30)
      if (months < 12) return months + ' 个月前'
      return Math.floor(months / 12) + ' 年前'
    }

    /** The XY status letter palette the row badge uses. */
    function letterClass(letter) {
      if (letter === 'A') return 'dsh-sg-add'
      if (letter === 'D' || letter === '-') return 'dsh-sg-del'
      if (letter === 'M' || letter === 'R' || letter === 'C') return 'dsh-sg-mod'
      return 'dsh-sg-other'
    }

    /** One row's badge text: 'M'/'A'/'D'/'R'/'U'/'??'. */
    function badgeText(entry) {
      if (entry.untracked) return '+'
      if (entry.conflict) return 'X'
      var x = entry.xy[0] ?? '.'
      var y = entry.xy[1] ?? '.'
      if (x === '.' ) return y
      return x
    }

    /** numstat pair, '' when both zero. */
    function numStatText(side) {
      if (side === undefined || side === null) return ''
      var adds = side.adds || 0
      var dels = side.dels || 0
      if (adds === 0 && dels === 0) return ''
      return '+' + adds + (dels > 0 ? ' −' + dels : '')
    }

    // ── the small observable store ──────────────────────────────────────────

    /**
     * One tab's state. Keyed by sessionId — two mounted copies of the same
     * tab (the shell keeps hidden per-session panels alive) share one state,
     * and only the visible copy paints floating layers.
     */
    var states = new Map()

    /** @type {Map<string, RepoView>} sessionId → view. */
    var viewStates = new Map()

    /** A repository's shared data, so two sessions on one repo poll once. */
    var repoData = new Map() // root → {at, data, fetch}

    /** The latest per-session overview promise, so parallel polls coalesce. */
    var inflight = new Map()

    /**
     * One overview fetch, coalesced per session and shared fresh per repository.
     * @param sessionId - the asking session.
     * @param force - bypass the 1.8s freshness guard (own writes do this).
     * @returns the overview payload.
     */
    async function overviewFor(sessionId, force) {
      var cached = force ? undefined : freshOverview()
      if (cached !== undefined) return cached

      var pending = inflight.get(sessionId)
      if (pending !== undefined) return pending
      var promise = (async () => {
        try {
          var data = await apiGet('/overview?sessionId=' + encodeURIComponent(sessionId) + (force ? '&force=1' : ''))
          if (data.repo) repoData.set(data.repo.root, { at: Date.now(), data: data })
          return data
        } finally {
          inflight.delete(sessionId)
        }
      })()
      inflight.set(sessionId, promise)
      return promise
    }

    /** The freshest cached overview younger than 1.8s (deduping the poll fleet). */
    function freshOverview() {
      for (const entry of repoData.values()) {
        if (Date.now() - entry.at < 1800) return entry.data
      }
      return undefined
    }

    /**
     * One tab's state.
     * @param sessionId - the tab's session.
     */
    function RepoView(sessionId) {
      this.sessionId = sessionId
      this.listeners = new Set()
      this.value = {
        phase: 'loading', // loading | ready | no-repo | no-git
        reason: '',
        info: null, // {root, display, source}
        data: null, // the latest overview payload
        pollError: '',
        tab: 'changes', // changes | history | stash
        draft: '',
        amend: false,
        amendLoading: false,
        wrap: true,
        busy: {}, // keyed by op id → true while in flight
        menu: '',
        creating: false, // the branch-creation sheet is open
        confirm: null, // {op, token, impact, note}
        diff: null, // {path, area, key, loading, stale}
        diffs: new Map(), // key → {data, atRev}
        commits: [], // history page
        commitsDone: false,
        commitsError: '',
        commitsLoading: false,
        openCommit: null, // {hash, files, loading, error}
        commitDiff: null, // {key, path, loading}
        stashes: [],
        stashesError: '',
        stashNote: '',
        branchList: [],
        branchError: '',
        newBranchName: '',
        bindPath: '',
        bindError: '',
      }
    }

    /** Read the current snapshot. */
    RepoView.prototype.get = function get() {
      return this.value
    }

    /** Subscribe one listener; returns the unsubscribe function. */
    RepoView.prototype.subscribe = function subscribe(listener) {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }

    /** Merge a patch into the state and notify every listener. */
    RepoView.prototype.set = function set(patch) {
      this.value = Object.assign({}, this.value, patch)
      for (const listener of Array.from(this.listeners)) listener()
    }

    /** The state of one tab, created on first use, keyed by sessionId. */
    function stateOf(sessionId) {
      var key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default'
      var found = viewStates.get(key)
      if (found === undefined) {
        found = new RepoView(key)
        viewStates.set(key, found)
      }
      return found
    }

    /** React binding for one tab's state. */
    function useViewState(state) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => state.subscribe(listener), [state]),
        React.useCallback(() => state.get(), [state]),
      )
    }

    // ── actions ─────────────────────────────────────────────────────────────

    /** Boot a view once: resolve the repository, then poll until disposed. */
    function bootView(state, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        state.set({ phase: 'no-repo', reason: 'NO_SESSION' })
        return
      }
      state.set({ phase: 'loading' })
      refresh(state, 'force')
    }

    /**
     * One resolve+overview refresh.
     * @param state - the tab's view state.
     * @param mode - `'force'` bypasses both caches (manual refresh, boot after
     *   binding); every other call rides them.
     */
    async function refresh(state, mode) {
      var sessionId = state.sessionId
      try {
        var repo = await apiGet('/repo?sessionId=' + encodeURIComponent(sessionId ?? ''))
        var gitMissing = repo.reason === 'GIT_MISSING' || repo.reason === 'GIT_XCODE_STUB'
        if (repo.repo === null) {
          state.set({ phase: gitMissing ? 'no-git' : 'no-repo', reason: repo.reason, info: null, data: null })
          return
        }
        state.set({ info: repo.repo, phase: 'ready', reason: '' })
      } catch (error) {
        // A failed resolve keeps whatever the tab already shows and surfaces
        // the error; pretending `ready` with no data would hang the loading
        // branch forever.
        state.set({ pollError: describe(error) })
        return
      }
      try {
        var data = await overviewFor(sessionId, mode === 'force')
        if (data.repo === null) {
          state.set({ phase: gitReasonOf(data.reason) === 'git' ? 'no-git' : 'no-repo', reason: data.reason, data: null })
          return
        }
        state.set({ phase: 'ready', data: data, pollError: '' })
        syncDerived(state, data)
      } catch (error) {
        state.set({ pollError: describe(error) })
      }
    }

    /** Keep error text plain. */
    function describe(error) {
      return String((error && error.message) || error)
    }

    function gitReasonOf(reason) {
      return reason === 'GIT_MISSING' || reason === 'GIT_XCODE_STUB' ? 'git' : 'repo'
    }

    /** After an overview refresh, fill open diffs' staleness and derived lists. */
    function syncDerived(state, data) {
      var patch = {}
      if (state.value.diff !== null) {
        var current = state.value.diffs.get(state.value.diff.key)
        if (current !== undefined && current.atRev !== data.rev) {
          patch.diff = Object.assign({}, state.value.diff, { stale: true })
        }
        if (current === undefined) {
          loadDiff(state, state.value.diff.path, state.value.diff.area)
        }
      }
      // While the history tab shows commits, refresh its page only when open.
      state.set(patch)
    }

    /** Load (or revalidate) one file's diff into the store. */
    async function loadDiff(state, path, area) {
      var key = area + ':' + path
      var diff = { path: path, area: area, key: key, loading: true, stale: false }
      state.set({ diff: diff })
      try {
        var query = '?sessionId=' + encodeURIComponent(state.sessionId) + '&path=' + encodeURIComponent(path) + '&area=' + encodeURIComponent(area)
        var payload = await apiGet('/diff' + query)
        var diffData = { data: payload, atRev: state.value.data ? state.value.data.rev : '' }
        var diffs = new Map(state.value.diffs)
        diffs.set(key, diffData)
        state.set({ diffs: diffs, diff: Object.assign({}, diff, { loading: false, expired: payload.binary === true, oversized: payload.oversized === true }) })
      } catch (error) {
        var diffsError = new Map(state.value.diffs)
        diffsError.set(key, { data: { error: describe(error) }, atRev: '' })
        state.set({ diffs: diffsError, diff: Object.assign({}, diff, { loading: false }) })
      }
    }

    /** Load one commit's file list for the history detail. */
    async function loadCommitFiles(state, hash) {
      state.set({ openCommit: { hash: hash, files: [], loading: true } })
      try {
        var payload = await apiGet('/commitfiles?sessionId=' + encodeURIComponent(state.sessionId) + '&commit=' + encodeURIComponent(hash))
        state.set({ openCommit: { hash: hash, files: payload.files ?? [], loading: false } })
      } catch (error) {
        state.set({ openCommit: { hash: hash, files: [], loading: false, error: describe(error) } })
      }
    }

    /** Load the file diffs of an open commit lazily. */
    async function loadCommitDiff(state, hash, path) {
      var key = 'commit:' + hash + ':' + path
      var existing = state.value.diffs.get(key)
      if (existing !== undefined) {
        state.set({ commitDiff: { key: key, path: path } })
        return
      }
      state.set({ commitDiff: { key: key, path: path, loading: true } })
      try {
        var query = '?sessionId=' + encodeURIComponent(state.sessionId) + '&path=' + encodeURIComponent(path) + '&commit=' + encodeURIComponent(hash)
        var payload = await apiGet('/diff' + query)
        var diffs = new Map(state.value.diffs)
        diffs.set(key, { data: payload, atRev: state.value.data ? state.value.data.rev : '' })
        state.set({ diffs: diffs, commitDiff: { key: key, path: path, loading: false } })
      } catch (error) {
        var errs = new Map(state.value.diffs)
        errs.set(key, { data: { error: describe(error) }, atRev: '' })
        state.set({ diffs: errs, commitDiff: { key: key, path: path, loading: false } })
      }
    }

    /** History page load (or more pages). */
    async function loadCommits(state, more) {
      if (state.value.commitsLoading) return
      var limit = 50
      state.set({ commitsLoading: true, commitsError: '' })
      try {
        var offset = more ? state.value.commits.length : 0
        var payload = await apiGet('/log?sessionId=' + encodeURIComponent(state.sessionId) + '&limit=' + limit + '&offset=' + offset)
        var commits = more ? state.value.commits.concat(payload.commits ?? []) : payload.commits ?? []
        state.set({ commits: commits, commitsDone: payload.done === true, commitsLoading: false, unborn: payload.unborn === true })
      } catch (error) {
        state.set({ commitsLoading: false, commitsError: describe(error) })
      }
    }

    /** Stash list load. */
    async function loadStashes(state) {
      try {
        var payload = await apiGet('/stashes?sessionId=' + encodeURIComponent(state.sessionId))
        state.set({ stashes: payload.stashes ?? [], stashesError: '' })
      } catch (error) {
        state.set({ stashesError: describe(error) })
      }
    }

    /** Branch list load (for the branch menu). */
    async function loadBranches(state) {
      try {
        var payload = await apiGet('/branches?sessionId=' + encodeURIComponent(state.sessionId))
        state.set({ branchList: payload.branches ?? [], branchError: '' })
      } catch (error) {
        state.set({ branchError: describe(error) })
      }
    }

    /**
     * The shared write path: POST one route, swap the fresh overview in, surface
     * failures as a transient notice. `busyKey` marks rows still in flight.
     */
    async function runOp(state, path, body, busyKey) {
      var busy = Object.assign({}, state.value.busy)
      busy[busyKey ?? path] = true
      state.set({ busy: busy, pollError: '' })
      try {
        var payload = await apiPost(path, Object.assign({ sessionId: state.sessionId }, body))
        if (payload.repo) {
          repoData.set(payload.repo.root, { at: Date.now(), data: payload })
        } else if (state.value.data) {
          repoData.set(state.value.data.repo.root, { at: Date.now(), data: payload })
        }
        state.set({ data: payload, busy: withoutKey(state.value.busy, busyKey ?? path) })
        if (state.value.diff !== null) loadDiff(state, state.value.diff.path, state.value.diff.area)
        return payload
      } catch (error) {
        var notice = translateError(error)
        var cleared = Object.assign({}, state.value.busy)
        delete cleared[busyKey ?? path]
        state.set({ busy: cleared, pollError: notice || describe(error) })
        // Refresh anyway: the operation may have partially landed.
        refresh(state, 'force')
        throw error
      }
    }

    function withoutKey(obj, key) {
      var next = Object.assign({}, obj)
      delete next[key]
      return next
    }

    /** Error codes → short hints; unknown text passes through. */
    function translateError(error) {
      var code = error && error.code
      var hints = {
        LOCKED: '另一个 git 进程正在写这个仓库（index.lock），稍后再试',
        AUTH_FAILED: '凭据不可用：到终端确认 remote 的凭据助手',
        NOT_FAST_FORWARD: '远端不可快进：merge/rebase 请在终端处理',
        PUSH_REJECTED: '推送被拒绝：远端有新提交，先拉取（--ff-only）',
        BRANCH_EXISTS: '分支已存在',
        BRANCH_INVALID: '分支名不被 git 接受',
        CONFIRM_INVALID: '确认已过期，请重新发起',
        UNMERGED: '工作树有未解决的合并冲突',
        NOTHING_TO_COMMIT: '没有可提交的内容',
        DIRTY_WORKTREE_CONFLICT: '会撞上未提交的本地修改',
      }
      return hints[code] ?? describe(error)
    }

    // ── components ──────────────────────────────────────────────────────────

    /**
     * The tab body.
     *
     * @param props - the slot props: `sessionId` (slot inject) and
     *   `useTabInfo()` from the seat.
     */
    function GitBody(props) {
      var sessionId = props.sessionId
      var info = props.useTabInfo()
      var state = stateOf(typeof sessionId === 'string' ? sessionId : info?.tab?.id)
      var current = useViewState(state)
      var rootRef = React.useRef(null)

      React.useEffect(() => {
        bootView(state, sessionId)
      }, [state, sessionId])

      // The polling loop lives for the mounted copy; only the visible one polls.
      React.useEffect(() => {
        if (state.value.phase !== 'ready') return undefined
        var timer = setInterval(() => {
          if (!isOnScreen(rootRef.current)) return
          refresh(state)
        }, 2500)
        return () => clearInterval(timer)
      }, [state, state.value.phase])

      // One visibility re-check after mount, so hidden copies never paint menus.
      useOnScreen(rootRef, current.menu !== '')

      if (current.phase === 'no-git') {
        return h('div', { className: 'dsh-sg-root dsh-sg-emptyRoot', ref: rootRef }, NoGitCard())
      }
      if (current.phase === 'no-repo') {
        return h(
          'div',
          { className: 'dsh-sg-root dsh-sg-emptyRoot', ref: rootRef },
          h(BindCard, { state: state }),
        )
      }
      if (current.phase !== 'ready' || current.data === null) {
        // data 为空但已有报错时给出可重试的错误态，而不是无限 loading。
        if (current.pollError !== '') {
          return h(
            'div',
            { className: 'dsh-sg-root dsh-sg-emptyRoot', ref: rootRef },
            h('div', { className: 'dsh-sg-errorPage' }, '读取仓库失败：' + current.pollError),
            h('button', { type: 'button', className: 'dsh-sg-bindGo', onClick: () => bootView(state, sessionId) }, '重试'),
          )
        }
        return h('div', { className: 'dsh-sg-root dsh-sg-emptyRoot', ref: rootRef }, h('div', { className: 'dsh-sg-loading' }, '正在读取仓库…'))
      }

      return h(
        'div',
        { className: 'dsh-sg-root', ref: rootRef },
        h(TopBar, { state: state, current: current }),
        h(Banners, { current: current }),
        h(InnerTabs, { state: state, current: current }),
        h(
          'div',
          { className: 'dsh-sg-body' },
          current.tab === 'history' ? h(HistoryTab, { state: state, current: current }) : null,
          current.tab === 'stash' ? h(StashTab, { state: state, current: current }) : null,
          current.tab === 'changes' ? h(ChangesTab, { state: state, current: current }) : null,
        ),
        h(ConfirmPanel, { state: state, current: current }),
        h(Notice, { state: state, current: current }),
        current.tab === 'changes' ? h(Composer, { state: state, current: current }) : null,
      )
    }

    /** The tab title seat: glyph plus branch (or the plain「Git」). */
    /**
     * The tab title seat: the branch glyph plus the current branch name, or the
     * plain「Git」while the repository is still resolving.
     */
    function GitTitle(props) {
      var sessionId = props.sessionId
      var info = props.useTabInfo()
      var state = stateOf(typeof sessionId === 'string' ? sessionId : info?.tab?.id)
      var current = useViewState(state)
      var data = current.data
      var branchName =
        data !== null && data.branch ? (data.branch.unborn ? '' : data.branch.detached ? '' : data.branch.name) : ''
      return h(
        React.Fragment,
        null,
        h(
          'span',
          { 'aria-hidden': 'true', style: { display: 'inline-flex', marginRight: 4, verticalAlign: '-2px' } },
          renderIcon('branch', 14),
        ),
        branchName !== '' ? branchName + ' · ' : '',
        TAB_TITLE,
      )
    }

    /** Top bar: the branch chip + ahead/behind chips + the branch menu + refresh. */
    function TopBar(props) {
      var state = props.state
      var current = props.current
      var branch = current.data.branch
      var label = branch.unborn ? '空仓库' : branch.detached ? 'detached HEAD' : branch.name
      var chips = []
      if (!branch.unborn && (branch.ahead > 0 || branch.behind > 0)) {
        chips.push('↑' + branch.ahead)
        chips.push('↓' + branch.behind)
      }

      var anchor = h(
        'button',
        {
          type: 'button',
          className: 'dsh-sg-branchChip',
          title: '当前分支（点击切换分支）',
          'data-dsh-sg': 'branch-chip',
          onClick: (event) => {
            event.stopPropagation()
            if (current.menu === 'branch') state.set({ menu: '' })
            else {
              state.set({ menu: 'branch' })
              loadBranches(state)
            }
          },
        },
        renderIcon('branch', 14),
        h('span', { className: 'dsh-sg-branchName' }, label),
        h('span', { className: 'dsh-sg-titleChevron' }, renderIcon('chevronDown', 12)),
      )

      return h(
        'div',
        { className: 'dsh-sg-topbar' },
        h(BranchMenu, { state: state, current: current, anchor: anchor, open: current.menu === 'branch' }),
        statusChips(branch),
        h(
          'div',
          { className: 'dsh-sg-topActions' },
          chips.length > 0 ? h('span', { className: 'dsh-sg-abChip' }, chips.join(' ')) : null,
          h(ui.Button, {
            variant: 'ghost',
            size: 'sm',
            icon: renderIcon('refresh', 14),
            title: '刷新',
            'data-dsh-sg': 'refresh',
            onClick: () => refresh(state, 'force'),
          }),
        ),
      )
    }

    /** Ahead/behind as semantic chips at the far left of the top bar. */
    function statusChips(branch) {
      var chips = []
      if (branch.behind > 0) chips.push(h('span', { className: 'dsh-sg-chip dsh-sg-chipBehind', key: 'behind', title: '落后 upstream 的提交数' }, '↓' + branch.behind))
      if (branch.ahead > 0) chips.push(h('span', { className: 'dsh-sg-chip dsh-sg-chipAhead', key: 'ahead', title: '领先 upstream 的提交数' }, '↑' + branch.ahead))
      return chips
    }

    /** The branch dropdown: switch, create, push/pull, delete (gated). */
    function BranchMenu(props) {
      var state = props.state
      var current = props.current
      var anchor = props.anchor
      var creating = state.value.creating === true

      var items = []
      if (creating) {
        items.push({ id: 'create-row', label: h(NewBranchRow, { state: state, current: current }) })
      } else {
        items.push({ id: 'action:create', label: '新建分支…', icon: h('span', { className: 'dsh-sg-menuIcon' }, renderIcon('plus', 14)) })
        if (current.data.branch.unborn === false) {
          items.push({ id: 'sec:go', type: 'separator' })
          items.push({ id: 'action:push', label: state.value.data.branch.upstream === '' ? '推送并设置 upstream' : '推送到远端', icon: h('span', { className: 'dsh-sg-menuIcon' }, renderIcon('refresh', 14)) })
          items.push({ id: 'action:pull', label: '拉取（--ff-only）', icon: h('span', { className: 'dsh-sg-menuIcon' }, renderIcon('refresh', 14)) })
        }
        items.push({ id: 'sec:branches', type: 'separator' })
        for (const row of state.value.branchList) {
          if (row.current) continue
          items.push({
            id: 'branch:' + row.name,
            label: h(
              'span',
              { className: 'dsh-sg-branchRow' },
              h('span', { className: 'dsh-sg-branchRowName' }, row.name),
              h('span', { className: 'dsh-sg-branchRowDate' }, timeAgo(row.date)),
            ),
          })
        }
        if (state.value.branchError !== '') {
          items.push({ id: 'sec:err', type: 'separator' })
          items.push({ id: 'err', disabled: true, label: h('span', { className: 'dsh-sg-menuError' }, state.value.branchError) })
        }
      }

      return h(ui.Menu, {
        open: props.open === true,
        anchor: anchor,
        className: 'dsh-sg-branchAnchor',
        listClassName: 'dsh-sg-menuList',
        items: items.length > 0 ? items : [{ id: 'none', disabled: true, label: '加载分支…' }],
        selectedId: '',
        align: 'start',
        side: 'bottom',
        portal: true,
        compact: true,
        onClose: () => state.set({ menu: '', creating: false, newBranchName: '' }),
        onSelect: (id) => handleBranchSelect(state, current, id),
      })
    }

    /** The inline 「新建分支」 row inside the branch menu. */
    function NewBranchRow(props) {
      var state = props.state
      var current = props.current
      return h(
        'span',
        { className: 'dsh-sg-newBranchRow', onClick: (event) => event.stopPropagation() },
        h('input', {
          type: 'text',
          className: 'dsh-sg-newBranchInput',
          placeholder: '新分支名',
          autoFocus: true,
          value: state.value.newBranchName || '',
          onChange: (event) => state.set({ newBranchName: event.target.value }),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitBranch(state, current)
            }
            if (event.key === 'Escape') state.set({ newBranchName: '' })
            event.stopPropagation()
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-sg-newBranchGo',
            onClick: () => submitBranch(state, current),
          },
          '创建',
        ),
      )
    }

    /** One branch-menu selection. */
    async function handleBranchSelect(state, current, id) {
      if (id === 'action:create') {
        state.set({ menu: 'branch', creating: true, newBranchName: '' })
        return
      }
      if (id === 'action:push' || id === 'action:pull') {
        state.set({ menu: '' })
        try {
          if (id === 'action:pull') {
            await runOp(state, '/pull', {})
          } else {
            // Push follows the upstream; without one this first push sets it.
            if (current.data.branch.upstream === '') {
              await runOp(state, '/push', { setUpstream: true })
            } else {
              await runOp(state, '/push', {})
            }
          }
        } catch {
          // runOp already surfaced the notice
        }
        return
      }
      if (id.indexOf('branch:') === 0) {
        state.set({ menu: '' })
        var name = id.slice('branch:'.length)
        try {
          await runOp(state, '/branch', { action: 'checkout', name: name })
        } catch (error) {
          if (error.code === 'DIRTY_WORKTREE_CONFLICT') {
            state.set({ pollError: '切换会撞上未提交的本地修改：先 stash（Stash 页签）或处理后再切' })
          }
        }
      }
    }

    /** Start creating a branch (T1; the name is checked by git on the host). */
    async function submitBranch(state, current) {
      void current
      var name = (state.value.newBranchName ?? '').trim()
      if (name.length === 0 || /\s/.test(name) || name.startsWith('-')) {
        state.set({ pollError: '分支名不能为空、不能含空格且不能以 - 开头' })
        return
      }
      state.set({ busy: Object.assign({}, state.value.busy, { 'branch:create': true }) })
      try {
        await apiPost('/branch', { sessionId: state.sessionId, action: 'create', name: name })
        state.set({ menu: '', creating: false, newBranchName: '' })
        refresh(state, 'force')
      } catch (error) {
        state.set({ pollError: translateError(error) })
      } finally {
        state.set({ busy: withoutKey(state.value.busy, 'branch:create') })
      }
    }

    /** Banners for states the tab must not brush under the rug. */
    function Banners(props) {
      var current = props.current
      var branch = current.data.branch
      if (current.data.counts.conflict > 0) {
        return banner('warning', '合并冲突：' + String(current.data.counts.conflict) + ' 个文件未解决。建议到终端或让 agent 处理；解决后回到这里提交。')
      }
      if (branch.detached) {
        return banner('warning', '当前处于 detached HEAD（切回去的分支不会自动更新）。回到分支后再提交更稳妥。')
      }
      if (current.data.counts.conflict === 0 && !current.data.branch.unborn && current.data.repo.source === 'manual') {
        return banner('info', '已手动绑定到 ' + current.data.repo.root + '（与当前会话的工作目录不同）。')
      }
      return null
    }

    /** One banner row. */
    function banner(kind, text) {
      return h('div', { className: 'dsh-sg-banner dsh-sg-banner-' + kind, role: 'status' }, renderIcon('warning', 13), ' ', text)
    }

    /** The three inner tabs (变更 / 历史 / Stash). */
    function InnerTabs(props) {
      var state = props.state
      var current = props.current
      var counts = current.data.counts
      var tabs = [
        { id: 'changes', label: '变更' + (counts.staged + counts.worktree + counts.untracked > 0 ? ' ' + (counts.staged + counts.worktree + counts.untracked) : '') },
        { id: 'history', label: '历史' },
        { id: 'stash', label: 'Stash' + (current.data.stashes > 0 ? ' ' + current.data.stashes : '') },
      ]
      return h(
        'div',
        { className: 'dsh-sg-tabs' },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              className: 'dsh-sg-tab' + (current.tab === tab.id ? ' dsh-sg-tabOn' : ''),
              onClick: () => {
                state.set({ tab: tab.id })
                if (tab.id === 'history' && state.value.commits.length === 0) loadCommits(state, false)
                if (tab.id === 'stash') loadStashes(state)
              },
            },
            tab.label,
          ),
        ),
      )
    }

    /** The Changes page: groups, rows and their inline diffs. */
    function ChangesTab(props) {
      var state = props.state
      var current = props.current
      var data = current.data
      var groups = data.groups

      return h(
        'div',
        { className: 'dsh-sg-changes' },
        h(Group, { state: state, current: current, kind: 'staged', title: '已暂存', entries: groups.staged, empty: '暂存区是空的：从下面未暂存的改动里 +' }),
        h(Group, { state: state, current: current, kind: 'worktree', title: '未暂存', entries: groups.worktree }),
        h(Group, { state: state, current: current, kind: 'untracked', title: '未跟踪', entries: groups.untracked }),
        h(Group, { state: state, current: current, kind: 'conflict', title: '冲突', entries: groups.conflict }),
        data.counts.staged + data.counts.worktree + data.counts.untracked + data.counts.conflict === 0
          ? h('div', { className: 'dsh-sg-clean' }, '工作区干净 · ' + (data.branch.unborn ? '初始提交待写' : '没有待提交的改动'))
          : null,
      )
    }

    /** One group of file rows. */
    function Group(props) {
      var state = props.state
      var entries = props.entries
      if (entries.length === 0 && props.kind !== 'staged') {
        // Only the staged group keeps an empty hint; the rest collapse away.
        return null
      }

      return h(
        'div',
        { className: 'dsh-sg-group' },
        h(
          'div',
          { className: 'dsh-sg-groupHead' },
          h('span', { className: 'dsh-sg-groupTitle' }, props.title + '（' + entries.length + '）'),
          props.kind === 'worktree' && entries.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-sg-groupAction',
                  onClick: () => stageAll(state, 'worktree', entries),
                  disabled: entries.every((entry) => state.value.busy['add:' + entry.path] === true),
                },
                '全部 +',
              )
            : null,
          props.kind === 'staged' && entries.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-sg-groupAction',
                  onClick: () => stageAll(state, 'staged', entries),
                },
                '全部 −',
              )
            : null,
        ),
        entries.length === 0 ? h('div', { className: 'dsh-sg-groupEmpty' }, props.empty ?? '') : null,
        entries.map((entry) => h(FileRow, { state: state, entry: entry, key: entry.path, current: props.current })),
      )
    }

    /** Quick stage/unstage of one whole group. */
    function stageAll(state, kind, entries) {
      var paths = entries.map((entry) => entry.path)
      runOp(state, kind === 'staged' ? '/unstage' : '/stage', { paths: paths }, kind === 'staged' ? 'unstage:group' : 'stage:group').catch(() => {})
    }

    /**
     * One file row: badge + display path + numstat + actions, with the inline
     * diff underneath when open.
     */
    function FileRow(props) {
      var state = props.state
      var entry = props.entry
      var area = props.current && props.current.tab === 'changes' ? entryArea(entry) : 'worktree'
      var open = state.value.diff !== null && state.value.diff.key === area + ':' + entry.path
      var busyKey = (entry.x !== '.' && !entry.untracked ? 'unstage:' : 'add:') + entry.path

      return h(
        'div',
        { className: 'dsh-sg-rowWrap' },
        h(
          'div',
          { className: 'dsh-sg-row' + (open ? ' dsh-sg-rowOpen' : '') },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sg-rowMain',
              title: '展开/收起 diff',
              onClick: () => {
                if (entry.conflict) {
                  state.set({ pollError: '冲突文件需要手工解决，diff 已省略' })
                  return
                }
                if (open) state.set({ diff: null })
                else loadDiff(state, entry.path, area)
              },
            },
            h('span', { className: 'dsh-sg-badge dsh-sg-badge-' + letterClass(badgeText(entry)) }, badgeText(entry)),
            h(
              'span',
              { className: 'dsh-sg-path' },
              entry.renamedFrom !== undefined ? h('span', { className: 'dsh-sg-renameFrom' }, entry.renamedFrom + ' → ') : null,
              entry.display,
            ),
            h('span', { className: 'dsh-sg-numstat' }, numStatText(entry.staged) || numStatText(entry.worktree)),
          ),
          h(
            'span',
            { className: 'dsh-sg-rowActions' },
            rowButtons(state, entry, area),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-sg-rowChevron',
                title: open ? '收起' : '展开',
                onClick: () => {
                  if (open) state.set({ diff: null })
                  else loadDiff(state, entry.path, area)
                },
              },
              renderIcon('chevronDown', 12),
            ),
          ),
        ),
        open ? h(DiffPanel, { state: state, diff: state.value.diff }) : null,
      )
    }

    /** Which diff area a row belongs to, by its statuses. */
    function entryArea(entry) {
      if (entry.conflict) return 'worktree'
      if (entry.untracked) return 'worktree'
      const x = entry.xy[0] ?? '.'
      if (x !== '.' && x !== '?') return 'staged'
      return 'worktree'
    }

    /** The row's action buttons (stage / unstage [ / discard]). */
    function rowButtons(state, entry) {
      var buttons = []
      const x = entry.xy[0] ?? '.'
      const y = entry.xy[1] ?? '.'
      if (entry.conflict) return []
      if (entry.untracked || x === '.' || x === '?') {
        if (y !== '.' || entry.untracked) {
          buttons.push(
            iconAction(state, 'add:' + entry.path, 'plus', '暂存', () =>
              runOp(state, '/stage', { paths: [entry.path] }, 'add:' + entry.path).catch(() => {}),
            ),
          )
        }
      }
      if (x !== '.' && x !== '?') {
        buttons.push(
          iconAction(state, 'unstage:' + entry.path, 'close', '取消暂存', () =>
            runOp(state, '/unstage', { paths: [entry.path] }, 'unstage:' + entry.path).catch(() => {}),
          ),
        )
      }
      if (!entry.untracked && y !== '.') {
        buttons.push(
          iconAction(state, 'discard-ask:' + entry.path, 'trash', '丢弃未提交的修改（需确认）', () =>
            prepareDiscard(state, [entry.path]),
          ),
        )
      }
      return buttons
    }

    /** One ghost icon button shared by rows. */
    function iconAction(state, busyKey, iconName, label, onClick) {
      var busy = state.value.busy[busyKey] === true
      return h(
        'button',
        {
          type: 'button',
          key: busyKey,
          className: 'dsh-sg-rowAction' + (busy ? ' dsh-sg-rowActionBusy' : ''),
          title: label,
          disabled: busy,
          onClick: onClick,
        },
        renderIcon(iconName, 13),
      )
    }

    /**
     * The inline diff: hunk headers + colored rows, with the stale hint when
     * the repository moved underneath an open diff.
     */
    function DiffPanel(props) {
      var state = props.state
      var diff = props.diff ?? state.value.diff
      var cached = state.value.diffs.get(diff.key)
      var payload = cached !== undefined ? cached.data : null
      var wrap = state.value.wrap
      if (diff.loading || payload === null) {
        return h('div', { className: 'dsh-sg-diff dsh-sg-diffLoading' }, '读取 diff…')
      }
      if (payload.ok === false) {
        return h('div', { className: 'dsh-sg-diff dsh-sg-diffError' }, payload.error?.message ?? 'diff 读取失败')
      }
      if (payload.binary) {
        return h('div', { className: 'dsh-sg-diff dsh-sg-diffNote' }, '二进制文件：不渲染 diff')
      }
      if (payload.oversized) {
        return h('div', { className: 'dsh-sg-diff dsh-sg-diffNote' }, '文件过大：diff 已省略')
      }
      if ((payload.hunks ?? []).length === 0) {
        return h('div', { className: 'dsh-sg-diff dsh-sg-diffNote' }, '没有可显示的差异')
      }

      return h(
        'div',
        { className: 'dsh-sg-diff' + (wrap ? ' dsh-sg-diffWrap' : '') },
        diff.stale ? h('div', { className: 'dsh-sg-diffStale' }, '内容已变化，点击刷新') : null,
        h(
          'div',
          { className: 'dsh-sg-diffBar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sg-diffToggle',
              onClick: () => state.set({ wrap: !state.value.wrap }),
            },
            wrap ? '不换行' : '自动换行',
          ),
        ),
        payload.hunks.map((hunk, index) =>
          h(
            'div',
            { className: 'dsh-sg-hunk', key: index },
            h('div', { className: 'dsh-sg-hunkHead' }, '@@ -' + hunk.oldStart + (hunk.oldLines !== 1 ? ',' + hunk.oldLines : '') + ' +' + hunk.newStart + (hunk.newLines !== 1 ? ',' + hunk.newLines : '') + ' @@' + hunk.header),
            hunk.lines.map((line) =>
              h(
                'div',
                {
                  className: 'dsh-sg-line dsh-sg-' + (line.t === '+' ? 'lineAdd' : line.t === '-' ? 'lineDel' : line.t === '\\' ? 'lineMeta' : 'lineCtx'),
                },
                line.s,
              ),
            ),
          ),
        ),
      )
    }

    /**
     * The bottom composer: commit message card + the amend toggle + the
     * brand-blue submit.
     */
    function Composer(props) {
      var state = props.state
      var current = props.current
      var counts = current.data.counts
      var stagedCount = counts.staged
      var amend = state.value.amend
      var canCommit = stagedCount > 0 && state.value.draft.trim().length > 0
      var canAmend = stagedCount > 0 || (counts.worktree === 0 && counts.untracked === 0 && counts.conflict === 0)

      return h(
        'div',
        { className: 'dsh-sg-composer' },
        h('textarea', {
          className: 'dsh-sg-input',
          placeholder: stagedCount > 0 ? '提交信息（' + stagedCount + ' 项已暂存）…' : '先在上方把改动加进暂存区',
          rows: 2,
          value: state.value.draft,
          disabled: stagedCount === 0 && !amend,
          onChange: (event) => state.set({ draft: event.target.value }),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) {
              event.preventDefault()
              submitCommit(state, current)
            }
          },
        }),
        h(
          'div',
          { className: 'dsh-sg-composerRow' },
          h(
            'label',
            { className: 'dsh-sg-amend' + (canAmend ? '' : ' dsh-sg-amendOff') },
            h('input', {
              type: 'checkbox',
              checked: amend,
              disabled: !canAmend,
              onChange: (event) => onAmendToggle(state, event.target.checked),
            }),
            'amend 上一次提交',
          ),
          h(
            'span',
            { className: 'dsh-sg-composerHint' },
            counts.conflict > 0 ? '冲突未解决' : counts.staged === 0 && !amend ? '暂存区为空' : '⌘ Enter 提交',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sg-submit',
              disabled: !canCommit && !(amend && canAmend),
              onClick: () => submitCommit(state, current),
            },
            amend ? 'amend 提交' : '提交 →',
          ),
        ),
      )
    }

    /** Commit (T1): clears the composer on success and refreshes. */
    async function submitCommit(state, current) {
      var message = state.value.draft.trim()
      if (message.length === 0) return
      if (current.data.counts.conflict > 0) return
      try {
        await runOp(state, '/commit', { message: message, amend: state.value.amend })
        state.set({ draft: '', amend: false })
      } catch (error) {
        if (error.code === 'UNMERGED') state.set({ pollError: '合并冲突未解决，先处理后提交' })
      }
    }

    /** Prefill the composer from HEAD when the user turns amend on. */
    async function onAmendToggle(state, on) {
      if (!on) {
        state.set({ amend: false })
        return
      }
      try {
        var payload = await loadCommitsOnce(state)
        var head = payload[0]
        state.set({
          amend: true,
          draft: state.value.draft.trim().length === 0 && head !== undefined ? head.subject + (head.body && head.body.length > 0 ? '\n\n' + head.body : '') : state.value.draft,
        })
      } catch (error) {
        state.set({ amend: true })
      }
    }

    async function loadCommitsOnce(state) {
      var payload = await apiGet('/log?sessionId=' + encodeURIComponent(state.sessionId) + '&limit=1')
      return payload.commits ?? []
    }

    /** Prepare one discard: the preview panel parks its token. */
    async function prepareDiscard(state, paths) {
      try {
        const prepared = await apiPost('/ops/prepare', { sessionId: state.sessionId, op: 'discard', args: { paths: paths } })
        state.set({ confirm: { op: 'discard', token: prepared.token, impact: prepared.impact, note: '丢弃这些文件里所有未暂存的修改（已暂存部分不动）' } })
      } catch (error) {
        state.set({ pollError: translateError(error) })
      }
    }

    /**
     * The T2 confirm panel: floats above the body until the user confirms or
     * bails. Shows what will die before it dies.
     */
    function ConfirmPanel(props) {
      var state = props.state
      var confirm = props.current.confirm
      if (confirm === null) return null
      var impact = confirm.impact ?? {}
      return h(
        'div',
        { className: 'dsh-sg-confirmWrap' },
        h(
          'div',
          { className: 'dsh-sg-confirm' },
          h('div', { className: 'dsh-sg-confirmTitle' }, renderIcon('warning', 14), ' ' + confirmNoteLabel(confirm.op)),
          h('div', { className: 'dsh-sg-confirmNote' }, confirm.note ?? ''),
          h('div', { className: 'dsh-sg-confirmArgv' }, '>' + String((impact.argv ?? []).join(' '))),
          Array.isArray(impact.files) && impact.files.length > 0
            ? h(
                'div',
                { className: 'dsh-sg-confirmFiles' },
                impact.files.map((file) =>
                  h(
                    'div',
                    { key: file.path, className: 'dsh-sg-confirmFile' },
                    file.binary ? file.path + '（二进制）' : file.path + (file.adds || file.dels ? ' +' + file.adds + (file.dels ? ' −' + file.dels : '') : ''),
                  ),
                ),
              )
            : null,
          impact.stash !== undefined
            ? h('div', { className: 'dsh-sg-confirmFiles' }, h('div', { className: 'dsh-sg-confirmFile' }, impact.stash.selector + ' · ' + impact.stash.subject))
            : null,
          h(
            'div',
            { className: 'dsh-sg-confirmRow' },
            h('button', { type: 'button', className: 'dsh-sg-confirmCancel', onClick: () => state.set({ confirm: null }) }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-sg-confirmGo',
                onClick: () => confirmOp(state),
              },
              state.value.busy['confirm'] === true ? '执行中…' : '确认执行',
            ),
          ),
        ),
      )
    }

    function confirmNoteLabel(op) {
      if (op === 'discard') return '丢弃未提交修改'
      if (op === 'stash-pop') return '弹出 stash'
      if (op === 'stash-apply') return '应用 stash'
      if (op === 'stash-drop') return '删除 stash'
      if (op === 'branch-force-delete') return '强制删除分支'
      return op
    }

    /** Fire the parked T2 operation. */
    async function confirmOp(state) {
      var confirm = state.value.confirm
      if (confirm === null) return
      state.set({ busy: Object.assign({}, state.value.busy, { confirm: true }) })
      try {
        var payload = await apiPost('/ops/confirm', { sessionId: state.sessionId, op: confirm.op, token: confirm.token })
        if (payload.repo) repoData.set(payload.repo.root, { at: Date.now(), data: payload })
        state.set({ data: payload, confirm: null, pollError: '' })
        if (state.value.diff !== null) loadDiff(state, state.value.diff.path, state.value.diff.area)
      } catch (error) {
        state.set({ pollError: translateError(error) })
      } finally {
        state.set({ busy: withoutKey(state.value.busy, 'confirm') })
      }
    }

    /** The transient notice line (pollError). */
    function Notice(props) {
      var text = props.current.pollError
      if (text === '') return null
      return h(
        'div',
        { className: 'dsh-sg-notice', role: 'alert' },
        text,
        ' ',
        h('button', { type: 'button', className: 'dsh-sg-noticeClose', onClick: () => props.state.set({ pollError: '' }) }, renderIcon('close', 11)),
      )
    }

    /** The History page. */
    function HistoryTab(props) {
      var state = props.state
      var current = props.current
      if (current.commitsError !== '') {
        return h('div', { className: 'dsh-sg-errorPage' }, current.commitsError, ' ', h('button', { type: 'button', className: 'dsh-sg-groupAction', onClick: () => loadCommits(state, false) }, '重试'))
      }
      if (current.unborn) {
        return h('div', { className: 'dsh-sg-emptyPage' }, '这个分支还没有提交。写下第一个提交后这里会出现历史。')
      }
      if (current.commits.length === 0 && current.commitsLoading) {
        return h('div', { className: 'dsh-sg-emptyPage' }, '读取历史…')
      }
      return h(
        'div',
        { className: 'dsh-sg-history' },
        current.commits.map((commit) => h(CommitRow, { state: state, commit: commit, open: current.openCommit !== null && current.openCommit.hash === commit.hash, current: current, key: commit.hash })),
        current.commitsDone !== true
          ? h(
              'button',
              { type: 'button', className: 'dsh-sg-moreButton', disabled: current.commitsLoading, onClick: () => loadCommits(state, true) },
              current.commitsLoading ? '读取…' : '更多历史',
            )
          : null,
      )
    }

    /** One commit row (expand → files, click file → its diff). */
    function CommitRow(props) {
      var state = props.state
      var commit = props.commit
      var open = props.open
      var openCommit = props.current.openCommit
      var refs = (commit.refs ?? []).filter((name) => name !== 'HEAD' || true)

      return h(
        'div',
        { className: 'dsh-sg-commitWrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-sg-commit' + (open ? ' dsh-sg-commitOpen' : ''),
            onClick: () => (open ? state.set({ openCommit: null }) : loadCommitFiles(state, commit.hash)),
          },
          h('span', { className: 'dsh-sg-commitDot' }, renderIcon('commit', 12)),
          h('span', { className: 'dsh-sg-commitShort' }, commit.short),
          refs.length > 0 ? h('span', { className: 'dsh-sg-commitRefs' }, refs.join(', ')) : null,
          h('span', { className: 'dsh-sg-commitSubject' }, commit.subject),
          h(
            'span',
            { className: 'dsh-sg-commitMeta' },
            commit.author + ' · ' + timeAgo(commit.date),
          ),
          h(
            'span',
            { className: 'dsh-sg-rowActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-sg-rowAction',
                title: '复制完整 hash',
                onClick: (event) => {
                  event.stopPropagation()
                  ui.writeClipboard(commit.hash).catch(() => {})
                },
              },
              renderIcon('copy', 13),
            ),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'dsh-sg-commitBody' },
              commit.body !== '' ? h('div', { className: 'dsh-sg-commitMessage' }, commit.body) : null,
              openCommit.loading ? h('div', { className: 'dsh-sg-emptyPage' }, '读取改动文件…') : null,
              openCommit.error !== undefined ? h('div', { className: 'dsh-sg-errorPage' }, openCommit.error) : null,
              (openCommit.files ?? []).map((file) =>
                h(
                  'div',
                  { key: file.path, className: 'dsh-sg-commitFile' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-sg-commitFileBtn',
                      onClick: () => loadCommitDiff(state, commit.hash, file.path),
                    },
                    h('span', { className: 'dsh-sg-path' }, file.path),
                    h('span', { className: 'dsh-sg-numstat' }, file.binary ? '二进制' : '+' + file.adds + (file.dels ? ' −' + file.dels : '')),
                  ),
                  props.current.commitDiff !== undefined && props.current.commitDiff !== null && props.current.commitDiff.key === 'commit:' + commit.hash + ':' + file.path
                    ? h(DiffPanel, { state: state, diff: { key: props.current.commitDiff.key, loading: props.current.commitDiff.loading === true, stale: false, path: file.path } })
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    /** The Stash page. */
    function StashTab(props) {
      var state = props.state
      var current = props.current
      var rows = current.stashes
      return h(
        'div',
        { className: 'dsh-sg-stashPage' },
        h(
          'div',
          { className: 'dsh-sg-stashHead' },
          h(StashPush, { state: state, current: current }),
        ),
        rows.length === 0 ? h('div', { className: 'dsh-sg-emptyPage' }, '没有 stash。把当前改动存起来，回头再取。') : null,
        rows.map((entry, index) =>
          h(
            'div',
            { className: 'dsh-sg-stashRow', key: entry.selector },
            h('span', { className: 'dsh-sg-stashSelector' }, entry.selector),
            h('span', { className: 'dsh-sg-stashSubject' }, entry.subject),
            h('span', { className: 'dsh-sg-commitMeta' }, timeAgo(entry.date)),
            h(
              'span',
              { className: 'dsh-sg-rowActions' },
              stashAction(state, 'stash-pop', index, 'pop', '弹出（丢弃这份 stash）', current),
              stashAction(state, 'stash-apply', index, 'check', '应用（保留 stash）', current),
              stashAction(state, 'stash-drop', index, 'trash', '删除这份 stash', current),
            ),
          ),
        ),
        current.stashesError !== '' ? h('div', { className: 'dsh-sg-errorPage' }, current.stashesError) : null,
      )
    }

    function stashAction(state, op, index, iconName, label, current) {
      void current
      return h(
        'button',
        {
          type: 'button',
          key: op + index,
          className: 'dsh-sg-rowAction',
          title: label,
          onClick: () => prepareStash(state, op, index, label),
        },
        renderIcon(iconName, 13),
      )
    }

    async function prepareStash(state, op, index, label) {
      try {
        const prepared = await apiPost('/ops/prepare', { sessionId: state.sessionId, op: op, args: { index: index } })
        state.set({ confirm: { op: op, token: prepared.token, impact: prepared.impact, note: label } })
      } catch (error) {
        state.set({ pollError: translateError(error) })
      }
    }

    /** The stash composer row: message + push (T1). */
    function StashPush(props) {
      var state = props.state
      var current = props.current
      var dirty = current.data.counts.worktree + current.data.counts.staged > 0
      return h(
        'span',
        { className: 'dsh-sg-stashPush' },
        h('input', {
          type: 'text',
          className: 'dsh-sg-stashInput',
          placeholder: dirty ? '备注（可选）' : '工作区是干净的',
          disabled: !dirty,
          value: state.value.stashNote ?? '',
          onChange: (event) => state.set({ stashNote: event.target.value }),
          onKeyDown: (event) => {
            if (event.key === 'Enter') pushStash(state)
          },
        }),
        h(
          'button',
          { type: 'button', className: 'dsh-sg-stashGo', disabled: !dirty, onClick: () => pushStash(state) },
          '存入 stash',
        ),
      )
    }

    async function pushStash(state) {
      try {
        await runOp(state, '/stash', { action: 'push', message: state.value.stashNote ?? '' })
        state.set({ stashNote: '' })
        loadStashes(state)
      } catch {
        // surfaced
      }
    }

    /** No-repo empty state: the headline + the manual binding form. */
    function BindCard(props) {
      var state = props.state
      return h(
        'div',
        { className: 'dsh-sg-empty' },
        h('div', { className: 'dsh-sg-emptyIcon' }, renderIcon('branch', 34)),
        h('div', { className: 'dsh-sg-emptyTitle' }, '当前会话不在 git 仓库里'),
        h('div', { className: 'dsh-sg-emptyNote' }, '可以直接绑定一个仓库路径，这个页签就跟着它走。'),
        h('div', { className: 'dsh-sg-bindRow' }, h('input', { type: 'text', className: 'dsh-sg-bindInput', placeholder: '/Users/…/仓库目录', value: state.value.bindPath, onChange: (event) => state.set({ bindPath: event.target.value }) }), h('button', { type: 'button', className: 'dsh-sg-bindGo', onClick: () => submitBinding(state) }, '绑定')),
        state.value.bindError !== '' ? h('div', { className: 'dsh-sg-bindError' }, state.value.bindError) : null,
      )
    }

    async function submitBinding(state) {
      var claimed = (state.value.bindPath ?? '').trim()
      if (claimed.length === 0) return
      try {
        await apiPost('/binding', { sessionId: state.sessionId, repoPath: claimed })
        try {
          window.localStorage.setItem(LAST_REPO_KEY + state.sessionId, claimed)
        } catch {
          // localStorage may be unavailable; the server keeps the binding anyway
        }
        state.set({ bindError: '' })
        bootView(state, state.sessionId)
      } catch (error) {
        state.set({ bindError: translateError(error) })
      }
    }

    /** No-git empty state. */
    function NoGitCard() {
      return h(
        'div',
        { className: 'dsh-sg-empty' },
        h('div', { className: 'dsh-sg-emptyIcon' }, renderIcon('warning', 34)),
        h('div', { className: 'dsh-sg-emptyTitle' }, '本机没有可用的 git'),
        h('div', { className: 'dsh-sg-emptyNote' }, '安装 Xcode Command Line Tools（xcode-select --install）或任意 git 发行版，然后点刷新。'),
        h('button', { type: 'button', className: 'dsh-sg-bindGo', onClick: () => window.location.reload() }, '重试'),
      )
    }

    /** Whether one node is truly on screen (`checkVisibility` + rect + viewport). */
    function isOnScreen(node) {
      if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return true
      if (typeof node.checkVisibility === 'function') {
        try {
          if (node.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) !== true) return false
        } catch {
          // An engine that rejects the options object still gets the rect test.
        }
      }
      var rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      var view = node.ownerDocument === undefined || node.ownerDocument === null ? null : node.ownerDocument.defaultView
      if (view === null || view === undefined) return true
      var width = typeof view.innerWidth === 'number' ? view.innerWidth : 0
      var height = typeof view.innerHeight === 'number' ? view.innerHeight : 0
      if (width <= 0 || height <= 0) return true
      return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
    }

    /** Track this tab body's visibility while a floating layer wants to draw. */
    function useOnScreen(ref, active) {
      var tracked = React.useState(true)
      var onScreen = tracked[0]
      var setOnScreen = tracked[1]
      React.useLayoutEffect(() => {
        if (active !== true) return
        var next = isOnScreen(ref.current)
        if (next !== onScreen) setOnScreen(next)
      })
      return onScreen
    }

    // ── styles ──────────────────────────────────────────────────────────────

    /**
     * The tab's stylesheet. Every value is asked of the shell's design tokens
     * first (`--dsw-*`), with plain fallbacks where a token is known absent —
     * the same approach the chat tab takes; the app's dark mode comes through
     * the tokens.
     */
    var CSS_TEXT = `
.dsh-sg-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px; line-height: 1.5;
  contain: strict; contain: content;
}
.dsh-sg-emptyRoot { justify-content: center; }
.dsh-sg-loading, .dsh-sg-emptyPage, .dsh-sg-errorPage {
  color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55));
  text-align: center; padding: 18px 12px; font-size: 12px;
}
.dsh-sg-errorPage { color: var(--dsw-alias-label-error, #d03050); }
.dsh-sg-body { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding: 0 10px 6px; scrollbar-width: thin; }

.dsh-sg-topbar {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px 6px; flex: none;
}
.dsh-sg-branchChip {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 55%; padding: 3px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  background: none; color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px; cursor: pointer;
}
.dsh-sg-branchChip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-branchName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sg-topActions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.dsh-sg-chip, .dsh-sg-abChip {
  padding: 1px 7px; border-radius: 8px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55));
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
}

.dsh-sg-tabs { display: flex; gap: 14px; padding: 2px 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); flex: none; }
.dsh-sg-tab {
  appearance: none; background: none; border: none; padding: 6px 2px 7px;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55));
  border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer;
}
.dsh-sg-tabOn { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; border-bottom-color: var(--dsw-alias-brand-text, var(--dsw-alias-button-info-fill, #3964FE)); }

.dsh-sg-group { margin-top: 10px; }
.dsh-sg-groupHead { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.dsh-sg-groupTitle { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); letter-spacing: .2px; }
.dsh-sg-groupAction {
  appearance: none; background: none; border: none; padding: 0 4px;
  font-size: 11px; color: var(--dsw-alias-brand-text, var(--dsw-alias-button-info-fill, #3964FE));
  cursor: pointer; border-radius: 6px;
}
.dsh-sg-groupAction:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-groupAction:disabled { opacity: .4; cursor: default; }
.dsh-sg-groupEmpty { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); padding: 2px 0 4px 2px; }
.dsh-sg-clean { padding: 20px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); }

.dsh-sg-rowWrap { margin-bottom: 2px; border-radius: 8px; }
.dsh-sg-rowWrap:has(.dsh-sg-diff) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03)); }
.dsh-sg-row { display: flex; align-items: center; gap: 4px; border-radius: 8px; }
.dsh-sg-rowMain {
  appearance: none; background: none; border: none; padding: 4px 6px;
  display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto;
  color: var(--dsw-alias-label-primary, inherit); text-align: left; cursor: pointer;
  font-size: 12.5px;
}
.dsh-sg-rowMain:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-badge {
  flex: none; width: 18px; height: 18px; border-radius: 5px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 700;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
  color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6));
}
.dsh-sg-badge-add { color: #1a7f37; }
.dsh-sg-badge-del { color: #d03050; }
.dsh-sg-badge-mod { color: #b08d00; }
.dsh-sg-badge-other { color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6)); }
.dsh-sg-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
.dsh-sg-renameFrom { color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); }
.dsh-sg-numstat { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.45)); font-variant-numeric: tabular-nums; }
.dsh-sg-rowActions { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-right: 2px; }
.dsh-sg-rowAction, .dsh-sg-rowChevron {
  appearance: none; background: none; border: none; padding: 3px;
  border-radius: 6px; display: inline-flex; cursor: pointer;
  color: var(--dsw-alias-label-secondary, rgba(0,0,0,.5));
}
.dsh-sg-rowAction:hover, .dsh-sg-rowChevron:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.07)); color: var(--dsw-alias-label-primary, inherit); }
.dsh-sg-rowAction:disabled { opacity: .35; cursor: default; }
.dsh-sg-rowActionBusy { opacity: .5; }

.dsh-sg-diff {
  margin: 2px 6px 6px 28px; padding: 6px 8px; border-radius: 8px; overflow: hidden;
  background: var(--dsw-static-neutral-00, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.45; max-height: 320px; overflow-y: auto; scrollbar-width: thin;
}
.dsh-sg-diff { color: var(--dsw-alias-label-primary, inherit); }
.dsh-sg-diffWrap .dsh-sg-line > span:first-child { white-space: pre-wrap; }
.dsh-sg-diffStale {
  padding: 2px 6px; margin-bottom: 4px; border-radius: 6px;
  background: var(--dsw-alias-state-warn-tertiary, rgba(240,180,0,.12));
  color: var(--dsw-alias-state-warn-label, #9a6b00); font-size: 11px;
  font-family: inherit; cursor: pointer;
}
.dsh-sg-diffBar { display: flex; justify-content: flex-end; }
.dsh-sg-diffToggle {
  appearance: none; background: none; border: none; padding: 0 4px 4px;
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); cursor: pointer;
}
.dsh-sg-hunkHead { color: var(--dsw-alias-brand-text, #3964FE); background: rgba(57,100,254,.06); padding: 1px 0; }
.dsh-sg-line { white-space: pre; }
.dsh-sg-diffWrap .dsh-sg-line { white-space: pre-wrap; word-break: break-all; }
.dsh-sg-lineAdd { background: rgba(26,127,55,.09); }
.dsh-sg-lineDel { background: rgba(208,48,80,.09); }
.dsh-sg-lineMeta { color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); font-style: italic; }

.dsh-sg-composer { flex: none; padding: 8px 10px 10px; }
.dsh-sg-input {
  width: 100%; box-sizing: border-box; resize: none;
  border-radius: 14px; padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff));
  color: var(--dsw-alias-label-primary, inherit); font-size: 12.5px; font-family: inherit;
}
.dsh-sg-input:focus { outline: none; border-color: var(--dsw-alias-brand-text, #3964FE); }
.dsh-sg-composerRow { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.dsh-sg-amend { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55)); cursor: pointer; }
.dsh-sg-amendOff { opacity: .45; }
.dsh-sg-composerHint { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); }
.dsh-sg-submit {
  appearance: none; border: none; cursor: pointer;
  background: var(--dsw-alias-button-info-fill, #3964FE); color: #fff;
  border-radius: 16px; padding: 5px 14px; font-size: 12.5px; font-weight: 600;
}
.dsh-sg-submit:disabled { opacity: .4; cursor: default; }

.dsh-sg-banner {
  margin: 0 10px 6px; padding: 6px 10px; border-radius: 8px; font-size: 11.5px;
  display: flex; align-items: center; gap: 6px; flex: none;
}
.dsh-sg-banner-warning { background: var(--dsw-alias-state-warn-tertiary, rgba(240,180,0,.12)); color: var(--dsw-alias-state-warn-label, #9a6b00); }
.dsh-sg-banner-info { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6)); }

.dsh-sg-notice {
  margin: 4px 10px; padding: 6px 10px; border-radius: 8px; flex: none;
  font-size: 11.5px; display: flex; align-items: center;
  background: var(--dsw-alias-state-error-primary, rgba(208,48,80,.08));
  color: var(--dsw-alias-label-error, #d03050);
}
.dsh-sg-noticeClose { margin-left: auto; appearance: none; background: none; border: none; color: inherit; cursor: pointer; display: inline-flex; }

.dsh-sg-confirmWrap { position: absolute; inset: 0; z-index: 30; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.25)); display: flex; align-items: center; justify-content: center; padding: 14px; }
.dsh-sg-confirm { width: 100%; max-width: 420px; border-radius: 14px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); box-shadow: 0 12px 40px rgba(0,0,0,.18); }
.dsh-sg-confirmTitle { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.dsh-sg-confirmNote { margin: 6px 0 4px; font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6)); }
.dsh-sg-confirmArgv {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; padding: 5px 8px; border-radius: 6px; margin: 4px 0 8px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); word-break: break-all;
  color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65));
}
.dsh-sg-confirmFiles { margin-bottom: 8px; max-height: 160px; overflow-y: auto; scrollbar-width: thin; }
.dsh-sg-confirmFile { font-size: 11.5px; padding: 2px 4px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65)); }
.dsh-sg-confirmRow { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sg-confirmCancel { appearance: none; background: none; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); color: var(--dsw-alias-label-primary, inherit); border-radius: 12px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
.dsh-sg-confirmGo { appearance: none; border: none; border-radius: 12px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 600; background: var(--dsw-alias-state-error-primary, #d03050); color: #fff; }
.dsh-sg-confirmGo:disabled { opacity: .5; cursor: default; }

.dsh-sg-history, .dsh-sg-stashPage { padding-top: 8px; }
.dsh-sg-commitWrap { border-radius: 8px; }
.dsh-sg-commitWrap:has(.dsh-sg-diff) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03)); }
.dsh-sg-commit {
  appearance: none; background: none; border: none; width: 100%; box-sizing: border-box;
  display: flex; align-items: center; gap: 6px; padding: 5px 6px; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit); font-size: 12.5px; text-align: left; border-radius: 8px;
}
.dsh-sg-commit:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-commitDot { flex: none; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.35)); display: inline-flex; }
.dsh-sg-commitShort { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-brand-text, #3964FE); }
.dsh-sg-commitRefs { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); border-radius: 6px; padding: 0 5px; }
.dsh-sg-commitSubject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
.dsh-sg-commitMeta { flex: none; margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); white-space: nowrap; }
.dsh-sg-commitBody { margin: 2px 6px 6px 26px; padding: 6px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03)); }
.dsh-sg-commitMessage { font-size: 11.5px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6)); white-space: pre-wrap; margin-bottom: 4px; }
.dsh-sg-commitFile { margin: 2px 0; }
.dsh-sg-commitFileBtn {
  appearance: none; background: none; border: none; padding: 3px 6px; cursor: pointer;
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border-radius: 6px;
  color: var(--dsw-alias-label-primary, inherit); font-size: 12px;
}
.dsh-sg-commitFileBtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-moreButton {
  appearance: none; background: none; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  border-radius: 12px; padding: 4px 14px; margin: 8px auto 4px; display: block; cursor: pointer;
  font-size: 11.5px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.6));
}
.dsh-sg-moreButton:disabled { opacity: .5; cursor: default; }

.dsh-sg-stashHead { margin-bottom: 6px; }
.dsh-sg-stashPush { display: flex; align-items: center; gap: 6px; padding: 2px 2px 8px; }
.dsh-sg-stashInput {
  flex: 1 1 auto; min-width: 0; border-radius: 10px; padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff));
  color: var(--dsw-alias-label-primary, inherit); font-size: 12px;
}
.dsh-sg-stashGo {
  appearance: none; border: none; cursor: pointer; border-radius: 12px; padding: 5px 12px;
  font-size: 12px; font-weight: 600; background: var(--dsw-alias-button-info-fill, #3964FE); color: #fff;
}
.dsh-sg-stashGo:disabled { opacity: .4; cursor: default; }
.dsh-sg-stashRow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; }
.dsh-sg-stashRow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-stashSelector { flex: none; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-brand-text, #3964FE); }
.dsh-sg-stashSubject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; font-size: 12.5px; }

.dsh-sg-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px 18px; text-align: center; }
.dsh-sg-emptyIcon { color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.3)); }
.dsh-sg-emptyTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dsh-sg-emptyNote { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55)); max-width: 300px; }
.dsh-sg-bindRow { display: flex; gap: 6px; width: 100%; max-width: 340px; }
.dsh-sg-bindInput {
  flex: 1 1 auto; min-width: 0; border-radius: 12px; padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff));
  color: var(--dsw-alias-label-primary, inherit); font-size: 12px;
}
.dsh-sg-bindGo {
  appearance: none; border: none; cursor: pointer; border-radius: 12px; padding: 6px 14px;
  font-size: 12px; font-weight: 600; background: var(--dsw-alias-button-info-fill, #3964FE); color: #fff;
}
.dsh-sg-bindError { font-size: 11.5px; color: var(--dsw-alias-label-error, #d03050); }

.dsh-sg-branchRow { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-sg-branchRowName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sg-branchRowDate { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.4)); white-space: nowrap; }
.dsh-sg-newBranchRow { display: flex; gap: 6px; align-items: center; padding: 2px; }
.dsh-sg-newBranchInput {
  flex: 1 1 auto; min-width: 150px; border-radius: 8px; padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fff));
  color: var(--dsw-alias-label-primary, inherit); font-size: 12px;
}
.dsh-sg-newBranchGo {
  appearance: none; border: none; cursor: pointer; border-radius: 8px; padding: 4px 10px;
  font-size: 11.5px; background: var(--dsw-alias-button-info-fill, #3964FE); color: #fff;
}
.dsh-sg-menuError { font-size: 11.5px; color: var(--dsw-alias-label-error, #d03050); }
.dsh-sg-icon { vertical-align: -2px; }

/* fallback faces (the kit-less deployment still reads) */
.dsh-sg-fbButton { appearance: none; background: none; border: none; padding: 3px 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; border-radius: 6px; }
.dsh-sg-fbButton:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-fbButton:disabled { opacity: .4; cursor: default; }
.dsh-sg-fbPill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background: none; font-size: 12px; cursor: pointer; }
button.dsh-sg-fbPillOn { background: var(--dsw-alias-button-info-fill, #3964FE); color: #fff; }
.dsh-sg-fbTooltip { display: inline-flex; }
.dsh-sg-fbAnchor { position: relative; display: inline-flex; }
.dsh-sg-fbMenu {
  position: fixed; z-index: 60; min-width: 190px; max-width: 300px; max-height: 320px; overflow-y: auto;
  border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 10px 36px rgba(0,0,0,.16); padding: 4px;
}
.dsh-sg-fbMenuList { display: flex; flex-direction: column; }
.dsh-sg-fbMenuRow {
  appearance: none; background: none; border: none; text-align: left; padding: 5px 8px;
  border-radius: 7px; cursor: pointer; font-size: 12px;
  color: var(--dsw-alias-label-primary, inherit); display: flex; align-items: center; gap: 6px;
}
.dsh-sg-fbMenuRow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-sg-fbMenuRow:disabled { opacity: .45; cursor: default; }
.dsh-sg-fbMenuOn { font-weight: 600; }
.dsh-sg-fbMenuDanger { color: var(--dsw-alias-label-error, #d03050); }
.dsh-sg-fbMenuSep { height: 1px; margin: 3px 4px; background: var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
`

    /** Mount (or replace) this plugin's stylesheet once per document. */
    function ensureStyles(workerDocument) {
      var doc = workerDocument === undefined ? (typeof document === 'undefined' ? null : document) : workerDocument
      if (doc === null || typeof doc.createElement !== 'function') return null
      var found = doc.getElementById(STYLE_ID)
      if (found !== null) return found
      var style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      doc.head?.appendChild?.(style)
      return style
    }

    // ── registration ────────────────────────────────────────────────────────

    /**
     * Register the tab type and both of its seats.
     *
     * `inject` lists cordis service names; the tab type registers through
     * `ctx.inject` because the registry service arrives a moment after the
     * native seat declares its slot, while the two slot bodies go through
     * `ctx.slots.inject` because the seats themselves belong to that package.
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ensureStyles()

      ctx.inject(['sidebarRightTabs'], (injected) => {
        var tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined || tabs === null) return undefined

        var disposeType = tabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: 'extension',
          // A diff open under the cursor must survive the sidebar losing the
          // seat (another tab activated, the column collapsed).
          keepMounted: true,
          title: () => TAB_TITLE,
          guide: [
            {
              id: 'git',
              order: 44,
              title: () => TAB_TITLE,
              description: () => '跟随当前会话仓库的变更、提交与分支',
              icon: (iconProps) => renderIcon('branch', iconProps && iconProps.size ? iconProps.size : 16),
            },
          ],
        })

        var disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TYPE_ID,
              inject: (sessionId) => ({ sessionId: sessionId }),
            },
            GitBody,
          ),
        )
        var disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, GitTitle),
        )

        ctx.logger?.info?.('[sidebar-git] 侧边栏页签已注册（组件库' + (ui.usingKit ? '已' : '未') + '加载）')
        return () => {
          disposeTitle()
          disposeBody()
          disposeType()
        }
      })
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply: apply,
      /** Exported for tests and the guide entry's glyph reuse. */
      _internal: {
        KIND: KIND,
        TYPE_ID: TYPE_ID,
        ROUTE: ROUTE,
        stateOf: stateOf,
        RepoView: RepoView,
        ui: ui,
        ensureStyles: ensureStyles,
        isOnScreen: isOnScreen,
        apiGet: apiGet,
        apiPost: apiPost,
        overviewFor: overviewFor,
        loadUi: loadUi,
        FALLBACK_ICONS: FALLBACK_ICONS,
      },
    }

    return module.exports
  },
})
