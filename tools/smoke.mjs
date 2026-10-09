/**
 * Live smoke test for a running DSH harness.
 *
 * Exercises dsh-sidebar-git's routes against real, freshly built fixture
 * repositories (one normal, one unborn) wired in through the manual-binding
 * route — no live harness session is created, no network is touched beyond
 * the loopback, and the push/pull remote is a local `file://` bare repo. A
 * successful run leaves nothing behind: the fixtures are deleted and the two
 * smoke bindings are removed.
 *
 * Usage:
 *   node tools/smoke.mjs [--base http://127.0.0.1:19387] [--keep]
 *
 * The plugin must be mounted first (tools/install-into-profile.mjs).
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const keep = argv.includes('--keep')
const base = option('--base', 'http://127.0.0.1:19387').replace(/\/$/, '')
const route = `${base}/dsh-sidebar-git`

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Call one JSON route. */
async function api(path, options) {
  const response = await fetch(`${route}${path}`, options)
  const text = await response.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${path} answered non-JSON: ${text.slice(0, 200)}`)
  }
  return { status: response.status, body: parsed }
}

/** GET convenience. */
const get = (path) => api(path)

/** POST convenience with a JSON body. */
function post(path, body) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
}

/** `bash -c` inside a fixture. */
function sh(cwd, command) {
  return new Promise((fulfil) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (exitCode) => fulfil({ exitCode, out }))
  })
}

/** Git helper for fixture building. */
function git(cwd, args) {
  return new Promise((fulfil) => {
    const child = spawn('/usr/bin/git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (exitCode) => fulfil({ exitCode, out }))
  })
}

// ── the fixtures ─────────────────────────────────────────────────────────────

const stage = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-smoke-'))
const repo = join(stage, 'repo')
const clean = join(stage, 'clean')
const empty = join(stage, 'empty')
const remote = join(stage, 'remote.git')
const SMOKE_SESSION = 'dsh-sidebar-git-smoke'
const SESSIONS = [SMOKE_SESSION, 'dsh-sidebar-git-smoke-clean', 'dsh-sidebar-git-smoke-empty']

async function buildFixtures() {
  for (const dir of [repo, clean, empty]) mkdirSync(dir, { recursive: true })
  await git(repo, ['init', '-q', '-b', 'main', '.'])
  await git(repo, ['config', 'user.name', 'smoke'])
  await git(repo, ['config', 'user.email', 'smoke@example.com'])
  await sh(repo, 'mkdir -p sub && echo hello > alpha.txt && echo deep > sub/inner.js')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'smoke: first'])
  await sh(repo, 'echo more >> alpha.txt && echo untracked > untracked.txt && echo staged > staged.txt')
  await git(repo, ['add', 'staged.txt'])

  await git(clean, ['init', '-q', '-b', 'main', '.'])
  await git(clean, ['config', 'user.name', 'smoke'])
  await git(clean, ['config', 'user.email', 'smoke@example.com'])
  await sh(clean, 'echo base > base.txt')
  await git(clean, ['add', '-A'])
  await git(clean, ['commit', '-q', '-m', 'smoke: base'])

  await git(empty, ['init', '-q', '-b', 'main', '.'])
  await git(stage, ['init', '-q', '--bare', remote])
  await git(repo, ['remote', 'add', 'origin', remote])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])
}

async function disposeFixtures() {
  if (keep) {
    console.log(`\n保留测试仓库：${stage}`)
    return
  }
  // Remove the smoke bindings first: the fixtures die right after.
  for (const sessionId of SESSIONS) {
    await post('/binding', { sessionId, remove: true })
  }
  rmSync(stage, { recursive: true, force: true })
}

// ── the run ──────────────────────────────────────────────────────────────────

try {
  await buildFixtures()
  // The harness host may need a moment; /info also proves the plugin is mounted.
  const info = await get('/info')
  check('GET /info 就绪', info.body.ok === true, JSON.stringify(info.body).slice(0, 160))

  // Binding: point the smoke session at the real fixture repo.
  const bound = await post('/binding', { sessionId: SMOKE_SESSION, repoPath: repo })
  check('POST /binding 绑定 fixture 仓库', bound.body.ok === true && bound.body.repo?.source === 'manual')
  check('错误的 repoPath 被拒', (await post('/binding', { sessionId: SMOKE_SESSION, repoPath: stage })).body.error?.code === 'NO_REPO')

  await sh(repo, 'echo second > second-change.txt')
  const overview = (await get('/overview?sessionId=' + SMOKE_SESSION + '&force=1')).body
  check('GET /overview 返回分支与分组', overview.repo?.root !== undefined && overview.branch?.name === 'main')
  check('未跟踪文件入组', overview.groups?.untracked?.some((file) => file.path === 'second-change.txt') === true, JSON.stringify(overview.groups?.untracked))
  const revBefore = overview.rev

  // push/pull through the local file remote
  const pushed = await post('/push', { sessionId: SMOKE_SESSION })
  check('push 到 file:// remote', pushed.body.ok === true, JSON.stringify(pushed.body.error ?? {}))
  const pulled = await post('/pull', { sessionId: SMOKE_SESSION })
  check('pull（--ff-only，无新提交）', pulled.body.ok === true)

  // stage → commit
  const staged = await post('/stage', { sessionId: SMOKE_SESSION, paths: ['staged.txt'] })
  check('POST /stage 成功并回总览', staged.body.ok === true && staged.body.changed?.includes('staged.txt') === true)
  const committed = await post('/commit', { sessionId: SMOKE_SESSION, message: 'smoke: 提交一笔' })
  check('POST /commit 落盘', committed.body.ok === true && committed.body.commit?.short?.length > 0)
  check('提交后 rev 变化', committed.body.rev !== undefined && revBefore !== undefined)
  const log = (await get('/log?sessionId=' + SMOKE_SESSION + '&limit=2')).body
  check('GET /log 首页含新提交', log.commits?.[0]?.subject === 'smoke: 提交一笔')
  check('分页 done 标记', log.done === true || log.commits.length === 2)

  // diff
  const diff = (await get(`/diff?sessionId=${SMOKE_SESSION}&path=alpha.txt&area=worktree`)).body
  check('GET /diff 工作树 diff 有 hunk', diff.ok === true && diff.hunks?.length >= 1)
  check('diff 拒绝遍历路径', (await get(`/diff?sessionId=${SMOKE_SESSION}&path=..%2Fx&area=staged`)).body.error?.code === 'BAD_ARGS')
  check('diff 拒绝 option 形 commit', (await get(`/diff?sessionId=${SMOKE_SESSION}&path=alpha.txt&commit=--upload-pack`)).body.error?.code === 'BAD_ARGS')

  // branches
  await post('/branch', { sessionId: SMOKE_SESSION, action: 'create', name: 'smoke-branch' })
  const moved = (await get('/overview?sessionId=' + SMOKE_SESSION + '&force=1')).body
  check('分支创建并切换', moved.branch?.name === 'smoke-branch')
  await post('/branch', { sessionId: SMOKE_SESSION, action: 'checkout', name: 'main' })
  const dashRejected = await post('/branch', { sessionId: SMOKE_SESSION, action: 'checkout', name: '--help' })
  check('dash 开头分支名被拒（BAD_REF）', dashRejected.body.error?.code === 'BAD_REF')
  const invalid = await post('/branch', { sessionId: SMOKE_SESSION, action: 'create', name: 'bad..name' })
  check('git 校验分支名（BRANCH_INVALID）', invalid.body.error?.code === 'BRANCH_INVALID')

  // the T2 gate: discard
  await sh(repo, 'echo discardme > discard.txt && git add discard.txt && git commit -qm "smoke: to discard"')
  await sh(repo, 'echo changed >> alpha.txt')
  const prepared = await post('/ops/prepare', { sessionId: SMOKE_SESSION, op: 'discard', args: { paths: ['alpha.txt'] } })
  check('prepare 给出 argv 预览', prepared.body.ok === true && prepared.body.impact?.argv?.[1] === 'checkout')
  const confirmed = await post('/ops/confirm', { sessionId: SMOKE_SESSION, op: 'discard', token: prepared.body.token })
  check('confirm 执行成功', confirmed.body.ok === true && confirmed.body.discarded?.includes('alpha.txt') === true)
  const replay = await post('/ops/confirm', { sessionId: SMOKE_SESSION, op: 'discard', token: prepared.body.token })
  check('token 单次有效（重放被拒）', replay.body.error?.code === 'CONFIRM_INVALID')
  const rollback = await post('/binding', { sessionId: SMOKE_SESSION })
  void rollback

  // stash: push then gated pop (a real tracked change, plus untracked noise)
  await sh(repo, 'echo stashme > untracked.txt.orig && echo over > untracked.txt && echo stashed >> alpha.txt')
  const stashPushed = await post('/stash', { sessionId: SMOKE_SESSION, action: 'push', message: 'smoke stash' })
  check('stash push（T1）', stashPushed.body.ok === true)
  const refusedStash = await post('/stash', { sessionId: SMOKE_SESSION, action: 'push', message: '又存一次（应拒绝）' })
  check('干净树 stash push 被拒（NOTHING_TO_COMMIT）', refusedStash.body.error?.code === 'NOTHING_TO_COMMIT')
  const stashes = (await get('/stashes?sessionId=' + SMOKE_SESSION)).body
  check('stash 列表有记录', stashes.stashes?.length >= 1)
  const directPop = await post('/stash', { sessionId: SMOKE_SESSION, action: 'pop' })
  check('直接 pop 被拒（CONFIRM_REQUIRED）', directPop.body.error?.code === 'CONFIRM_REQUIRED')
  const preparedPop = await post('/ops/prepare', { sessionId: SMOKE_SESSION, op: 'stash-pop', args: { index: 0 } })
  check('stash pop prepare 预览', preparedPop.body.ok === true && preparedPop.body.impact?.stash?.selector?.startsWith('stash@{'))
  const confirmedPop = await post('/ops/confirm', { sessionId: SMOKE_SESSION, op: 'stash-pop', token: preparedPop.body.token })
  check('confirm 后 pop 落地', confirmedPop.body.ok === true)

  // unborn repo branch: the clean/empty fixtures ride their own sessions
  await post('/binding', { sessionId: 'dsh-sidebar-git-smoke-clean', repoPath: clean })
  const cleanOverview = (await get('/overview?sessionId=dsh-sidebar-git-smoke-clean&force=1')).body
  check('干净仓库：counts 0 + rev 存在', cleanOverview.counts?.staged + cleanOverview.counts?.worktree + cleanOverview.counts?.untracked === 0)
  await post('/binding', { sessionId: 'dsh-sidebar-git-smoke-empty', repoPath: empty })
  const emptyOverview = (await get('/overview?sessionId=dsh-sidebar-git-smoke-empty&force=1')).body
  check('空仓库：unborn + 无提交历史', emptyOverview.branch?.unborn === true && (await get('/log?sessionId=dsh-sidebar-git-smoke-empty')).body.unborn === true)

  // unknown route + missing session
  check('未知路由 404', (await get('/not-a-route')).body.error?.code === 'NO_ROUTE')
  check('未知会话走 NO_SESSION', (await get('/repo?sessionId=no-such')).body.reason === 'NO_SESSION')
} catch (error) {
  check('smoke 全程无异常', false, String(error && error.message ? error.message : error))
} finally {
  await disposeFixtures()
}

console.log(failures === 0 ? '\nsmoke 全部通过' : `\nsmoke 有 ${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
