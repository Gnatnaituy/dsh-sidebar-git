/**
 * Host-half tests: the pure parsers and guard rails get canned git bytes (the
 * byte shapes verified against Apple Git 2.54 during development), and the
 * apply() routes run end-to-end against a real fixture repository through a
 * subprocess shim.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'

import { createResolver, createBindingStore, originTailOf } from '../lib/binding.js'
import { classifyGitFailure, createGitRunner, GitError } from '../lib/git.js'
import {
  actionOf,
  createGate,
  intInRange,
  normalizeAbsolutePath,
  normalizeCommitMessage,
  normalizeRepoPath,
  plausibleBranchName,
} from '../lib/guard.js'
import { createQueue } from '../lib/queue.js'
import {
  attachCounts,
  BRANCH_FORMAT,
  displayFor,
  groupOf,
  LOG_FORMAT,
  parseBranches,
  parseDiff,
  parseLog,
  parseNumstat,
  parseStatus,
  parseStashes,
  sortByDisplay,
  STASH_FORMAT,
} from '../lib/parse.js'
import { apply } from '../lib/index.js'
import { buildFixture, createHost, createSubprocess, drive, fixtureSessions, shell } from './helpers.mjs'
import { realpathSync } from 'node:fs'

/** macOS /var↔/private/var: compare roots through realpath. */
function realRoot(path) {
  return realpathSync(path)
}

// ── parse: porcelain v2 -z ───────────────────────────────────────────────────

const PORCELAIN = [
  '# branch.oid cec7aca0c4a4862b4a65e250e8c81bdd7be6d03d',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 DEAD BEEF path with space.txt',
  '2 R. N... 100644 100644 100644 CAFE F00D 58 lib/new-name.js',
  'lib/old-name.js',
  'u AA N... 0 0 0 0 0 0 0 conflicted.md',
  '? 带空格与中文 untracked.txt',
  '! ignored-thing.txt',
].join('\u0000') + '\u0000'

describe('parseStatus', () => {
  it('reads branch header fields (ahead, upstream, unborn markers)', () => {
    const parsed = parseStatus(PORCELAIN)
    assert.equal(parsed.branch.head, 'main')
    assert.equal(parsed.branch.upstream, 'origin/main')
    assert.equal(parsed.branch.ahead, 2)
    assert.equal(parsed.branch.behind, 1)
    assert.equal(parsed.branch.detached, false)

    const unborn = parseStatus('# branch.oid (initial)\u0000# branch.head main\u0000')
    assert.equal(unborn.branch.unborn, true)
    assert.equal(unborn.branch.head, 'main')
  })

  it('keeps spaces in paths and splits rename pairs', () => {
    const parsed = parseStatus(PORCELAIN)
    const byPath = Object.fromEntries(parsed.files.map((entry) => [entry.path, entry]))
    assert.ok(byPath['path with space.txt'])
    assert.equal(byPath['lib/new-name.js'].renamedFrom, 'lib/old-name.js')
    assert.equal(byPath['lib/old-name.js'], undefined)
    assert.equal(byPath['conflicted.md'].conflict, true)
    assert.equal(byPath['带空格与中文 untracked.txt'].untracked, true)
    // Ignored files never become rows.
    assert.equal(parsed.files.some((entry) => entry.path.includes('ignored-thing')), false)
  })

  it('classifies entries into the four UI groups', () => {
    const parsed = parseStatus(PORCELAIN)
    const groups = { staged: [], worktree: [], untracked: [], conflict: [] }
    for (const entry of parsed.files) groups[groupOf(entry)].push(entry)
    assert.equal(groups.worktree.length, 1) // .M
    assert.equal(groups.staged.length, 1) // R.
    assert.equal(groups.untracked.length, 1) // ? 带 空格
    assert.equal(groups.conflict.length, 1) // u AA
  })
})

describe('displayFor', () => {
  it('is identity at the repository root', () => {
    assert.equal(displayFor('', 'lib/a.ts'), 'lib/a.ts')
  })
  it('drops the cwd prefix when the file sits below the working directory', () => {
    assert.equal(displayFor('sub', 'sub/inner.js'), 'inner.js')
    assert.equal(displayFor('deep/nested', 'deep/nested/plum.md'), 'plum.md')
  })
  it('climbs with ../ when the file belongs to the repo but not the cwd', () => {
    assert.equal(displayFor('sub', 'alpha.txt'), '../alpha.txt')
    assert.equal(displayFor('deep/nested', 'alpha.txt'), '../../alpha.txt')
  })
})

