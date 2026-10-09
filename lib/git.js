/**
 * The git executor: every git command in this plugin flows through here.
 *
 * One `GitRunner` per plugin instance owns:
 *
 *   - the resolved `git` executable (macOS's developer-tools stub at
 *     `/usr/bin/git` counts as absent until Xcode CLT is installed, the exact
 *     trick `@deepseek-ai/dsh-workspace-changes` uses);
 *   - the stability environment every command runs with —
 *     `GIT_TERMINAL_PROMPT=0` (no credential prompts, ever; auth failures
 *     classify instead of hanging the tab), `GIT_OPTIONAL_LOCKS=0`,
 *     `GIT_PAGER=cat`, `GIT_EDITOR=:` (the arm that closes the editor),
 *     `GIT_CONFIG_COUNT=0` (ambient indexed config off) and a fixed
 *     `LC_ALL=C.UTF-8` byte locale for stable parser behavior;
 *   - per-command timeout and bounded output, through `ctx.subprocess`.
 *
 * The runner knows nothing about which commands are legal: that is the
 * route layer's contract. It only guarantees exit facts, collected bytes and
 * a classified `GitError` when something fails.
 *
 * @module dsh-sidebar-git/git
 */

import { homedir } from 'node:os'

/** One command may run this long before it is killed. */
export const DEFAULT_TIMEOUT_MS = 15_000
/** One command may print at most this many bytes of stdout (diffs/logs). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
/** stderr tail: enough to classify any git refusal. */
const STDERR_MAX_BYTES = 32 * 1024
/** Grace before the process tree is killed for real. */
export const GRACE_MS = 5_000

