/**
 * Host half of dsh-sidebar-git.
 *
 * One job: be the backend of a sidebar Git tab that follows the repository the
 * sidebar's own session works in. It owns exactly three things and nothing else:
 *
 *   - `/dsh-sidebar-git/*` over the harness web server: one aggregate overview
 *     poll, the read routes (diff, log, branches, stashes) and the write
 *     routes (stage, unstage, commit, branch, push, pull, stash, binding);
 *   - the session → repository resolution chain, persisted for manual rebinding
 *     under `${DSH_HOME}/dsh-sidebar-git/`;
 *   - the safety rails from the design: every git argument is assembled from
 *     fixed argv templates, every destructive operation goes through the
 *     prepare→confirm gate, and every mutation of one repository serializes
 *     through a queue.
 *
 * It never touches credentials (git's own helpers own them), never runs a
 * shell, never exposes a "run any git command" seam, and never writes outside
 * its own plugin directory or through git itself.
 *
 * @module dsh-sidebar-git
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createBindingStore, createResolver, originTailOf } from './binding.js'
import { classifyGitFailure, createGitRunner, GitError } from './git.js'
import {
  actionOf,
  createGate,
  intInRange,
  normalizeAbsolutePath,
  normalizeCommitMessage,
  normalizeRepoPath,
  T2_OPS,
} from './guard.js'
import { createQueue } from './queue.js'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  attachCounts,
  groupOf,
  parseBranches,
  parseDiff,
  parseLog,
  parseNumstat,
  parseStashes,
  parseStatus,
  sortByDisplay,
} from './parse.js'

/** Plugin identity: equals the package name and the Loader row name. */
export const name = 'dsh-sidebar-git'

/**
 * Services this plugin needs before routes register: the HTTP prefix, the
 * subprocess capability git runs through, and the session store that names the
 * repository the tab follows.
 */
export const inject = ['webServer', 'subprocess', 'sessions']

/** Path prefix this plugin owns on the harness web server. */
export const ROUTE = '/dsh-sidebar-git'

/** Largest accepted JSON body (path lists and commit messages are small). */
const MAX_BODY_BYTES = 256 * 1024

/** How long one overview snapshot is reused before the next poll rebuilds it. */
const OVERVIEW_TTL_MS = 800

/** How far one log page goes. */
const LOG_PAGE_MAX = 200

/**
 * Resolve the harness home holding this deployment's data.
 *
 * `dshHomePath` is the harness' own resolver and the only authoritative answer;
 * `$DSH_HOME` and `~/.dsh` stay as fallbacks so a deployment that did not
 * export the variable still reads the home it booted with.
 *
 * @param ctx - host plugin context.
 * @returns an absolute harness home path.
 */
export function resolveHarnessHome(ctx) {
  const candidates = []
  try {
    const service = ctx?.get?.('dshHomePath')
    if (typeof service === 'function') candidates.push(service())
    else if (typeof service === 'string') candidates.push(service)
  } catch {
    // A missing service must not stop the plugin from loading.
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) candidates.push(fromEnv.trim())
  candidates.push(join(homedir(), '.dsh'))
  const usable = candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of usable) {
    if (existsSync(join(candidate, 'sessions'))) return resolve(candidate)
  }
  return resolve(usable[0] ?? join(homedir(), '.dsh'))
}

