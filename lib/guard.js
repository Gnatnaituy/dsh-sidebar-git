/**
 * The guard layer: parameter validation, repository-path containment, and the
 * two-step confirmation gate for destructive operations.
 *
 * Three house rules drive the shape:
 *
 *   - **Every argument must survive a straight argv.** Paths come back as
 *     repository-relative claims that get re-checked against the repository
 *     root (no absolute paths, no `..` escapes, no NUL); branch names are
 *     checked by `git check-ref-format --branch` before any argv is built. The
 *     adapter passes per-operation arguments in fixed positions — a caller can
 *     never splice options into a command, only supply values the accepted
 *     positions can carry.
 *   - **T2 needs prepare→confirm.** `prepare` fixes the operation, records its
 *     arguments, hands back a one-shot token and an impact summary; `confirm`
 *     consumes that exact token within 30 seconds. Without a token there is no
 *     T2 endpoint that does anything.
 *   - **The tier table is data, not convention.** Each remote route names its
 *     tier; the dispatcher refuses to run a T2 operation that did not come
 *     through a consumed token.
 *
 * @module dsh-sidebar-git/guard
 */

import { randomUUID } from 'node:crypto'

/** Lifetime of one prepare token, in milliseconds. */
export const CONFIRM_TTL_MS = 30_000

/** Repo-relative path claims are bounded: names can still be long, but not megabytes. */
export const MAX_PATH_BYTES = 1024

/** Branch name claims are bounded well below git's own cares. */
export const MAX_REF_BYTES = 200

/** A confirmed T2 operation, after `confirm` consumed its token. */
export class ConfirmedOp {
  /**
   * @param op - the operation id (`discard` …).
   * @param args - the prepared arguments, frozen.
   * @param repoRoot - the repository the token was issued for.
   * @param issuedAt - `Date.now()` at prepare time.
   */
  constructor(op, args, repoRoot, issuedAt) {
    this.op = op
    this.args = Object.freeze({ ...args })
    this.repoRoot = repoRoot
    this.issuedAt = issuedAt
  }
}

/**
 * Create the confirmation gate.
 *
 * @param options - `ttlMs` for tests; the sweep runs on issue.
 * @returns `{ prepare, consume, size }`.
 */
export function createGate(options = {}) {
  const ttlMs = options.ttlMs ?? CONFIRM_TTL_MS
  /** @type {Map<string, {op: string, args: object, repoRoot: string, issuedAt: number, argvFrom: string}>} */
  const issued = new Map()

  /** Drop expired tokens lazily: they only ever arrive one at a time. */
  function sweep(now) {
    for (const [token, record] of issued) {
      if (now - record.issuedAt > ttlMs) issued.delete(token)
    }
  }

  return {
    /**
     * Fix one pending destructive operation.
     *
     * @param op - the operation id.
     * @param args - validated arguments.
     * @param repoRoot - the repository that will run it.
     * @param impact - a small JSON-safe summary the client previews.
     * @returns `{token, op, impact, expiresAt}`.
     */
    prepare(op, args, repoRoot, impact) {
      const now = Date.now()
      sweep(now)
      const token = randomUUID()
      issued.set(token, { op, args, repoRoot, issuedAt: now })
      return { token, op, impact, expiresAt: now + ttlMs }
    },

    /**
     * Consume one token: only the exact prepared operation, for the exact
     * repository, inside the window, and only once.
     *
     * @param token - what `prepare` handed back.
     * @param op - the operation the caller believes it is confirming.
     * @param repoRoot - the repository the caller believes it is running in.
     * @returns the confirmed operation, or `undefined` on any mismatch.
     */
    consume(token, op, repoRoot) {
      const now = Date.now()
      sweep(now)
      if (typeof token !== 'string' || token.length === 0) return undefined
      const record = issued.get(token)
      if (record === undefined) return undefined
      if (record.op !== op || record.repoRoot !== repoRoot) return undefined
      if (now - record.issuedAt > ttlMs) {
        issued.delete(token)
        return undefined
      }
      issued.delete(token)
      return new ConfirmedOp(op, record.args, record.repoRoot, record.issuedAt)
    },

    /** How many tokens are parked right now (diagnostics). */
    get size() {
      return issued.size
    },
  }
}