describe('groupOf', () => {
  it('maps the XY pair to the four groups', () => {
    assert.equal(groupOf({ xy: 'M.', conflict: false, untracked: false }), 'staged')
    assert.equal(groupOf({ xy: '.M', conflict: false, untracked: false }), 'worktree')
    assert.equal(groupOf({ xy: '??', conflict: false, untracked: true }), 'untracked')
    assert.equal(groupOf({ xy: 'AA', conflict: true, untracked: false }), 'conflict')
  })
})

// ── parse: numstat -z (tab counts, NUL records, rename halves) ──────────────

describe('parseNumstat', () => {
  it('reads plain and binary counts', () => {
    const counts = parseNumstat('12\t3\talpha.txt\u0000-\t-\tbin.dat\u0000')
    assert.equal(counts.get('alpha.txt').adds, 12)
    assert.equal(counts.get('alpha.txt').dels, 3)
    assert.equal(counts.get('bin.dat').binary, true)
  })

  it('reads rename records: empty path field, then origin then new', () => {
    const counts = parseNumstat('0\t0\t\u0000sub/beta.md\u0000sub/moved.md\u0000')
    const row = counts.get('sub/moved.md')
    assert.ok(row)
    assert.equal(row.renamedFrom, 'sub/beta.md')
    assert.equal(row.adds, 0)
    assert.equal(row.dels, 0)
  })

  it('attaches counts onto status entries by area, filling zero when absent', () => {
    const parsed = parseStatus('1 .M N... 100644 100644 100644 A B alpha.txt\u0000')
    const counts = parseNumstat('2\t4\talpha.txt\u0000')
    attachCounts(parsed.files, counts, 'worktree')
    attachCounts(parsed.files, parseNumstat(''), 'staged')
    assert.deepEqual(parsed.files[0].worktree, { adds: 2, dels: 4 })
    assert.deepEqual(parsed.files[0].staged, { adds: 0, dels: 0 })
  })

  it('sorts by display path (code-unit order)', () => {
    const sorted = sortByDisplay([
      { display: 'b' },
      { display: 'a' },
      { display: '../x' },
    ])
    assert.deepEqual(sorted.map((one) => one.display), ['../x', 'a', 'b'])
  })
})

// ── parse: the NUL/SOH record formats ───────────────────────────────────────

describe('log / branch / stash formats', () => {
  const LOG_SAMPLE =
    'abc\u0000abc1234\u0000def\u0000subject: 一切正常\u0000作者\u0000a@x\u00002026-10-09T02:00:00+08:00\u0000HEAD -> main, origin/main\u0000body line 1\nbody line 2\n\u0001' +
    'def\u0000def4567\u0000\u0000empty parent\u0000作者2\u0000b@x\u00002026-10-09T01:00:00+08:00\u0000\u0000body\u0001'

  it('parseLog splits NUL fields and keeps newlines only in the body', () => {
    const commits = parseLog(LOG_SAMPLE)
    assert.equal(commits.length, 2)
    assert.equal(commits[0].hash, 'abc')
    assert.equal(commits[0].short, 'abc1234')
    assert.equal(commits[0].subject, 'subject: 一切正常')
    assert.ok(Array.isArray(commits[0].parents))
    assert.deepEqual(commits[0].parents, ['def'])
    assert.deepEqual(commits[0].refs, ['HEAD -> main', 'origin/main'])
    assert.equal(commits[0].body, 'body line 1\nbody line 2')
    assert.equal(commits[1].parents.length, 0)
  })

  it("the LOG_FORMAT constant closes each record with SOH, body field last", () => {
    assert.ok(LOG_FORMAT.endsWith('%B%x01'))
  })

  it('parseBranches reads the tab-separated for-each-ref format', () => {
    const sample = [
      ['main', '*', 'origin/main', 'ahead 2, behind 1', '2026-10-09T02:00:00+08:00', 'abc1234', 'subject'].join('\t'),
      ['dev', ' ', '', 'ahead 1', '2026-10-09T02:00:00+08:00', 'def4567', 'subject with\ttab'].join('\t'),
    ].join('\n')
    assert.ok(BRANCH_FORMAT.startsWith('%(refname:short)'))
    const branches = parseBranches(sample)
    assert.equal(branches[0].current, true)
    assert.equal(branches[0].track, 'ahead 2, behind 1')
    assert.equal(branches[1].current, false)
    assert.equal(branches[1].subject, 'subject with\ttab', 'a tab inside the subject joins back')
  })

  it('parseStashes reads selectors and subjects', () => {
    const sample = 'stash@{0}\u0000On main: note\u0000abc12345678901234567890123456789012345678\u00002026-10-09T02:00:00+08:00\u0001'
    assert.ok(STASH_FORMAT.startsWith('%gd'))
    const stashes = parseStashes(sample)
    assert.equal(stashes[0].selector, 'stash@{0}')
    assert.equal(stashes[0].subject, 'On main: note')
  })
})