/**
 * Register the plugin.
 * @param ctx - host plugin context carrying webServer, subprocess and sessions.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const subprocess = ctx.get('subprocess')
  const home = resolveHarnessHome(ctx)
  const pluginDir = join(home, 'dsh-sidebar-git')

  const runner = createGitRunner({ subprocess, lifetime: undefined, logger: ctx.logger })
  const bindings = createBindingStore({ dir: pluginDir, logger: ctx.logger })
  const resolver = createResolver()
  const gate = createGate()
  const queue = createQueue()

  /** One overview snapshot per repository root, reused for 800ms. */
  const overviewCache = new Map()

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => {
          Promise.resolve(dispatch(req, res)).catch((error) => {
            ctx.logger?.warn?.(`[sidebar-git] 处理 ${req.url ?? ''} 失败：${String(error)}`)
            if (res.headersSent) {
              try {
                res.end()
              } catch {
                // The peer is already gone; nothing left to answer.
              }
              return
            }
            sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } })
          })
        },
      }),
    'dsh-sidebar-git: routes',
  )

  ctx.logger?.info?.(`[sidebar-git] 路由已注册：${ROUTE}（数据目录 ${pluginDir}）`)

  /**
   * One dispatch turn: route string + method → handler.
   * @param req - node:http request.
   * @param res - node:http response.
   */
  async function dispatch(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const query = url.searchParams

    if (method === 'GET' && (path === '/' || path === '/info')) {
      return sendJson(res, 200, { ok: true, plugin: name, home: pluginDir, bindingsFile: bindings.file, gateTokens: gate.size })
    }

    // Reads ───────────────────────────────────────────────────────── T0
    if (path === '/repo' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...(await resolveRepo(query.get('sessionId'))) })
    }

    if (path === '/overview' && method === 'GET') {
      // `force=1` is the manual refresh / test-after-external-mutation path;
      // ordinary polls ride the short cache that keeps multi-instance tabs calm.
      return sendJson(res, 200, await readOverview(query.get('sessionId'), { force: query.get('force') === '1' }))
    }

    if (path === '/diff' && method === 'GET') {
      return sendJson(res, 200, await wrapErrors(() => readDiff(query)))
    }

    if (path === '/log' && method === 'GET') {
      return sendJson(res, 200, await wrapErrors(() => readLog(query)))
    }

    if (path === '/commitfiles' && method === 'GET') {
      return sendJson(res, 200, await wrapErrors(() => readCommitFiles(query)))
    }

    if (path === '/branches' && method === 'GET') {
      return sendJson(res, 200, await wrapErrors(() => readBranches(query.get('sessionId'))))
    }

    if (path === '/stashes' && method === 'GET') {
      return sendJson(res, 200, await wrapErrors(() => readStashes(query.get('sessionId'))))
    }

    // Writes ──────────────────────────────────────────────────────── T1
    if (path === '/stage' || path === '/unstage') {
      if (method === 'GET') return notFound(req, res, path, method)
      return stageRoute(req, res, path === '/stage' ? 'add' : 'reset')
    }

    if (path === '/commit' && method === 'POST') {
      return commitRoute(req, res)
    }

    if (path === '/branch' && method === 'POST') {
      return branchRoute(req, res)
    }

    if (path === '/push' && method === 'POST') {
      return syncRoute(req, res, 'push')
    }

    if (path === '/pull' && method === 'POST') {
      return syncRoute(req, res, 'pull')
    }

    if (path === '/stash' && method === 'POST') {
      return stashRoute(req, res)
    }

    if (path === '/binding' && method === 'POST') {
      return bindingRoute(req, res)
    }

    // The T2 gate ─────────────────────────────────────────────────── T2
    if (path === '/ops/prepare' && method === 'POST') {
      return prepareRoute(req, res)
    }

    if (path === '/ops/confirm' && method === 'POST') {
      return confirmRoute(req, res)
    }

    return notFound(req, res, path, method)
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Turn any thrown error of a read into the JSON shape the client knows. */
  async function wrapErrors(runner) {
    try {
      return await runner()
    } catch (error) {
      return gitErrorPayload(error)
    }
  }

  /**
   * Resolve which repository one session's tab manages.
   *
   * @param sessionId - the sidebar slot's session id.
   * @returns `{repo: {root, display, source}|null, reason?, git?}`.
   */
  async function resolveRepo(sessionId) {
    const git = await runner.resolve()
    if (!git.available) {
      return { repo: null, reason: git.reason === 'GIT_XCODE_STUB' ? 'GIT_XCODE_STUB' : 'GIT_MISSING' }
    }
    const info = await resolveRepoInfo(sessionId)
    return { repo: info.repo, reason: info.reason }
  }

  /**
   * The binding chain: a manual binding first (must still validate), then the
   * session's own working directory. Cached briefly per session.
   *
   * @param sessionId - the session id.
   * @returns `{repo: {root, display, source}|null, reason?}`.
   */
  async function resolveRepoInfo(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { repo: null, reason: 'NO_SESSION' }
    }
    const answer = await resolver.answer(sessionId, async () => {
      const manual = await bindings.manualPathAlive(sessionId)
      if (manual !== undefined) {
        const root = await locateRoot(manual)
        if (root !== undefined) return { root, source: 'manual' }
        // The manual target is gone; forget it so the session chain resumes.
        await bindings.delete(sessionId)
      }

      let cwd = undefined
      try {
        const session = ctx.sessions.get(sessionId)
        cwd = session?.header?.cwd
      } catch {
        // An absent session service must not kill binding; manual is the path.
      }
      if (typeof cwd === 'string' && cwd.length > 0) {
        const root = await locateRoot(cwd)
        if (root !== undefined) return { root, source: 'session' }
        return { root: undefined, source: 'session', reason: 'NO_REPO' }
      }
      return { root: undefined, source: 'none', reason: 'NO_SESSION' }
    })

    if (typeof answer?.root === 'string') {
      return { repo: { root: answer.root, display: answer.root, source: answer.source } }
    }
    return { repo: null, reason: answer?.reason ?? 'NO_REPO' }
  }

  /**
   * One probe: is this path inside a git work tree, and where is the root?
   *
   * @param path - any directory path.
   * @returns the absolute repository root, or `undefined`.
   */
  async function locateRoot(path) {
    try {
      const result = await runner.mustRun(
        ['rev-parse', '--show-toplevel', '--is-inside-work-tree', '--absolute-git-dir'],
        { cwd: path },
        '定位仓库',
      )
      const lines = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      if (lines[1] !== 'true') return undefined // a bare repository or the .git dir
      return resolve(lines[0])
    } catch (error) {
      if (error instanceof GitError && (error.code === 'GIT_TIMEOUT' || error.code === 'GIT_MISSING')) throw error
      return undefined
    }
  }

  /**
   * One overview snapshot: branch header, the file groups and the state hash.
   *
   * @param sessionId - the asking session.
   * @param options - `force` skips the 800ms cache (after our own writes).
   * @returns the aggregate payload (always a full answer, `repo: null` included).
   */
  async function readOverview(sessionId, options = {}) {
    const git = await runner.resolve()
    if (!git.available) {
      return { ok: true, rev: '', repo: null, reason: git.reason === 'GIT_XCODE_STUB' ? 'GIT_XCODE_STUB' : 'GIT_MISSING' }
    }
    const repoInfo = await resolveRepoInfo(sessionId)
    if (repoInfo.repo === null) {
      return { ok: true, rev: '', repo: null, reason: repoInfo.reason }
    }

    const root = repoInfo.repo.root
    const cached = overviewCache.get(root)
    if (options.force !== true && cached !== undefined && Date.now() - cached.at < OVERVIEW_TTL_MS) {
      return cached.payload
    }

    let cwdTail = ''
    try {
      const cwd = ctx.sessions.get(sessionId)?.header?.cwd
      if (typeof cwd === 'string') cwdTail = originTailOf(root, cwd)
    } catch {
      // Manual bindings may outlive the session object; display falls back to
      // repository-relative paths.
    }

    const [status, workCounts, stagedCounts, stashList] = await Promise.all([
      runner.mustRun(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=no'], { cwd: root }, '读取状态'),
      runner.mustRun(['diff', '--numstat', '-z'], { cwd: root }, '统计改动'),
      runner.mustRun(['diff', '--numstat', '-z', '--cached'], { cwd: root }, '统计暂存'),
      runner.mustRun(['stash', 'list', `--format=${STASH_FORMAT}`], { cwd: root }, '列出 stash'),
    ])
    if (status.truncated || workCounts.truncated || stagedCounts.truncated) {
      // A repository so loud git's own output hit the cap: answer with the
      // honest failure instead of a silently wrong list.
      throw new GitError('GIT_ERROR', '仓库输出超出上限，请在仓库里缩小或清理未跟踪文件')
    }

    const parsed = parseStatus(status.stdout, { originTail: cwdTail })
    attachCounts(parsed.files, parseNumstat(stagedCounts.stdout), 'staged')
    attachCounts(parsed.files, parseNumstat(workCounts.stdout), 'worktree')
    const stashes = parseStashes(stashList.stdout)
    const groups = groupFiles(parsed.files)
    const branch = {
      name: parsed.branch.detached ? '' : parsed.branch.head,
      upstream: parsed.branch.upstream,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      detached: parsed.branch.detached,
      unborn: parsed.branch.unborn,
      oid: parsed.branch.oid,
    }
    const files = [...groups.staged, ...groups.worktree, ...groups.untracked, ...groups.conflict]
    const payload = {
      ok: true,
      rev: stateRev(branch, files, stashes.length),
      repo: repoInfo.repo,
      branch,
      groups,
      counts: {
        staged: groups.staged.length,
        worktree: groups.worktree.length,
        untracked: groups.untracked.length,
        conflict: groups.conflict.length,
      },
      stashes: stashes.length,
    }
    overviewCache.set(root, { at: Date.now(), payload })
    return payload
  }

  /** Group the flat file list into the four groups the UI renders. */
  function groupFiles(files) {
    const groups = { staged: [], worktree: [], untracked: [], conflict: [] }
    for (const entry of files) groups[groupOf(entry)].push(entry)
    for (const list of Object.values(groups)) sortByDisplay(list)
    return groups
  }

  /**
   * The state hash the client compares between polls: branch tip, the
   * ahead/behind pair, one fingerprint per file's XY and the stash count. It
   * notices every change git itself can see, however it was made — so no
   * filesystem watcher is needed for the tab to notice terminal edits.
   */
  function stateRev(branch, files, stashCount) {
    const parts = [
      branch.unborn ? 'initial' : branch.oid,
      `+${branch.ahead}-${branch.behind}`,
      String(files.length),
      String(stashCount),
    ]
    for (const file of files) parts.push(`${file.xy}:${file.path}`)
    const joined = parts.join('\n')
    let hash = 5381
    for (let at = 0; at < joined.length; at += 1) hash = ((hash << 5) + hash + joined.charCodeAt(at)) | 0
    return `${hash >>> 0}`
  }

  /**
   * One file's diff: worktree, staged, or one commit's version of it.
   *
   * @param query - URLSearchParams with `path`, `area` (`staged|worktree`),
   *   optional `commit`, `sessionId`.
   */
  async function readDiff(query) {
    const repo = await repoFor(query.get('sessionId'))
    if (repo.root === undefined) return repoFail(repo)
    const path = normalizeRepoPath(query.get('path'), repo.root)
    const area = actionOf(query.get('area'), ['staged', 'worktree'], undefined)
    const commit = typeof query.get('commit') === 'string' && query.get('commit').length > 0 ? query.get('commit') : undefined
    if (path === undefined || (area === undefined && commit === undefined)) {
      return { ok: false, error: { code: 'BAD_ARGS', message: 'diff 需要 path 与 area 或 commit' } }
    }
    if (commit !== undefined && !/^[0-9a-fA-F~^./-]{1,64}$/.test(commit)) {
      return { ok: false, error: { code: 'BAD_ARGS', message: 'commit 只接受 hash 形状' } }
    }

    let args
    if (commit !== undefined) {
      // `git show` covers the root commit; the header braces collapse in the parser.
      args = ['show', '--no-color', '-U3', '--format=', commit, '--', path]
    } else if (area === 'staged') {
      args = ['diff', '--cached', '--no-color', '-U3', '--', path]
    } else {
      args = ['diff', '--no-color', '-U3', '--', path]
    }
    const result = await runner.mustRun(args, { cwd: repo.root }, '读取 diff')
    if (result.truncated) {
      return { ok: true, path, area, commit, oversized: true, binary: false, hunks: [] }
    }
    const parsed = parseDiff(result.stdout)
    return { ok: true, path, area, commit, binary: parsed.binary, oversized: false, hunks: parsed.hunks }
  }

  /**
   * One page of history.
   *
   * @param query - URLSearchParams with `limit`, `offset`, optional `path`
   *   (file history), `sessionId`.
   */
  async function readLog(query) {
    const repo = await repoFor(query.get('sessionId'))
    if (repo.root === undefined) return repoFail(repo)
    const limit = intInRange(query.get('limit'), 1, LOG_PAGE_MAX, 50)
    const offset = intInRange(query.get('offset'), 0, 100_000, 0)
    const file = normalizeRepoPath(query.get('path'), repo.root)

    const args = ['log', '--no-color', '--date=iso-strict', `--max-count=${limit}`]
    if (offset > 0) args.push(`--skip=${offset}`)
    args.push(`--format=${LOG_FORMAT}`)
    if (file !== undefined) args.push('--', file)
    let result
    try {
      result = await runner.mustRun(args, { cwd: repo.root }, '读取历史')
    } catch (error) {
      // An unborn HEAD has no history of any kind; the empty page is the answer.
      if (error instanceof GitError && /does not have any commits yet|unborn HEAD/i.test(error.message)) {
        return { ok: true, commits: [], done: true, unborn: true }
      }
      throw error
    }
    const commits = parseLog(result.stdout)
    return { ok: true, commits, done: commits.length < limit }
  }

  /**
   * One commit's changed-file list for the history detail: `diff-tree --root
   * --numstat -z -r`, whose NUL records share parseNumstat's format. `--root`
   * makes the very first commit list its additions; the commit argument is a
   * plain hex hash (no option-shaped values ever reach argv).
   *
   * @param query - URLSearchParams with `sessionId`, `commit`.
   */
  async function readCommitFiles(query) {
    const repo = await repoFor(query.get('sessionId'))
    if (repo.root === undefined) return repoFail(repo)
    const commit = query.get('commit')
    if (typeof commit !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(commit)) {
      return { ok: false, error: { code: 'BAD_ARGS', message: 'commitfiles 需要合法的 commit（十六进制 hash）' } }
    }
    const result = await runner.mustRun(['diff-tree', '--root', '--no-commit-id', '--numstat', '-z', '-r', commit], { cwd: repo.root }, '统计提交改动')
    const counts = parseNumstat(result.stdout)
    const files = [...counts.entries()]
      .map(([path, record]) => ({ path, adds: record.adds ?? 0, dels: record.dels ?? 0, binary: record.binary === true, ...(record.renamedFrom !== undefined ? { renamedFrom: record.renamedFrom } : {}) }))
      .sort((one, other) => (one.path < other.path ? -1 : one.path > other.path ? 1 : 0))
    return { ok: true, commit, files }
  }

  /** The branch list with the current branch marked. */
  async function readBranches(sessionId) {
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoFail(repo)
    const result = await runner.mustRun(
      ['branch', '--no-color', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate'],
      { cwd: repo.root },
      '列出分支',
    )
    return { ok: true, branches: parseBranches(result.stdout) }
  }

  /** The stash list. */
  async function readStashes(sessionId) {
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoFail(repo)
    const result = await runner.mustRun(['stash', 'list', `--format=${STASH_FORMAT}`], { cwd: repo.root }, '列出 stash')
    return { ok: true, stashes: parseStashes(result.stdout) }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Stage or unstage one path list. `mode` is the argv verb family. */
  async function stageRoute(req, res, mode) {
    const body = await readJson(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    let paths
    try {
      paths = claimPaths(body?.paths)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_ARGS', message: String(error?.message ?? error) } })
    }
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    try {
      await queue.run(repo.root, async () => {
        if (mode === 'add') await runner.mustRun(['add', '--', ...paths], { cwd: repo.root }, '暂存')
        else await runner.mustRun(['reset', '-q', '--', ...paths], { cwd: repo.root }, '取消暂存') // index-only, never --hard
      })
      invalidate(repo.root)
      return sendJson(res, 200, { ok: true, changed: paths, ...(await readOverview(sessionId, { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * One commit. The message travels on stdin, never through argv.
   *
   * @param body - `{sessionId, message, amend?}`.
   */
  async function commitRoute(req, res) {
    const body = await readJson(req)
    const message = normalizeCommitMessage(body?.message)
    if (message === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_MESSAGE', message: '提交信息不能为空（且不超过 4KB）' } })
    }
    const amend = body?.amend === true
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    try {
      const commit = await queue.run(repo.root, async () => {
        const args = amend ? ['commit', '--amend', '-F', '-'] : ['commit', '-F', '-']
        const result = await runner.run(args, { cwd: repo.root, stdin: `${message}\n` })
        if (result.exitCode !== 0) {
          // git writes its "nothing to commit" hints to stdout, so both streams
          // participate in the classification.
          throw classifyAs(result.stdout + '\n' + result.stderr, result.exitCode)
        }
        invalidate(repo.root)
        const head = await runner.mustRun(['log', '-1', '--no-color', '--format=%H%x00%h%x00%s'], { cwd: repo.root }, '读取提交')
        const fields = head.stdout.trim().split('\u0000')
        return { hash: fields[0] ?? '', short: fields[1] ?? '', subject: fields[2] ?? '', amend }
      })
      return sendJson(res, 200, { ok: true, commit, ...(await readOverview(sessionId, { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Branch operations, one route: `create`（新建并切换）、`checkout`、`delete`.
   * Names run through `git check-ref-format --branch` before any argv is built,
   * and deletion is `branch -d` only — git refuses unmerged tips, and the -D
   * escape is its own confirmed operation (`ops/prepare branch-force-delete`).
   */
  async function branchRoute(req, res) {
    const body = await readJson(req)
    const action = actionOf(body?.action, ['create', 'checkout', 'delete'])
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    if (action === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_ARGS', message: 'branch 需要 action create|checkout|delete' } })
    }
    const claim = typeof body?.name === 'string' ? body.name.trim() : ''
    try {
      if (claim.length === 0 || claim.startsWith('-')) {
        throw new GitError('BAD_REF', '分支名不能为空且不能以 - 开头')
      }
      await runner.mustRun(['check-ref-format', '--branch', claim], { cwd: repo.root }, '校验分支名')

      await queue.run(repo.root, async () => {
        if (action === 'create') {
          // Create then switch: a brand-new branch shares its parent's tip,
          // so the checkout can never clash with local modifications.
          await runner.mustRun(['branch', claim], { cwd: repo.root }, '创建分支')
          await runner.mustRun(['checkout', claim], { cwd: repo.root }, '切换分支')
        } else if (action === 'checkout') {
          await runner.mustRun(['checkout', claim], { cwd: repo.root }, '切换分支')
        } else {
          await runner.mustRun(['branch', '-d', claim], { cwd: repo.root }, '删除分支')
        }
      })
      invalidate(repo.root)
      return sendJson(res, 200, { ok: true, branchOp: { action, name: claim }, ...(await readOverview(sessionId, { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Push and pull: one route shape. Push carries no force channel; pull is
   * hard-bound to `--ff-only` (a non-ff situation fails with a hint to do the
   * merge in a terminal, never automatically).
   */
  async function syncRoute(req, res, kind) {
    const body = await readJson(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    try {
      const head = await currentBranch(repo)
      if (head.unborn) throw new GitError('NO_UPSTREAM', kind === 'push' ? '空仓库还没有可推送的提交' : '空仓库还没有可拉取的分支')
      if (head.detached) throw new GitError('NO_UPSTREAM', '当前处于 detached HEAD；分支级 push/pull 请先切回分支（或回终端操作）')
      if (head.upstream === undefined || head.upstream === '') {
        if (kind === 'pull') {
          throw new GitError('NO_UPSTREAM', '当前分支还没有 upstream，无法拉取；先推送一次（可设置 upstream）')
        }
        if (body?.setUpstream !== true) {
          throw new GitError('NO_UPSTREAM', '当前分支还没有 upstream；勾选「设置 upstream」后重试')
        }
        const remote = await firstRemote(repo)
        const updates = await queue.run(repo.root, async () => {
          const result = await runner.run(['push', '-u', remote, head.name], { cwd: repo.root, timeoutMs: 90_000 })
          if (result.exitCode !== 0) throw classifyAs(result.stderr, result.exitCode)
          return parseStatusUpdates(result.stderr)
        })
        invalidate(repo.root)
        return sendJson(res, 200, { ok: true, updates, setUpstream: true, ...(await readOverview(sessionId, { force: true })) })
      }

      const argv = kind === 'pull' ? ['pull', '--ff-only', '--no-rebase'] : ['push', '--verbose']
      const updates = await queue.run(repo.root, async () => {
        const result = await runner.run(argv, { cwd: repo.root, timeoutMs: kind === 'pull' ? 90_000 : 60_000 })
        if (result.exitCode !== 0) throw classifyAs(result.stderr, result.exitCode)
        return parsePuArrow(result.stderr)
      })
      invalidate(repo.root)
      return sendJson(res, 200, { ok: true, updates, ...(await readOverview(sessionId, { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Stash: only `push` (T1). pop/apply/drop must go through the prepare gate,
   * so this route accepts no other action by construction.
   */
  async function stashRoute(req, res) {
    const body = await readJson(req)
    const action = actionOf(body?.action, ['push'])
    if (action === undefined) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'CONFIRM_REQUIRED', message: 'stash pop/apply/drop 属破坏型操作，请先经 /ops/prepare 确认' },
      })
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    const repo = await repoFor(sessionId)
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    const message = typeof body?.message === 'string' ? body.message.trim().slice(0, 200) : ''
    try {
      await queue.run(repo.root, async () => {
        const args = ['stash', 'push']
        if (message.length > 0) args.push('-m', message)
        // `git stash push` answers exit 0 with a stdout note when the tree has
        // nothing trackable to save — an ok exit here is not proof of a stash.
        const result = await runner.run(args, { cwd: repo.root })
        if (/No local changes to save/i.test(result.stdout + result.stderr)) {
          throw new GitError('NOTHING_TO_COMMIT', '没有可存的改动（工作树是干净的）')
        }
        if (result.exitCode !== 0) throw classifyAs(result.stderr, result.exitCode)
      })
      invalidate(repo.root)
      return sendJson(res, 200, { ok: true, ...(await readOverview(sessionId, { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Record (or replace) the validated manual binding of one session; a
   * `{remove: true}` body drops it instead (the smoke test's cleanup path).
   */
  async function bindingRoute(req, res) {
    const body = await readJson(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    if (sessionId === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_BINDING', message: '需要 sessionId' } })
    }
    if (body?.remove === true) {
      const removed = await bindings.delete(sessionId)
      resolver.invalidate(sessionId)
      return sendJson(res, 200, { ok: true, removed })
    }
    const claimed = normalizeAbsolutePath(body?.repoPath)
    if (claimed === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_BINDING', message: '需要绝对路径 repoPath（或 remove: true）' } })
    }
    const root = await locateRoot(claimed)
    if (root === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'NO_REPO', message: `${claimed} 不是可用的 git 仓库工作树` } })
    }
    await bindings.set(sessionId, root)
    resolver.invalidate(sessionId)
    return sendJson(res, 200, { ok: true, repo: { root, display: root, source: 'manual' } })
  }

  // ── the T2 gate ──────────────────────────────────────────────────────────

  /**
   * Prepare one destructive operation: validate its arguments, describe the
   * impact the preview shows, park a one-shot token.
   */
  async function prepareRoute(req, res) {
    const body = await readJson(req)
    const op = actionOf(body?.op, [...T2_OPS])
    const repo = await repoFor(sessionIdArgOf(body))
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    if (op === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_OP', message: '未知的破坏型操作' } })
    }
    try {
      const prepared = await prepareOp(op, body?.args ?? {}, repo)
      if (prepared.error !== undefined) {
        return sendJson(res, 400, { ok: false, error: prepared.error })
      }
      return sendJson(res, 200, { ok: true, op, token: prepared.token, impact: prepared.impact, expiresAt: prepared.expiresAt })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Confirm one parked operation: the token, the op id and the repository must
   * all match what prepare froze; the token is single-use.
   */
  async function confirmRoute(req, res) {
    const body = await readJson(req)
    const op = actionOf(body?.op, [...T2_OPS])
    const repo = await repoFor(sessionIdArgOf(body))
    if (op === undefined) {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_OP', message: '未知的破坏型操作' } })
    }
    if (repo.root === undefined) return repoWriteAnswer(res, repo)
    const confirmed = gate.consume(body?.token, op, repo.root)
    if (confirmed === undefined) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'CONFIRM_INVALID', message: '确认已过期或不匹配（预览后 30 秒内有效）' },
      })
    }
    try {
      const result = await queue.run(repo.root, async () => {
        const value = await runConfirmedOp(op, confirmed.args, repo)
        invalidate(repo.root)
        return value
      })
      return sendJson(res, 200, { ok: true, ...(result ?? {}), ...(await readOverview(sessionIdArgOf(body), { force: true })) })
    } catch (error) {
      return gitAnswer(res, error)
    }
  }

  /**
   * Validate and freeze one operation's arguments, and describe the impact.
   *
   * @param op - the operation id.
   * @param args - the operation's arguments from the request body.
   * @param repo - the resolved repository.
   * @returns what `gate.prepare` returned, or `{error}`.
   */
  async function prepareOp(op, args, repo) {
    if (op === 'discard') {
      let paths
      try {
        paths = claimPaths(args?.paths)
      } catch (error) {
        return { error: { code: 'BAD_ARGS', message: String(error?.message ?? error) } }
      }
      // Only worktree-modified tracked paths make sense to discard here.
      const counts = await impactCounts(repo, paths)
      const argv = ['git', 'checkout', '--', ...(paths.length > 3 ? [...paths.slice(0, 3), `…(其余 ${paths.length - 3} 个)`] : paths)]
      return gate.prepare(op, { paths }, repo.root, { argv, files: counts })
    }

    if (op === 'stash-pop' || op === 'stash-apply' || op === 'stash-drop') {
      const index = intInRange(args?.index, 0, 1000, undefined)
      if (index === undefined) return { error: { code: 'BAD_ARGS', message: '需要 stash 序号 index' } }
      const found = await stashAt(repo, index)
      if (found === undefined) return { error: { code: 'NO_STASH', message: `stash@{${index}} 不存在` } }
      const verb = op === 'stash-pop' ? 'pop' : op === 'stash-apply' ? 'apply' : 'drop'
      const argv = op === 'stash-drop' ? ['git', 'stash', 'drop', found.selector] : ['git', 'stash', verb, found.selector]
      return gate.prepare(op, { index }, repo.root, {
        argv,
        stash: { selector: found.selector, subject: found.subject },
      })
    }

    if (op === 'branch-force-delete') {
      const claim = typeof args?.name === 'string' ? args.name.trim() : ''
      if (claim.length === 0 || claim.startsWith('-')) {
        return { error: { code: 'BAD_REF', message: '分支名不能为空且不能以 - 开头' } }
      }
      try {
        await runner.mustRun(['check-ref-format', '--branch', claim], { cwd: repo.root }, '校验分支名')
      } catch (error) {
        return { error: { code: error instanceof GitError ? error.code : 'BAD_REF', message: String(error?.message ?? error) } }
      }
      return gate.prepare(op, { name: claim }, repo.root, { argv: ['git', 'branch', '-D', claim], branchName: claim })
    }

    return { error: { code: 'BAD_OP', message: '未知的破坏型操作' } }
  }

  /**
   * Execute one confirmed T2 operation against exactly what prepare froze.
   *
   * @param op - the confirmed op id.
   * @param args - the frozen arguments.
   * @param repo - the resolved repository.
   */
  async function runConfirmedOp(op, args, repo) {
    if (op === 'discard') {
      // Worktree restore: checked-out content comes from the index, so the
      // uncommitted modifications listed in the prompt are exactly what dies.
      await runner.mustRun(['checkout', '--', ...args.paths], { cwd: repo.root }, '丢弃改动')
      return { discarded: args.paths }
    }
    if (op === 'stash-pop' || op === 'stash-apply') {
      const found = await stashAt(repo, args.index)
      if (found === undefined) throw new GitError('NO_STASH', `stash@{${args.index}} 已不存在`)
      const argv = op === 'stash-pop' ? ['stash', 'pop', found.selector] : ['stash', 'apply', found.selector]
      const result = await runner.run(argv, { cwd: repo.root })
      if (result.exitCode !== 0) {
        if (/conflict/i.test(result.stderr)) {
          throw new GitError('DIRTY_WORKTREE_CONFLICT', 'stash 应用发生冲突，仓库里已留下冲突标记；请到终端处理或让 agent 处理', { stderr: result.stderr })
        }
        throw classifyAs(result.stderr, result.exitCode)
      }
      return { stashed: found.selector, popped: op === 'stash-pop' }
    }
    if (op === 'stash-drop') {
      const found = await stashAt(repo, args.index)
      if (found === undefined) throw new GitError('NO_STASH', `stash@{${args.index}} 已不存在`)
      await runner.mustRun(['stash', 'drop', found.selector], { cwd: repo.root }, '删除 stash')
      return { dropped: found.selector }
    }
    if (op === 'branch-force-delete') {
      await runner.mustRun(['branch', '-D', args.name], { cwd: repo.root }, '强制删除分支')
      return { deletedBranch: args.name }
    }
    throw new GitError('BAD_OP', '未知的破坏型操作')
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Validate a paths claim into deduplicated repository-relative paths. */
  function claimPaths(claim) {
    if (!Array.isArray(claim) || claim.length === 0) throw new GitError('BAD_ARGS', '需要至少一个路径')
    if (claim.length > 500) throw new GitError('BAD_ARGS', '一次最多 500 个路径')
    const paths = []
    for (const item of claim) {
      const fixed = normalizeRepoPath(item)
      if (fixed !== undefined && !paths.includes(fixed)) paths.push(fixed)
    }
    if (paths.length === 0) throw new GitError('BAD_ARGS', '没有可用的路径')
    return paths
  }

  /** The per-path numbers a discard preview shows (best effort). */
  async function impactCounts(repo, paths) {
    try {
      const result = await runner.mustRun(['diff', '--numstat', '-z'], { cwd: repo.root }, '统计改动')
      const counts = parseNumstat(result.stdout)
      return paths.map((path) => {
        const record = counts.get(path)
        return { path, binary: record?.binary === true, adds: record?.adds ?? 0, dels: record?.dels ?? 0 }
      })
    } catch {
      return paths.map((path) => ({ path, adds: 0, dels: 0, binary: false }))
    }
  }

  /** Read one stash entry by index (the list's natural order). */
  async function stashAt(repo, index) {
    const result = await runner.mustRun(['stash', 'list', `--format=${STASH_FORMAT}`], { cwd: repo.root }, '列出 stash')
    return parseStashes(result.stdout)[index]
  }

  /** Drop one repository's overview cache, so the next poll is honest. */
  function invalidate(root) {
    overviewCache.delete(root)
  }

  /** A resolved repository or its failure answer. */
  async function repoFor(sessionId) {
    const info = await resolveRepoInfo(sessionId)
    return { root: info.repo?.root, display: info.repo?.display, source: info.repo?.source, failReason: info.reason }
  }

  /** Answer a repo-less write request: 200 with `repo: null` only when git itself is absent. */
  function repoWriteAnswer(res, repo) {
    if (repo.failReason === 'GIT_MISSING' || repo.failReason === 'GIT_XCODE_STUB') {
      return sendJson(res, 200, { ok: true, repo: null, reason: repo.failReason })
    }
    return sendJson(res, 404, { ok: false, repo: null, reason: repo.failReason ?? 'NO_REPO' })
  }

  /** Answer a repo-less read request. */
  function repoFail(repo) {
    if (repo.failReason === 'GIT_MISSING' || repo.failReason === 'GIT_XCODE_STUB') {
      return { ok: true, repo: null, reason: repo.failReason }
    }
    return { ok: false, repo: null, reason: repo.failReason ?? 'NO_REPO' }
  }

  function sessionIdArgOf(body) {
    return typeof body?.sessionId === 'string' ? body.sessionId : undefined
  }

  /** Wrap one thrown error into the client's error shape. */
  function gitErrorPayload(error) {
    if (error instanceof GitError) {
      return { ok: false, error: { code: error.code, message: error.message, ...(error.details?.stderr ? { stderr: error.details.stderr } : {}) } }
    }
    return { ok: false, error: { code: 'GIT_ERROR', message: String(error?.message ?? error) } }
  }

  /** Answer a request with a classified GitError (status heuristics included). */
  function gitAnswer(res, error) {
    const payload = gitErrorPayload(error)
    let status = 400
    if (error instanceof GitError && (error.code === 'LOCKED' || error.code === 'GIT_TIMEOUT')) status = 503
    if (error instanceof GitError && error.code === 'NO_STASH') status = 404
    return sendJson(res, status, payload)
  }

  /** Turn a failed command's stderr into a GitError with a stable code. */
  function classifyAs(stderr, exitCode) {
    const classified = classifyGitFailure(stderr, exitCode) ?? { code: 'GIT_ERROR', message: `git 失败（exit ${String(exitCode)}）` }
    return new GitError(classified.code, classified.message.trim(), { stderr, exitCode })
  }

  /** The current branch header (name, upstream, unborn) for push/pull. */
  async function currentBranch(repo) {
    const result = await runner.mustRun(['status', '--porcelain=v2', '-z', '--branch'], { cwd: repo.root }, '读取分支')
    return parseStatus(result.stdout).branch
  }

  /** The first configured remote name, `origin` preferred (for the first push -u). */
  async function firstRemote(repo) {
    const result = await runner.mustRun(['remote'], { cwd: repo.root }, '列出远端')
    const names = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    if (names.length === 0) {
      throw new GitError('NO_REMOTE', '仓库没有配置远端；先在终端添加远端再来推送')
    }
    return names.includes('origin') ? 'origin' : names[0]
  }

  /** Push/pull summary lines shaped "old..new branch -> remote/branch". */
  function parsePuArrow(stderr) {
    const updates = []
    for (const line of String(stderr).split('\n')) {
      const found = /^\s*(\S+)\.\.(\S+)\s+(\S+)\s*->\s*(\S+)\s*$/.exec(line)
      if (found !== null) updates.push({ from: found[1], to: found[2], ref: found[3], remoteRef: found[4] })
    }
    return updates
  }

  function notFound(req, res, path, method) {
    void req
    return sendJson(res, 404, { ok: false, error: { code: 'NO_ROUTE', message: `未知路由 ${method} ${path}` } })
  }
}

// ── plumbing ────────────────────────────────────────────────────────────────

/**
 * Write one JSON response; polling routes never cache.
 * @param res - node:http response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read one bounded JSON body.
 *
 * @param req - node:http request.
 * @param limit - the byte cap.
 * @returns the parsed body, or `null` when the body is absent or blank.
 * @throws on a body beyond the cap or malformed JSON.
 */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const text = await readBody(req, limit)
  if (text === undefined || text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`)
  }
}

/**
 * Read a request body fully, bounded.
 *
 * @param req - node:http request.
 * @param limit - the byte cap.
 * @returns the text, or `undefined` when the body exceeded the cap.
 */
function readBody(req, limit) {
  return new Promise((fulfil, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        fulfil(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      fulfil(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