/**
 * Validate one repository-relative path claim.
 *
 * @param value - the claimed path (should come from this plugin's own routes).
 * @param repoRoot - the absolute repository root, used only for error text.
 * @returns the normalized posix path, or `undefined` when the claim is unsafe.
 */
export function normalizeRepoPath(value, repoRoot) {
  void repoRoot
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_PATH_BYTES) return undefined
  if (trimmed.includes('\u0000') || trimmed.includes('\r') || trimmed.includes('\n')) return undefined
  if (trimmed.includes('\\') || trimmed.startsWith('/')) return undefined
  if (trimmed !== normalizedPosix(trimmed)) return undefined
  if (trimmed.split('/').includes('..')) return undefined
  return trimmed
}

/** Posix-clean a path claim without inventing separators a caller did not own. */
function normalizedPosix(value) {
  let out = value
  for (;;) {
    const next = out.replace('//', '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (next === out) return out
    out = next
  }
}

/** T1 operations: single click. The dispatcher trusts these routes' own checks. */
export const T1_OPS = /** @type {const} */ new Set(['stage', 'unstage', 'commit', 'branch-create', 'branch-checkout', 'branch-delete', 'stash-push', 'push', 'pull'])

/** T2 operations: the only ones that may run under a confirmed token. */
export const T2_OPS = /** @type {const} */ new Set(['discard', 'stash-pop', 'stash-apply', 'stash-drop', 'branch-force-delete'])

/**
 * Validate a branch-name claim with git's own validator.
 *
 * The plugin always runs `git check-ref-format --branch` through the host
 * subprocess before building the real argv; this local shape check exists so
 * the cheap absurdities (empty, long, control bytes, dash-leading — the argv
 * injection vector) never reach a process at all.
 *
 * @param value - the claimed branch name.
 * @returns `true` when the claim is locally safe to hand to git for the real check.
 */
export function plausibleBranchName(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_REF_BYTES) return false
  // Control bytes and whitespace are absurd in a branch name and the dash is
  // the argv-option injection vector; `checkRefFormat` does the real verdict.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false
  if (/\s/.test(trimmed)) return false
  if (trimmed.startsWith('-')) return false
  return true
}

/**
 * Validate a commit message the way the commit route will use it: text only,
 * generous but bounded, stdin-fed so argv never sees it.
 *
 * @param value - the claimed message.
 * @returns the message with its trailing whitespace normalized, or `undefined`.
 */
export function normalizeCommitMessage(value) {
  if (typeof value !== 'string') return undefined
  if (Buffer.byteLength(value, 'utf8') > 4096) return undefined
  if (value.includes('\u0000')) return undefined
  const text = value.replace(/^[ \t\f\v]+/, '').replace(/\s+$/, '')
  return text.length === 0 ? undefined : text
}

/**
 * Validate a remote name / branch pair or an absolute repository path.
 *
 * @param value - the claimed absolute path.
 * @returns the cleaned path, or `undefined`.
 */
export function normalizeAbsolutePath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return undefined
  if (!trimmed.startsWith('/')) return undefined
  if (trimmed.includes('\u0000')) return undefined
  return trimmed
}

/**
 * Validate one integer within a range.
 *
 * @param value - the claim.
 * @param min - inclusive minimum.
 * @param max - inclusive maximum.
 * @param fallback - the value used when the claim is absent.
 * @returns the integer or the fallback.
 */
export function intInRange(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

/**
 * Validate one of a fixed set of string actions.
 *
 * @param value - the claim.
 * @param allowed - the accepted values.
 * @param fallback - the value used when absent; `undefined` rejects.
 * @returns the validated action.
 */
export function actionOf(value, allowed, fallback = undefined) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}
