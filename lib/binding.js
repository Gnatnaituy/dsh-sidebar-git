/**
 * Session → repository binding, persisted so a manual rebind survives a host
 * restart, plus the resolution chain that answers "which repository does this
 * sidebar session's Git tab manage".
 *
 * Resolution order (the first answer that still validates wins):
 *   1. a manual binding recorded for the session id;
 *   2. the session's own working directory (`ctx.sessions.get(id).header.cwd`).
 *
 * Validation is one cheap `git rev-parse --show-toplevel --is-inside-work-tree`
 * through the runner, cached briefly: the panel polls every couple of seconds
 * and a rev-parse per poll is waste.
 *
 * @module dsh-sidebar-git/binding
 */

import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * One binding store rooted at the plugin's own home directory.
 *
 * @param options - `dir` (file lives inside it), `logger`, `exists`/`read`/`write`
 *   seams for tests.
 */
export function createBindingStore({ dir, logger, read = defaultRead, write = defaultWrite, exists = defaultExists }) {
  const file = join(dir, 'bindings.json')
  /** @type {Map<string, string>} sessionId → absolute repo path */
  const bindings = new Map()
  let loaded = false

  async function ensureLoaded() {
    if (loaded) return
    loaded = true
    try {
      const data = await read(file)
      if (data === undefined) return
      const parsed = JSON.parse(data)
      for (const [sessionId, repoPath] of Object.entries(parsed.bindings ?? {})) {
        if (typeof sessionId === 'string' && typeof repoPath === 'string' && repoPath.startsWith('/')) {
          bindings.set(sessionId, repoPath)
        }
      }
    } catch (error) {
      // A broken file must never block binding; it is repaired by `set`.
      logger?.warn?.(`[sidebar-git] 绑定文件读取失败（忽略）：${String(error?.message ?? error)}`)
    }
  }

  return {
    /** Path of the backing file (diagnostics). */
    file,

    /** A recorded binding, without validation. */
    async get(sessionId) {
      await ensureLoaded()
      return bindings.get(sessionId)
    },

    /**
     * Record (or replace) a validated manual binding and flush it.
     *
     * @param sessionId - the session the tab belongs to.
     * @param repoPath - the validated absolute repository root.
     */
    async set(sessionId, repoPath) {
      await ensureLoaded()
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('缺少 sessionId')
      if (typeof repoPath !== 'string' || !repoPath.startsWith('/')) throw new Error('仓库路径必须是绝对路径')
      bindings.set(sessionId, resolve(repoPath))
      const payload = { version: 1, bindings: Object.fromEntries(bindings) }
      await write(file, `${JSON.stringify(payload, null, 2)}\n`)
    },

    /** Drop one binding (session is gone). */
    async delete(sessionId) {
      if (!bindings.delete(sessionId)) return false
      const payload = { version: 1, bindings: Object.fromEntries(bindings) }
      await write(file, `${JSON.stringify(payload, null, 2)}\n`)
      return true
    },

    /**
     * Whether a recorded manual binding still exists on disk (cheap liveness —
     * the `git rev-parse` validation happens in the resolver either way).
     */
    async manualPathAlive(sessionId, existsPath = exists) {
      const target = await this.get(sessionId)
      if (target === undefined) return undefined
      return existsPath(target) ? target : undefined
    },
  }
}

/** Resolve the session working directory relative to the repository root ('' when equal). */
export function originTailOf(repoRoot, cwd) {
  if (cwd === undefined || typeof cwd !== 'string' || cwd.length === 0) return ''
  const from = resolve(repoRoot)
  const to = resolve(cwd)
  if (to === from) return ''
  const inside = to.startsWith(from + sep)
  if (!inside) return ''
  return relative(from, to).split(sep).join('/')
}

/**
 * The resolution cache: answers one session's "which repo" for two seconds,
 * which the poller's cadence makes free while keeping the answer honest.
 */
export function createResolver() {
  /** @type {Map<string, {answer: {root?: string, source: string}, at: number}>} */
  const cache = new Map()
  const TTL_MS = 2000

  return {
    async answer(sessionId, compute) {
      const now = Date.now()
      const hit = cache.get(sessionId)
      if (hit !== undefined && now - hit.at < TTL_MS) return hit.answer

      const value = await compute()
      if (typeof value?.root === 'string') {
        cache.set(sessionId, { answer: value, at: now })
        return value
      }
      // Negative answers expire fast: the user may just have run `git init`.
      if (value !== undefined && value !== null) {
        cache.set(sessionId, { answer: value, at: now - TTL_MS + 500 })
        return value
      }
      cache.delete(sessionId)
      return value
    },
    /** Forget one session (or everything). */
    invalidate(sessionId = undefined) {
      if (sessionId === undefined) cache.clear()
      else cache.delete(sessionId)
    },
  }
}

async function defaultRead(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}

async function defaultWrite(file, data) {
  const { mkdir, rename, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(file), { recursive: true })
  const staging = `${file}.tmp`
  await writeFile(staging, data, 'utf8')
  await rename(staging, file)
}

function defaultExists(path) {
  return existsSync(path)
}
