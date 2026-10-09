/**
 * Pure parsers for git's machine-readable output.
 *
 * Every function here takes the exact bytes one git invocation printed and
 * returns plain data; nothing in this module spawns, reads the filesystem or
 * knows about the harness. All my unit testing concentrates here, because the
 * porcelain formats are contracts this plugin depends on seeing precisely:
 *
 *   - `status --porcelain=v2 -z --branch`: NUL-terminated entries, raw paths,
 *     a `#`-prefixed branch header with ahead/behind and unborn-HEAD markers;
 *   - `diff --numstat -z`: tab-separated counts, NUL-terminated entries, a
 *     rename record whose path field is empty before its two rename halves;
 *   - `log --format=<NUL fields, SOH records>`: unambiguous field split for
 *     subjects and bodies that may hold any other byte;
 *   - unified diff text parsed into hunks with a binary marker.
 *
 * Verified byte-for-byte against Apple Git 2.54 (see test/parse.test.mjs).
 *
 * @module dsh-sidebar-git/parse
 */

/** NUL: porcelain v2 and numstat already speak it; my log format uses it as the field separator. */
export const NUL = '\u0000'
/** SOH: the record separator of the log / branch / stash formats. */
export const SOH = '\u0001'

// ── format strings (runner and parser must never drift) ─────────────────────

/** `git log --format=`: hash, short hash, parents, subject, author name, email, strict date, decorations, body last. */
export const LOG_FORMAT = ['%H', '%h', '%P', '%s', '%an', '%ae', '%aI', '%D', '%B'].join('%x00') + '%x01'
/**
 * `git branch --format=`: name, HEAD mark, upstream, track, strict date, short
 * hash, subject last. `git branch` runs the for-each-ref engine, which does
 * NOT expand `%x00` — so the field separator is a literal TAB character, and
 * records end with git's own newline. The subject is last so a stray tab
 * inside it joins back instead of corrupting the fixed fields.
 */
export const BRANCH_FORMAT = [
  '%(refname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:iso-strict)',
  '%(objectname:short)',
  '%(contents:subject)',
].join('\t')
/** `git stash list --format=`: selector, subject, commit, strict date (log engine: NUL fields, SOH records). */
export const STASH_FORMAT = ['%gd', '%gs', '%H', '%aI'].join('%x00') + '%x01'

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 *
 * Entry shapes (each NUL-terminated, paths raw because `-z`):
 *
 *   # branch.oid <oid>          — `(initial)` when HEAD is unborn
 *   # branch.head <name>        — `(detached)` when HEAD detaches
 *   # branch.upstream <name>    — present only with an upstream
 *   # branch.ab +A -B           — present only with an upstream
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> ... <Xscore> <path> NUL <origPath>
 *   u <XY> <sub> <m1><m2><m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>                    — untracked
 *   ! <path>                    — ignored (only when asked; dropped here)
 *
 * @param text - the raw stdout.
 * @param options - `originTail`: the session working directory relative to the
 *   repository root (empty when it *is* the root), for display paths.
 * @returns `{ branch, files }`; each file entry is
 *   `{path, display, xy, x, y, untracked, conflict, renamedFrom?}` where `path`
 *   is repository-relative and `display` follows the session working directory.
 */
export function parseStatus(text, options = {}) {
  /** The `#` header of the same porcelain stream. */
  const branch = { oid: '', head: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false }
  const files = []
  const tail = typeof options.originTail === 'string' ? options.originTail : ''

  const segments = text.split(NUL)
  for (let at = 0; at < segments.length; at += 1) {
    const entry = segments[at]
    if (entry.length === 0) continue

    if (entry.startsWith('# ')) {
      const space = entry.indexOf(' ', 2)
      if (space < 0) continue
      const field = entry.slice(2, space)
      const value = entry.slice(space + 1)
      if (field === 'branch.oid') {
        branch.oid = value
        branch.unborn = value === '(initial)'
      } else if (field === 'branch.head') {
        branch.head = value
        branch.detached = value === '(detached)'
      } else if (field === 'branch.upstream') {
        branch.upstream = value
      } else if (field === 'branch.ab') {
        const pair = /^\+([0-9]+) -([0-9]+)/.exec(value)
        if (pair !== null) {
          branch.ahead = Number(pair[1])
          branch.behind = Number(pair[2])
        }
      }
      continue
    }

    const tag = entry[0]
    if (tag === '1' || tag === '2' || tag === 'u') {
      const fields = entry.split(' ')
      // Prefix fields before the repository-relative path (paths may hold
      // spaces): `1` = tag,XY,sub,mH,mI,mW,hH,hI; `2` adds the Xscore; `u`
      // adds the three stage modes and three hashes.
      const fixed = tag === '1' ? 8 : tag === '2' ? 9 : 10
      if (fields.length < fixed) continue
      const path = fields.slice(fixed).join(' ')
      const xy = fields[1]
      // A rename entry's origin path arrives as its own NUL segment after the
      // record: `path` is the new name, `origPath` the old one.
      const renamedFrom = tag === '2' && at + 1 < segments.length ? segments[at + 1] : undefined
      if (tag === '2') at += 1
      files.push(
        makeEntry({
          path,
          originTail: tail,
          xy,
          untracked: false,
          conflict: tag === 'u',
          renamedFrom,
        }),
      )
      continue
    }

    if (tag === '?') {
      files.push(makeEntry({ path: entry.slice(2), originTail: tail, xy: '??', untracked: true }))
      continue
    }
  }

  return { branch, files }
}