/** A classified failure: every route answers with the code the UI knows. */
export class GitError extends Error {
  /**
   * @param code - a stable code from the error table (see README).
   * @param message - a human-readable summary (raw stderr tail included).
   * @param details - `{ exitCode, stderr, stdout, truncated }` facts.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.details = details
  }
}

/**
 * Map one git refusal to a stable code.
 *
 * Order matters: the first matching pattern wins, and the most specific
 * messages are checked first.
 *
 * @param stderr - the command's stderr text.
 * @param exitCode - the process exit code.
 * @returns a `{ code, message }` pair, or `undefined` for exit 0.
 */
export function classifyGitFailure(stderr, exitCode) {
  if (exitCode === 0) return undefined
  const text = String(stderr ?? '')
  const tail = text.length > 0 ? text : `exit code ${String(exitCode)}`

  if (/not a git repository/i.test(text)) return { code: 'NO_REPO', message: tail }
  if (/is a bare repository|is outside repository|must be run in a work tree/i.test(text)) return { code: 'NO_REPO', message: tail }
  if (/index\.lock|cannot lock ref|Unable to create .*index\.lock/i.test(text)) {
    return { code: 'LOCKED', message: tail }
  }
  if (/would be overwritten by (checkout|merge)/i.test(text)) {
    return { code: 'DIRTY_WORKTREE_CONFLICT', message: tail }
  }
  if (/[Uu]nmerged|merge conflict|concluded your merge|fix conflicts/i.test(text)) {
    return { code: 'UNMERGED', message: tail }
  }
  if (((/nothing.*commit/i.test(text) || /no changes added to commit/i.test(text)) && /working (tree|directory) clean|nothing added|are untracked/i.test(text)) || /nothing to commit/i.test(text)) {
    return { code: 'NOTHING_TO_COMMIT', message: tail }
  }
  if (/is not a valid branch name|invalid (branch|ref) name/i.test(text)) {
    return { code: 'BRANCH_INVALID', message: tail }
  }
  if (/branch .* already exists|already exists/i.test(text)) {
    return { code: 'BRANCH_EXISTS', message: tail }
  }
  if (/itself has unmerged|not fully merged/i.test(text)) {
    return { code: 'UNMERGED', message: tail }
  }
  if (/tip of your current branch is behind|\(non-fast-forward\)|\[rejected\]|fetch first|delayed/i.test(text)) {
    return { code: 'PUSH_REJECTED', message: tail }
  }
  if (/it is not possible to fast-forward|not possible to fast-forward|can't fast-forward|cannot fast-forward/i.test(text)) {
    return { code: 'NOT_FAST_FORWARD', message: tail }
  }
  if (/could not read Username|Authentication failed|Permission denied \(publickey|terminal prompts disabled|fatal: Could not read from remote repository/i.test(text)) {
    return { code: 'AUTH_FAILED', message: tail }
  }
  if (/developer tools|command line tools/i.test(text)) {
    return { code: 'GIT_XCODE_STUB', message: tail }
  }
  return { code: 'GIT_ERROR', message: tail }
}

/**
 * Create the runner.
 *
 * @param options - `subprocess` (the harness capability), `lifetime` (an
 *   AbortSignal for the plugin's lifetime), `logger`, `cwdProbe` (optional
 *   injection for tests: `resolveExecutable` override).
 */
export function createGitRunner({ subprocess, lifetime, logger }) {
  let resolution = undefined

  const stableEnv = {
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: ':',
    LC_ALL: 'C.UTF-8',
  }

  return {
    /** The stability environment (exposed so tests can assert it reaches git). */
    env: stableEnv,

    /**
     * Resolve `git` once. The macOS stub at `/usr/bin/git` only becomes a real
     * git after the developer tools are installed; probing that here keeps the
     * tab's empty state honest instead of exploding dialogs.
     *
     * @returns `{ available: boolean, exec?: string, reason?: string, version?: string }`.
     */
    async resolve() {
      if (resolution === undefined) {
        resolution = (async () => {
          try {
            const exec = await subprocess.resolveExecutable('git')
            if (process.platform === 'darwin' && exec === '/usr/bin/git') {
              const installed = await hasDeveloperTools(subprocess)
              if (!installed) return { available: false, reason: 'GIT_XCODE_STUB' }
            }
            return { available: true, exec }
          } catch (error) {
            logger?.warn?.(`[sidebar-git] 没有 git 可执行：${String(error?.message ?? error)}`)
            return { available: false, reason: 'GIT_MISSING' }
          }
        })()
      }
      return resolution
    },

    /**
     * Run one git command.
     *
     * @param args - the argv tail (the executable itself is prepended here).
     * @param options - `cwd`, `stdin`, `timeoutMs`, `maxBytes`, `env` (extra,
     *   merged after the stability set).
     * @returns `{ exitCode, stdout, stderr, truncated }`.
     * @throws `GitError` with a classified code on timeout, abort or spawn
     *   failure; plain failures come back as exit facts for `run`'s callers to
     *   `ok()` or classify themselves.
     */
    async run(args, options = {}) {
      const resolved = await this.resolve()
      if (!resolved.available) throw new GitError(resolved.reason === 'GIT_XCODE_STUB' ? 'GIT_XCODE_STUB' : 'GIT_MISSING', '本机没有可用的 git 可执行文件')

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      const started = Date.now()

      let handle
      try {
        handle = subprocess.spawn({
          argv: [resolved.exec, ...args],
          cwd: options.cwd,
          stdio: {
            stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
            stdout: { maxBytes },
            stderr: { maxBytes: STDERR_MAX_BYTES },
          },
          graceMs: GRACE_MS,
          signal,
          env: { ...stableEnv, ...options.env },
        })
      } catch (error) {
        throw new GitError('GIT_ERROR', `git 无法启动：${String(error?.message ?? error)}`)
      }

      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        const timedOut = timeout.aborted
        throw new GitError(timedOut ? 'GIT_TIMEOUT' : 'GIT_ERROR', `git 运行失败：${String(error?.message ?? error)}`, { command: describe(args) })
      }
      if (signal.aborted) {
        throw new GitError('GIT_TIMEOUT', `git 运行超时（>${timeoutMs}ms）或被中止：${describe(args)}`, { command: describe(args) })
      }

      const stdoutRead = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
      const stderrRead = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false }
      logger?.debug?.(`[sidebar-git] git ${describe(args)} → ${outcome.exitCode}（${Date.now() - started}ms）`)
      return {
        exitCode: outcome.exitCode ?? 1,
        stdout: stdoutRead.text,
        stderr: stderrRead.text,
        truncated: stdoutRead.lossy === true,
      }
    },

    /**
     * Run + require exit 0, classifying any refusal into a `GitError`.
     *
     * @param args - the argv tail.
     * @param options - the options of `run`.
     * @param what - a stub that names the operation in error text.
     * @returns `run`'s result (exit code 0).
     * @throws `GitError` on failure.
     */
    async mustRun(args, options, what) {
      const result = await this.run(args, options)
      if (result.exitCode !== 0) {
        const classified = classifyGitFailure(result.stderr, result.exitCode) ?? { code: 'GIT_ERROR', message: options?.stderrFallback ?? 'git 失败' }
        throw new GitError(classified.code, `${what ?? 'git'} 失败：${classified.message.trim()}`, {
          exitCode: result.exitCode,
          stderr: result.stderr,
          command: describe(args),
        })
      }
      return result
    },
  }
}

/**
 * On macOS, `/usr/bin/git` pops a dialog instead of running until the Xcode
 * developer tools are installed. `xcode-select -p` exiting 0 proves they are.
 *
 * @param subprocess - the harness subprocess capability.
 * @returns whether real developer tools are present.
 */
async function hasDeveloperTools(subprocess) {
  try {
    const handle = subprocess.spawn({
      argv: ['/usr/bin/xcode-select', '-p'],
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 1_000,
    })
    const outcome = await handle.done
    return outcome.exitCode === 0
  } catch {
    return false
  }
}

/** Short human stub of a command for logs and errors. */
function describe(args) {
  return `git ${args.filter((arg) => typeof arg === 'string').join(' ').slice(0, 200)}`
}