// ── parse: unified diff ─────────────────────────────────────────────────────

describe('parseDiff', () => {
  it('parses hunks with all line tags', () => {
    const sample = [
      'diff --git a/alpha.txt b/alpha.txt',
      'index DEAD..BEEF 100644',
      '--- a/alpha.txt',
      '+++ b/alpha.txt',
      '@@ -1,3 +1,4 @@ 配置',
      ' context line',
      '-removed line',
      '+added line',
      '\\ No newline at end of file',
      '+another added',
    ].join('\n')
    const parsed = parseDiff(sample)
    assert.equal(parsed.binary, false)
    assert.equal(parsed.hunks.length, 1)
    const hunk = parsed.hunks[0]
    assert.equal(hunk.oldStart, 1)
    assert.equal(hunk.oldLines, 3)
    assert.equal(hunk.newStart, 1)
    assert.equal(hunk.newLines, 4)
    assert.equal(hunk.lines.length, 5)
    assert.deepEqual(hunk.lines.map((line) => line.t), [' ', '-', '+', '\\', '+'])
  })

  it('flags binary files', () => {
    const parsed = parseDiff('Binary files a/bin.dat and b/bin.dat differ\n')
    assert.equal(parsed.binary, true)
    assert.equal(parsed.hunks.length, 0)
  })

  it('leaves a zero-hunk answer for garbage input', () => {
    const parsed = parseDiff('total nonsense\n@@ malformed')
    assert.equal(parsed.hunks.length, 0)
    assert.equal(parsed.binary, false)
  })
})

// ── guard: paths / branches / messages / the T2 gate ────────────────────────

describe('guard: normalizeRepoPath', () => {
  it('accepts clean repository-relative paths', () => {
    assert.equal(normalizeRepoPath('lib/a.ts'), 'lib/a.ts')
    assert.equal(normalizeRepoPath('带 中文 b.md'), '带 中文 b.md')
  })

  it('rejects traversal, absolute paths, backslashes, NUL and oversize', () => {
    assert.equal(normalizeRepoPath('../etc/passwd'), undefined)
    assert.equal(normalizeRepoPath('lib/../../x'), undefined)
    assert.equal(normalizeRepoPath('/etc/passwd'), undefined)
    assert.equal(normalizeRepoPath('lib\\x'), undefined)
    assert.equal(normalizeRepoPath('a\u0000b'), undefined)
    assert.equal(normalizeRepoPath('a'.repeat(2000)), undefined)
    assert.equal(normalizeRepoPath(''), undefined)
    assert.equal(normalizeRepoPath(42), undefined)
  })

  it('rejects double slashes and trailing slashes', () => {
    assert.equal(normalizeRepoPath('lib//a.ts'), undefined)
    assert.equal(normalizeRepoPath('lib/'), undefined)
  })
})

describe('guard: branch names and commit messages', () => {
  it('plausibleBranchName kills the obvious absurdities', () => {
    assert.equal(plausibleBranchName('feature/x'), true)
    assert.equal(plausibleBranchName('main-2'), true)
    assert.equal(plausibleBranchName('-d'), false) // the argv injection vector
    assert.equal(plausibleBranchName('with space'), false)
    assert.equal(plausibleBranchName(''), false)
    assert.equal(plausibleBranchName('a\u0000b'), false)
    assert.equal(plausibleBranchName('非常长'.repeat(100)), false)
  })

  it('normalizeCommitMessage trims and bounds', () => {
    assert.equal(normalizeCommitMessage('  提交  '), '提交')
    assert.equal(normalizeCommitMessage(''), undefined)
    assert.equal(normalizeCommitMessage('a'.repeat(5000)), undefined)
    assert.equal(normalizeCommitMessage('a\u0000b'), undefined)
  })
})