/**
 * Build one file entry with split statuses and a display path.
 *
 * @param parts - raw porcelain parts for one entry.
 * @returns the normalized entry.
 */
function makeEntry(parts) {
  const { path, originTail, xy, untracked, conflict, renamedFrom } = parts
  // Porcelain v2 always reports a two-letter XY; a shorter one is malformed and
  // falls back to the untracked pair so the row still groups somewhere visible.
  const pair = untracked || typeof xy !== 'string' || xy.length < 2 ? '??' : xy
  const entry = {
    path,
    display: displayFor(originTail, path),
    xy: pair,
    untracked: untracked === true,
    conflict: conflict === true,
  }
  if (renamedFrom !== undefined && renamedFrom.length > 0) entry.renamedFrom = renamedFrom
  return entry
}

/**
 * One display path: relative to the session working directory when the file
 * lies below it, `../`-prefixed when it belongs to this repository but lives
 * elsewhere — the labelling `dsh-workspace-changes` orders by, mirroring the
 * user's own view of their workspace.
 *
 * @param originTail - session cwd relative to the repository root ('' when equal).
 * @param path - a repository-relative path.
 * @returns the display path.
 */
export function displayFor(originTail, path) {
  if (originTail === '') return path
  if (path === originTail) return originTail.slice(originTail.lastIndexOf('/') + 1) || path
  if (path.startsWith(originTail + '/')) return path.slice(originTail.length + 1)
  const depth = originTail.split('/').length
  return '../'.repeat(depth) + path
}

/**
 * Parse `git diff --numstat -z`.
 *
 * @param text - the raw stdout.
 * @returns a map keyed by the new path holding
 *   `{adds, dels, binary, renamedFrom?}`; `adds`/`dels` are `null` for binaries.
 */
export function parseNumstat(text) {
  const files = new Map()
  const segments = text.split(NUL)
  for (let at = 0; at < segments.length; at += 1) {
    const entry = segments[at]
    if (entry.length === 0) continue
    const firstTab = entry.indexOf('\t')
    if (firstTab < 0) continue
    const secondTab = entry.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const adds = count(entry.slice(0, firstTab))
    const dels = count(entry.slice(firstTab + 1, secondTab))
    const tail = entry.slice(secondTab + 1)
    if (tail.length === 0) {
      // Rename record: the two halves are the next two segments (origin, new).
      if (at + 2 >= segments.length) continue
      const origin = segments[at + 1]
      const next = segments[at + 2]
      files.set(next, { adds, dels, binary: adds === null, renamedFrom: origin })
      at += 2
      continue
    }
    files.set(tail, { adds, dels, binary: adds === null })
  }
  return files
}

