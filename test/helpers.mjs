/**
 * Shared test fixtures: a minimal harness emulator (subprocess shim, service
 * registry, http stubs) and a throwaway git repository builder, so the host
 * routes are exercised against a real git like the browser will.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── the subprocess shim: the harness contract over node child_process ───────

/** A bounded byte collector shaped like the harness' collected stdio. */
export class Reader {
  constructor() {
    this.buffer = ''
    this.total = 0
    this.cap = 4 * 1024 * 1024
  }

  push(chunk) {
    this.total += String(chunk).length
    this.buffer += String(chunk)
    if (this.buffer.length > this.cap) this.buffer = this.buffer.slice(-this.cap)
  }

  /* The harness' readFrom(offset) answers {text, lossy}; these tests are small. */
  readFrom() {
    return { text: this.buffer, lossy: this.total > this.cap }
  }
}

/**
 * One subprocess shim. `mode: 'real'` runs the actual git for integration
 * routes; `mode` functions in `reject` force spawn failures.
 */
export function createSubprocess(options = {}) {
  const executableOf = options.executableOf ?? ((command) => Promise.resolve(command === 'git' ? '/usr/bin/git' : undefined))
  const failSpawns = options.failSpawns === true
  return {
    async resolveExecutable(command) {
      const found = await executableOf(command)
      if (found === undefined) throw new Error(`SubprocessExecutableNotFoundError: ${command}`)
      return found
    },
    spawn(spec) {
      if (failSpawns) {
        return {
          done: Promise.reject(new Error('spawn failed')),
          collected: { stdout: new Reader(), stderr: new Reader() },
        }
      }
      const contentType = typeof spec.stdio.stdin === 'object' && spec.stdio.stdin.data !== undefined ? 'pipe' : 'ignore'
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: [contentType, 'pipe', 'pipe'] })
      const stdout = new Reader()
      const stderr = new Reader()
      child.stdout?.on?.('data', (chunk) => stdout.push(chunk))
      child.stderr?.on?.('data', (chunk) => stderr.push(chunk))
      // stdin data is one shot here, like the json/text stdin uses
      child.stdin?.on?.('error', () => {})
      if (contentType === 'pipe' && typeof spec.stdio.stdin.data === 'string') child.stdin.end(spec.stdio.stdin.data)
      if (spec.signal?.addEventListener) spec.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
      const done = new Promise((fulfil) => {
        child.on('close', (exitCode) => fulfil({ exitCode: exitCode ?? 1 }))
        child.on('error', (error) => {
          stderr.push(`spawn error: ${error.message}`)
          fulfil({ exitCode: 1 })
        })
      })
      return { done, collected: { stdout, stderr } }
    },
  }
}

// ── http stubs ───────────────────────────────────────────────────────────────

/** A node:http response stub that resolves `whenFinished` on end. */
export function makeRes() {
  let finished
  const res = {
    headersSent: false,
    headers: undefined,
    status: undefined,
    chunks: [],
    whenFinished: new Promise((fulfil) => {
      finished = fulfil
    }),
    writeHead(status, headers) {
      this.headersSent = true
      this.status = status
      this.headers = headers
    },
    end(text) {
      if (text) this.chunks.push(text)
      finished()
    },
  }
  return res
}

/** Await the response and parse its JSON. */
export async function readJson(res) {
  await res.whenFinished
  return JSON.parse(res.chunks.join('') || 'null')
}

/** A node:http request stub with a microtask-fed JSON body. */
export function makeReq(options = {}) {
  const listeners = new Map()
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: {},
    on(name, listener) {
      listeners.set(name, listener)
    },
    destroy() {},
  }
  const body = options.body
  queueMicrotask(() => {
    if (body !== undefined) listeners.get('data')?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    listeners.get('end')?.()
  })
  return req
}

/** Feed one http-ish request through the registered route handler, awaiting the write. */
export async function drive(handler, method, url, body = undefined) {
  const res = makeRes()
  // The handler is intentionally fire-and-forget (mirrors the real plugin),
  // so the await happens on the response's finish gate instead.
  handler(makeReq({ method, url, body }), res)
  await res.whenFinished
  return { status: res.status, res, body: JSON.parse(res.chunks.join('') || 'null') }
}

// ── the plugin context stub (cordis-inject shaped) ───────────────────────────

/**
 * A host context whose services stop meaning "the real harness": webServer
 * captures the route, subprocess executes real commands, sessions maps ids to
 * directories, dshHomePath answers with the fixture home.
 */