describe('guard: misc validators', () => {
  it('intInRange bounds and defaults', () => {
    assert.equal(intInRange('5', 1, 10, 3), 5)
    assert.equal(intInRange(undefined, 1, 10, 3), 3)
    assert.equal(intInRange(0, 1, 10, 3), 3)
    assert.equal(intInRange(500, 1, 200, 50), 50)
  })

  it('actionOf allows only the fixed verbs', () => {
    assert.equal(actionOf('push', ['push', 'pull']), 'push')
    assert.equal(actionOf('sneaky', ['push', 'pull']), undefined)
    assert.equal(actionOf(undefined, ['push'], 'push'), 'push')
  })

  it('normalizeAbsolutePath demands an absolute, clean path', () => {
    assert.equal(normalizeAbsolutePath('/Users/x/repo'), '/Users/x/repo')
    assert.equal(normalizeAbsolutePath('repo'), undefined)
    assert.equal(normalizeAbsolutePath('a\u0000/b'), undefined)
  })
})

describe('guard: the T2 gate', () => {
  it('prepare → consume runs once; replay and mismatch fail', () => {
    const gate = createGate()
    const parked1 = gate.prepare('discard', { paths: ['a'] }, '/repo', {})
    assert.ok(parked1.token)
    const confirmed = gate.consume(parked1.token, 'discard', '/repo')
    assert.equal(confirmed.op, 'discard')
    assert.deepEqual(confirmed.args, { paths: ['a'] })
    assert.equal(gate.consume(parked1.token, 'discard', '/repo'), undefined)

    const parked2 = gate.prepare('stash-drop', { index: 0 }, '/repo', {})
    assert.equal(gate.consume(parked2.token, 'discard', '/repo'), undefined)
    assert.equal(gate.consume(parked2.token, 'stash-drop', '/other'), undefined)
  })

  it('tokens expire', () => {
    const gate = createGate({ ttlMs: -1 })
    const parked = gate.prepare('discard', { paths: ['a'] }, '/repo', {})
    assert.equal(gate.consume(parked.token, 'discard', '/repo'), undefined)
  })
})

// ── queue ───────────────────────────────────────────────────────────────────

describe('queue', () => {
  it('serializes per key and keeps rejections contained', async () => {
    const queue = createQueue()
    const order = []
    const first = queue.run('r', async () => {
      await new Promise((fulfil) => setTimeout(fulfil, 30))
      order.push('first')
      return 'F'
    })
    const second = queue.run('r', async () => {
      order.push('second')
      return 'S'
    })
    assert.deepEqual(await Promise.all([first, second]), ['F', 'S'])
    assert.deepEqual(order, ['first', 'second'])

    await queue
      .run('r', async () => {
        throw new Error('boom')
      })
      .catch(() => undefined)
    // The rejection must not poison the tail.
    const third = await queue.run('r', async () => 'after-boom')
    assert.equal(third, 'after-boom')
  })

  it('different keys run concurrently', async () => {
    const queue = createQueue()
    const started = []
    await Promise.all([
      queue.run('a', async () => {
        started.push('a@0')
        await new Promise((fulfil) => setTimeout(fulfil, 20))
        started.push('a@1')
      }),
      queue.run('b', async () => {
        started.push('b@0')
      }),
    ])
    assert.ok(started.indexOf('b@0') < started.indexOf('a@1'))
  })
})

// ── binding store + resolver ────────────────────────────────────────────────

describe('binding store', () => {
  it('persists bindings to its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binding-'))
    try {
      let existsTarget = true
      const store = createBindingStore({ dir, exists: () => existsTarget })
      await store.set('s1', '/tmp/some/repo')
      assert.equal(await store.get('s1'), '/tmp/some/repo')
      assert.ok(existsSync(join(dir, 'bindings.json')))

      existsTarget = false
      assert.equal(await store.manualPathAlive('s1', () => existsTarget), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a corrupt file without blocking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binding-'))
    writeFileSync(join(dir, 'bindings.json'), '{ not json')
    try {
      const store = createBindingStore({ dir })
      assert.equal(await store.get('nothing'), undefined)
      await store.set('s2', '/somewhere')
      assert.equal(await store.get('s2'), '/somewhere')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolver caches positives, serves negatives briefly, then recomputes', async () => {
    const resolver = createResolver()
    let calls = 0
    const compute = async () => {
      calls += 1
      return calls === 1 ? { root: '/repo/A', source: 'session' } : { root: undefined, reason: 'NO_REPO' }
    }
    assert.equal((await resolver.answer('s1', compute)).root, '/repo/A')
    assert.equal((await resolver.answer('s1', compute)).root, '/repo/A')
    assert.equal(calls, 1, 'the second answer is served from cache')

    // A turned-off repo answer is short-cached as well (no thundering herd).
    resolver.invalidate('s1')
    void (await resolver.answer('s1', compute))
    void (await resolver.answer('s1', compute))
    assert.equal(calls, 2)
  })

  it('originTailOf computes the cwd-to-root relative tail', () => {
    assert.equal(originTailOf('/repo/work', '/repo/work/sub'), 'sub')
    assert.equal(originTailOf('/repo/work/sub', '/repo/work/sub'), '')
  })
})