/** `-` means binary; anything else must be a non-negative integer. */
function count(text) {
  if (text === '-') return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Merge one numstat map into status entries as a labeled count side.
 *
 * Conflict paths appear twice in one worktree numstat (stage 2 vs stage 3);
 * merging keeps the last, which is fine: the UI renders conflicts as counts-less.
 *
 * @param entries - `parseStatus`'s file entries.
 * @param counts - a `parseNumstat` map.
 * @param area - `'staged'` or `'worktree'`.
 */
export function attachCounts(entries, counts, area) {
  for (const entry of entries) {
    const found = counts.get(entry.path)
    if (found === undefined) {
      entry[area] = { adds: 0, dels: 0 }
      continue
    }
    entry[area] = { adds: found.adds ?? 0, dels: found.dels ?? 0 }
    if (found.renamedFrom !== undefined && entry.renamedFrom === undefined) entry.renamedFrom = found.renamedFrom
  }
}

/**
 * Sort entries the way the tab lists them: code-unit order on the display path,
 * so parents and `../` paths come before the working directory's own files.
 *
 * @param entries - entries to sort in place.
 * @returns the same array, sorted.
 */
export function sortByDisplay(entries) {
  entries.sort((one, other) => (one.display < other.display ? -1 : one.display > other.display ? 1 : 0))
  return entries
}

/**
 * Classify one entry into its UI group.
 *
 * @param entry - a `parseStatus` file entry.
 * @returns `'staged' | 'worktree' | 'untracked' | 'conflict'`.
 */
export function groupOf(entry) {
  if (entry.conflict) return 'conflict'
  if (entry.untracked) return 'untracked'
  const x = entry.xy[0] ?? '.'
  const y = entry.xy[1] ?? '.'
  if (x !== '.' && x !== '?') return 'staged'
  if (y !== '.' && y !== '?') return 'worktree'
  return 'untracked'
}

// ── log / branches / stashes ────────────────────────────────────────────────

/**
 * Parse the `LOG_FORMAT` record stream into commits (newest first).
 *
 * The body is the last field, so any NUL inside it joins back safely; only a
 * stray SOH inside a body could split a record, which git's own separator
 * semantics make unreachable for normal commits.
 *
 * @param text - the raw stdout.
 * @returns commit rows `{hash, short, parents: [], subject, author, email, date, refs: [], body}`.
 */
export function parseLog(text) {
  const commits = []
  for (const record of text.split(SOH)) {
    if (record.length === 0) continue
    // git terminates each expansion with SOH then its own newline.
    const cleaned = record.endsWith('\n') ? record.slice(0, -1) : record
    const fields = cleaned.split(NUL)
    if (fields.length < 9) continue
    commits.push({
      hash: fields[0],
      short: fields[1],
      parents: fields[2].length === 0 ? [] : fields[2].split(' '),
      subject: fields[3],
      author: fields[4],
      email: fields[5],
      date: fields[6],
      refs: fields[7].length === 0 ? [] : fields[7].split(',').map((name) => name.trim()),
      body: fields.slice(8).join(NUL).replace(/\s+$/, ''),
    })
  }
  return commits
}

/**
 * Parse the tab-separated `BRANCH_FORMAT` record stream.
 *
 * @param text - the raw stdout (one newline-terminated record per branch).
 * @returns branch rows `{name, current, upstream, track, date, short, subject}`.
 */
export function parseBranches(text) {
  const branches = []
  for (const record of text.split('\n')) {
    if (record.length === 0) continue
    const fields = record.split('\t')
    if (fields.length < 7) continue
    branches.push({
      name: fields[0],
      current: fields[1] === '*',
      upstream: fields[2],
      track: fields[3],
      date: fields[4],
      short: fields[5],
      subject: fields.slice(6).join('\t'),
    })
  }
  return branches
}

/** Parse the `STASH_FORMAT` record stream into rows `{selector, subject, hash, date}`. */
export function parseStashes(text) {
  const stashes = []
  for (const record of text.split(SOH)) {
    if (record.length === 0) continue
    const cleaned = record.endsWith('\n') ? record.slice(0, -1) : record
    const fields = cleaned.split(NUL)
    if (fields.length < 4) continue
    stashes.push({ selector: fields[0], subject: fields[1], hash: fields[2], date: fields[3] })
  }
  return stashes
}

// ── diffs ───────────────────────────────────────────────────────────────────

/**
 * Parse plain unified diff text into hunks.
 *
 * Row tags: `+` added, `-` removed, `' '` context, `\` annotation (e.g. "\ No
 * newline at end of file"). File headers (`diff --git`, `index`, `---`, `+++`)
 * are metadata, not rows.
 *
 * @param text - the raw stdout of `git diff --no-color -U3 ...`.
 * @returns `{ binary, hunks }`; binary matches git's "Binary files ... differ".
 */
export function parseDiff(text) {
  const result = { binary: /^Binary files .* differ/.test(text.trimStart()), hunks: [] }
  let hunk = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) {
      const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
      if (head === null) continue
      hunk = {
        oldStart: Number(head[1]),
        oldLines: head[2] === undefined ? 1 : Number(head[2]),
        newStart: Number(head[3]),
        newLines: head[4] === undefined ? 1 : Number(head[4]),
        header: head[5] ?? '',
        lines: [],
      }
      result.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    if (line.startsWith('+')) hunk.lines.push({ t: '+', s: line.slice(1) })
    else if (line.startsWith('-')) hunk.lines.push({ t: '-', s: line.slice(1) })
    else if (line.startsWith(' ')) hunk.lines.push({ t: ' ', s: line.slice(1) })
    else if (line.startsWith('\\')) hunk.lines.push({ t: '\\', s: line })
    else hunk = null
  }
  return result
}