export function createHost(options = {}) {
  const services = {
    capturedRoute: undefined,
    effects: [],
    sessionCwds: options.sessionCwds ?? {},
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(setup, label) {
      services.effects.push(label)
      void setup?.()
    },
    on(name, listener) {
      services[`listener:${name}`] = listener
    },
    logger: {
      lines: [],
      info(line) {
        this.lines.push(line)
      },
      warn(line) {
        this.lines.push(line)
      },
      debug() {},
    },
  }
  services.webServer = {
    register(spec) {
      services.capturedRoute = spec
      // The harness resolves url+method before calling the handler; tests do too.
      return () => undefined
    },
  }
  sessionsService(ctx, services)
  subprocessService(ctx, services, options)
  homeService(ctx, services, options)
  // Cordis inject exposes each service as a `ctx.<id>` property as well.
  ctx.webServer = services.webServer
  ctx.sessions = services.sessions
  ctx.subprocess = services.subprocess
  return { ctx, services }
}

function sessionsService(ctx, services) {
  services.sessions = {
    get(sessionId) {
      const cwd = services.sessionCwds[sessionId]
      if (cwd === undefined) return undefined
      return { id: sessionId, header: { cwd, origin: 'user', delegationDepth: 0 } }
    },
    list() {
      return Object.entries(services.sessionCwds).map(([sessionId, cwd]) => ({ id: sessionId, header: { cwd } }))
    },
  }
}

function subprocessService(ctx, services, options) {
  services.subprocess = options.subprocess ?? createSubprocess()
}

function homeService(ctx, services, options) {
  if (options.home !== undefined) {
    services.dshHomePath = () => options.home
  }
}

// ── the fixture repository ──────────────────────────────────────────────────

/** Run one git command synchronously-ish in the fixture. */
export function gitSpawn(cwd, args, env = {}) {
  return new Promise((fulfil) => {
    const child = spawn('/usr/bin/git', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (exitCode) => fulfil({ exitCode, stdout: out, stderr: err }))
  })
}

/** `sh -c` for quick file setups. */
export function shell(cwd, command) {
  return new Promise((fulfil) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (exitCode) => fulfil({ exitCode, out }))
  })
}

/**
 * A small flavorful repository: tracked files with worktree and staged
 * changes, an untracked file, a rename, one file with CJK name, plus single
 * commits carrying a multi-line body.
 */
export async function buildFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-test-'))
  const work = join(root, 'work')
  const cleanRepo = join(root, 'clean')
  const emptyRepo = join(root, 'empty')
  const remote = join(root, 'remote.git')
  const home = join(root, 'home')
  mkdirSync(work, { recursive: true })
  mkdirSync(join(home, 'sessions'), { recursive: true })

  await gitSpawn(work, ['init', '-q', '-b', 'main', '.'])
  await gitSpawn(work, ['config', 'user.name', '测试者'])
  await gitSpawn(work, ['config', 'user.email', 't@example.com'])
  await shell(work, 'mkdir -p sub deep/nested')
  await shell(work, 'echo hello > alpha.txt && echo deep > sub/inner.js')
  await shell(work, 'echo nest > deep/nested/plum.md && printf "字节\\xff二进制" > bin.dat')
  await gitSpawn(work, ['add', '-A'])
  await gitSpawn(work, ['commit', '-q', '-m', 'first'])

  // current state: worktree change + untracked + staged addition
  await shell(work, 'echo more >> alpha.txt')
  await shell(work, 'echo untracked > untracked.txt')
  await shell(work, 'echo staged > staged.txt')
  await gitSpawn(work, ['add', 'staged.txt'])

  // a clean clone for empty-overview reads
  await gitSpawn(root, ['init', '-q', '-b', 'main', cleanRepo])
  await gitSpawn(cleanRepo, ['config', 'user.name', '测试者'])
  await gitSpawn(cleanRepo, ['config', 'user.email', 't@example.com'])
  await shell(cleanRepo, 'echo base > base.txt && git add -A && git commit -qm "base"')

  // an empty (unborn) repository
  await gitSpawn(root, ['init', '-q', '-b', 'main', emptyRepo])

  // a bare remote for push/pull
  await gitSpawn(root, ['init', '-q', '--bare', remote])

  if (options.withRemote) {
    await gitSpawn(work, ['remote', 'add', 'origin', remote])
    await gitSpawn(work, ['push', '-q', '-u', 'origin', 'main'])
  }

  return {
    root,
    work,
    clean: cleanRepo,
    empty: emptyRepo,
    remote,
    home,
    async dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The session map pointing every fixture session at its directory. */
export function fixtureSessions(fixture) {
  return {
    s1: fixture.work,
    clean: fixture.clean,
    nor: fixture.empty,
    outside: join(fixture.root, 'not-a-repo'),
  }
}