// ── git runner (classification + env policy) ───────────────────────────────

describe('git runner', () => {
  it('classifyGitFailure maps stderr to stable codes', () => {
    const cases = [
      ['fatal: not a git repository (or any of the parent directories): .git', 'NO_REPO'],
      ['fatal: this operation must be run in a work tree', 'NO_REPO'],
      ['error: Unable to create /repo/.git/index.lock: File exists.', 'LOCKED'],
      ['error: Your local changes to the following files would be overwritten by checkout:', 'DIRTY_WORKTREE_CONFLICT'],
      ['fatal: You have not concluded your merge (MERGE_HEAD exists).', 'UNMERGED'],
      ['On branch main\nnothing to commit, working tree clean', 'NOTHING_TO_COMMIT'],
      ['! [rejected] main -> origin/main (non-fast-forward)', 'PUSH_REJECTED'],
      ["fatal: It seems we can't fast-forward", 'NOT_FAST_FORWARD'],
      ['fatal: could not read Username for ...: terminal prompts disabled', 'AUTH_FAILED'],
      ["error: pathspec 'a != b' did not match", 'GIT_ERROR'],
    ]
    for (const [stderr, expected] of cases) {
      const classified = classifyGitFailure(stderr, 1)
      assert.equal(classified?.code, expected, stderr.slice(0, 40))
    }
    assert.equal(classifyGitFailure('', 0), undefined)
  })

  it('spawns git with the stability environment and answers exit facts', async () => {
    const spawns = []
    const subprocess = {
      resolveExecutable: async () => '/opt/git/bin/git',
      spawn(spec) {
        spawns.push(spec)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: 'true', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    }
    const runner = createGitRunner({ subprocess, logger: undefined })
    const result = await runner.mustRun(['rev-parse', '--is-inside-work-tree'], { cwd: '/repo' }, 'probe')
    assert.equal(result.stdout, 'true')
    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].env, {
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: ':',
      LC_ALL: 'C.UTF-8',
    })
  })

  it('answers GIT_MISSING when git does not resolve', async () => {
    const runner = createGitRunner({ subprocess: createSubprocess({ executableOf: async () => undefined }) })
    await assert.rejects(() => runner.run(['status']), (error) => error instanceof GitError && error.code === 'GIT_MISSING')
  })
})

// ── apply(): the routes, end to end over a real fixture repo ────────────────

describe('routes (integration with a real git fixture)', () => {
  let fixture
  let handler

  before(async () => {
    fixture = await buildFixture()
    const host = createHost({
      home: fixture.home,
      sessionCwds: fixtureSessions(fixture),
      subprocess: createSubprocess(),
    })
    apply(host.ctx)
    handler = host.services.capturedRoute.handler
  })

  after(() => {
    rmSync(fixture.root, { recursive: true, force: true })
  })

  it('registers one prefix route on the harness web server', () => {
    assert.equal(typeof handler, 'function')
  })

  it('GET /info answers diagnostics', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/info')
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-sidebar-git')
  })

  it('GET /repo resolves the session cwd to its repository root', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/repo?sessionId=s1')
    assert.equal(body.ok, true)
    assert.equal(body.repo.source, 'session')
    assert.equal(body.repo.root, realRoot(fixture.work))
  })

  it('GET /overview aggregates branch, counts and groups', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=s1')
    assert.equal(body.ok, true)
    assert.equal(body.branch.name, 'main')
    assert.equal(body.branch.detached, false)
    assert.ok(body.counts.staged >= 1) // staged.txt
    assert.ok(body.counts.untracked >= 1) // untracked.txt
    assert.ok(typeof body.rev === 'string' && body.rev.length > 0)
    const paths = body.groups.worktree.concat(body.groups.staged).map((file) => file.path)
    assert.ok(paths.includes('alpha.txt'))
    assert.ok(paths.includes('staged.txt'))
  })

  it('GET /repo answers NO_SESSION for an unknown id', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/repo?sessionId=missing')
    assert.equal(body.repo, null)
    assert.equal(body.reason, 'NO_SESSION')
  })

  it('GET /overview reports the empty repo as unborn, not missing', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=nor')
    assert.equal(body.ok, true)
    assert.equal(body.branch.unborn, true)
    assert.equal(body.counts.worktree + body.counts.staged + body.counts.untracked, 0)
  })

  it('GET /repo reports a directory outside any repo as NO_REPO', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/repo?sessionId=outside')
    assert.equal(body.repo, null)
    assert.equal(body.reason, 'NO_REPO')
  })

  it('POST /stage stages a worktree change (move between groups)', async () => {
    await drive(handler, 'POST', '/dsh-sidebar-git/stage', { sessionId: 's1', paths: ['alpha.txt'] })
    const after = (await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=s1')).body
    assert.ok(after.groups.staged.some((file) => file.path === 'alpha.txt'))
    assert.ok(!after.groups.worktree.some((file) => file.path === 'alpha.txt'))
  })

  it('POST /stage rejects traversal paths with 400', async () => {
    const { status, body } = await drive(handler, 'POST', '/dsh-sidebar-git/stage', { sessionId: 's1', paths: ['../../etc/passwd'] })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'BAD_ARGS')
  })

  it('POST /stage for a session without a repo answers repo: null', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/stage', { sessionId: 'missing', paths: ['x'] })
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'NO_SESSION')
  })

  it('POST /commit writes the stdin message and lands it in history', async () => {
    await drive(handler, 'POST', '/dsh-sidebar-git/stage', { sessionId: 's1', paths: ['staged.txt'] })
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/commit', { sessionId: 's1', message: '一次提交\n\n多行正文' })
    assert.equal(body.ok, true)
    assert.ok(body.commit.short.length > 0)
    const log = (await drive(handler, 'GET', '/dsh-sidebar-git/log?sessionId=s1&limit=1')).body
    assert.equal(log.commits[0].subject, '一次提交')
    assert.ok(log.commits[0].body.includes('多行正文'))
  })

  it('POST /commit answers NOTHING_TO_COMMIT on a clean tree', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/commit', { sessionId: 'clean', message: 'nothing here' })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'NOTHING_TO_COMMIT')
  })

  it('POST /commit rejects an empty message', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/commit', { sessionId: 's1', message: '   ' })
    assert.equal(body.error.code, 'BAD_MESSAGE')
  })

  it('GET /log pages and marks the end', async () => {
    const page1 = (await drive(handler, 'GET', '/dsh-sidebar-git/log?sessionId=s1&limit=1')).body
    assert.equal(page1.commits.length, 1)
    assert.equal(page1.done, false)
    const two = (await drive(handler, 'GET', '/dsh-sidebar-git/log?sessionId=s1&limit=200')).body
    assert.equal(two.done, true)
  })

  it('GET /log answers unborn for the empty repo instead of an error', async () => {
    const { body } = await drive(handler, 'GET', '/dsh-sidebar-git/log?sessionId=nor')
    assert.equal(body.ok, true)
    assert.deepEqual(body.commits, [])
    assert.equal(body.unborn, true)
  })

  it('GET /diff answers the staged diff with hunks', async () => {
    // Self-contained: stage a fresh change, then read its diff.
    await shell(fixture.work, 'echo diffboster >> alpha.txt && git add alpha.txt')
    const staged = (await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=s1&force=1')).body
    const target = staged.groups.staged.find((file) => file.path === 'alpha.txt')
    const { body } = await drive(handler, 'GET', `/dsh-sidebar-git/diff?sessionId=s1&path=${encodeURIComponent(target.path)}&area=staged`)
    assert.equal(body.ok, true)
    assert.equal(body.path, target.path)
    assert.ok(body.hunks.length >= 1)
    assert.ok(body.hunks.some((hunk) => hunk.lines.some((line) => line.t === '+')))
  })

  it('GET /diff rejects traversal and option-shaped commits', async () => {
    const traversal = await drive(handler, 'GET', '/dsh-sidebar-git/diff?sessionId=s1&path=..%2Fetc%2Fpasswd&area=staged')
    assert.equal(traversal.body.error.code, 'BAD_ARGS')
    const badCommit = await drive(handler, 'GET', '/dsh-sidebar-git/diff?sessionId=s1&path=alpha.txt&commit=--upload-pack')
    assert.equal(badCommit.body.error.code, 'BAD_ARGS')
    void spawn // imported for the shell helper parity; not used directly here
  })

  it('GET /commitfiles lists one commit’s files (root commit included) and refuses junk', async () => {
    // the fixture’s first commit added alpha.txt, sub/inner.js, deep/nested/plum.md, bin.dat
    await shell(fixture.work, 'git commit -qm nothing 2>/dev/null || true')
    const log = (await drive(handler, 'GET', '/dsh-sidebar-git/log?sessionId=s1&limit=1')).body
    const head = log.commits[0]
    const detail = (await drive(handler, 'GET', `/dsh-sidebar-git/commitfiles?sessionId=s1&commit=${head.hash}`)).body
    assert.equal(detail.ok, true)
    const paths = detail.files.map((file) => file.path)
    assert.ok(paths.includes('alpha.txt'), JSON.stringify(paths))

    const bad = (await drive(handler, 'GET', '/dsh-sidebar-git/commitfiles?sessionId=s1&commit=--upload-pack')).body
    assert.equal(bad.error.code, 'BAD_ARGS')
    const shortHash = (await drive(handler, 'GET', `/dsh-sidebar-git/commitfiles?sessionId=s1&commit=${head.short}`)).body
    assert.equal(shortHash.ok, true)
  })

  it('GET /branches and /stashes answer lists', async () => {
    const branches = (await drive(handler, 'GET', '/dsh-sidebar-git/branches?sessionId=s1')).body
    assert.ok(branches.branches.some((row) => row.name === 'main' && row.current))
    const stashes = (await drive(handler, 'GET', '/dsh-sidebar-git/stashes?sessionId=s1')).body
    assert.deepEqual(stashes.stashes, [])
  })

  it('POST /branch create+checkout, refuse self-delete, then delete after switching back', async () => {
    await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'create', name: 'feature/x' })
    const after = (await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=s1')).body
    assert.equal(after.branch.name, 'feature/x')

    const selfDelete = await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'delete', name: 'feature/x' })
    assert.equal(selfDelete.body.ok, false)

    await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'checkout', name: 'main' })
    await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'delete', name: 'feature/x' })
    const final = (await drive(handler, 'GET', '/dsh-sidebar-git/branches?sessionId=s1')).body
    assert.ok(!final.branches.some((row) => row.name === 'feature/x'))
  })

  it('POST /branch rejects a dash-leading name before git ever sees it', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'checkout', name: '--help' })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'BAD_REF')
  })

  it('POST /branch rejects a name git itself deems invalid', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'create', name: 'bad..name' })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'BRANCH_INVALID')
  })

  it('the T2 gate: discard prepare → confirm → single use', async () => {
    await shell(fixture.work, 'echo discarded >> deep/nested/plum.md')
    const prepared = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/prepare', { sessionId: 's1', op: 'discard', args: { paths: ['deep/nested/plum.md'] } })).body
    assert.equal(prepared.ok, true)
    assert.equal(prepared.op, 'discard')
    assert.ok(prepared.token)
    assert.deepEqual(prepared.impact.argv.slice(0, 3), ['git', 'checkout', '--'])
    assert.ok(prepared.impact.files.some((file) => file.path === 'deep/nested/plum.md'))

    const confirmed = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/confirm', { sessionId: 's1', op: 'discard', token: prepared.token })).body
    assert.equal(confirmed.ok, true)
    assert.deepEqual(confirmed.discarded, ['deep/nested/plum.md'])

    const replay = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/confirm', { sessionId: 's1', op: 'discard', token: prepared.token })).body
    assert.equal(replay.ok, false)
    assert.equal(replay.error.code, 'CONFIRM_INVALID')
  })

  it('the T2 gate rejects unknown ops', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/ops/prepare', { sessionId: 's1', op: 'reset-hard', args: {} })
    assert.equal(body.error.code, 'BAD_OP')
  })

  it('the T2 gate: stash push → prepare pop → confirm pop restores the work', async () => {
    // A tracked modification is what stash actually saves (untracked files stay
    // put without -u), so this test manufactures its own.
    await shell(fixture.work, 'echo stashme > stashme.txt && echo stashed-line >> alpha.txt')
    const pushed = (await drive(handler, 'POST', '/dsh-sidebar-git/stash', { sessionId: 's1', action: 'push', message: 'demo' })).body
    assert.equal(pushed.ok, true)
    const list = (await drive(handler, 'GET', '/dsh-sidebar-git/stashes?sessionId=s1')).body
    assert.equal(list.stashes.length, 1)
    assert.ok(list.stashes[0].subject.includes('demo'))

    // pop needs the gate: the direct route answers CONFIRM_REQUIRED
    const direct = (await drive(handler, 'POST', '/dsh-sidebar-git/stash', { sessionId: 's1', action: 'pop' })).body
    assert.equal(direct.error.code, 'CONFIRM_REQUIRED')

    const prepared = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/prepare', { sessionId: 's1', op: 'stash-pop', args: { index: 0 } })).body
    assert.equal(prepared.ok, true)
    assert.ok(prepared.impact.stash.selector.includes('stash@{'))
    const confirmed = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/confirm', { sessionId: 's1', op: 'stash-pop', token: prepared.token })).body
    assert.equal(confirmed.ok, true)
    const final = (await drive(handler, 'GET', '/dsh-sidebar-git/overview?sessionId=s1')).body
    assert.ok(final.groups.untracked.some((file) => file.path === 'stashme.txt'))
    const wt = final.groups.worktree.find((file) => file.path === 'alpha.txt')
    assert.ok(wt !== undefined, 'the popped stash restores the tracked alpha.txt change')
    assert.equal(!(!wt || wt.xy[1] !== 'M'), true)
    void wt
  })

  it('POST /stash on a clean tree answers NOTHING_TO_COMMIT (git exits 0 with a note)', async () => {
    // git stash push on a clean tree exits 0 with "No local changes to save" on
    // stdout; the route must not answer ok on that.
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/stash', { sessionId: 'clean', action: 'push', message: 'nothing' })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'NOTHING_TO_COMMIT')
  })

  it('the T2 gate: -d refuses an unmerged branch, -D needs prepare+confirm', async () => {
    await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'create', name: 'sacrifice' })
    await shell(fixture.work, 'echo sacrificial > sacrifice.txt')
    await drive(handler, 'POST', '/dsh-sidebar-git/stage', { sessionId: 's1', paths: ['sacrifice.txt'] })
    await drive(handler, 'POST', '/dsh-sidebar-git/commit', { sessionId: 's1', message: 'sacrificial commit' })
    await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'checkout', name: 'main' })

    const refused = (await drive(handler, 'POST', '/dsh-sidebar-git/branch', { sessionId: 's1', action: 'delete', name: 'sacrifice' })).body
    assert.equal(refused.ok, false)
    assert.ok(['UNMERGED', 'GIT_ERROR'].includes(refused.error.code))

    const prepared = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/prepare', { sessionId: 's1', op: 'branch-force-delete', args: { name: 'sacrifice' } })).body
    assert.equal(prepared.ok, true)
    const confirmed = (await drive(handler, 'POST', '/dsh-sidebar-git/ops/confirm', { sessionId: 's1', op: 'branch-force-delete', token: prepared.token })).body
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.deletedBranch, 'sacrifice')

    // Clean the sacrificial file for later tests.
    await shell(fixture.work, 'rm -f sacrifice.txt stashme.txt stashme.txt.orig && git stash clear')
  })

  it('POST /binding binds a session to a manual repository and persists', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/binding', { sessionId: 'clean', repoPath: realRoot(fixture.clean) })
    assert.equal(body.ok, true)
    assert.equal(body.repo.root, realRoot(fixture.clean), 'the manual bind answers the requested (realpathed) repo')
    const repo = (await drive(handler, 'GET', '/dsh-sidebar-git/repo?sessionId=clean')).body
    assert.equal(repo.repo.source, 'manual')
    assert.equal(repo.repo.root, realRoot(fixture.clean))
  })

  it('POST /binding refuses a non-repository path', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/binding', { sessionId: 'clean', repoPath: fixture.root })
    assert.equal(body.error.code, 'NO_REPO')
  })

  it('push without an upstream answers NO_UPSTREAM (and offers setUpstream)', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/push', { sessionId: 'nor' })
    assert.equal(body.error.code, 'NO_UPSTREAM')
  })

  it('pull without upstream answers NO_UPSTREAM', async () => {
    const { body } = await drive(handler, 'POST', '/dsh-sidebar-git/pull', { sessionId: 's1' })
    assert.equal(body.error.code, 'NO_UPSTREAM')
  })

  it('unknown routes answer 404 with NO_ROUTE', async () => {
    const { status, body } = await drive(handler, 'GET', '/dsh-sidebar-git/wat')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'NO_ROUTE')
  })
})
