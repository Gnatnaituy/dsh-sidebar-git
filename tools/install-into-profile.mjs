/**
 * Install dsh-sidebar-git into a DSH profile.
 *
 * Deliberately not `dsh plugin add`: that runs pnpm, which re-resolves the whole
 * profile over the network. The three things the profile actually needs are done
 * in place and idempotently:
 *
 *   1. link (or copy) the package into the profile's `node_modules`, so both the
 *      Cordis Loader and the client-module scanner can resolve
 *      `dsh-sidebar-git` from the profile's own resolution base;
 *   2. list it in `dependencies`, and in `dsh.profile.bundles` — the bundle form
 *      is the supported mount, and the one this package declares for itself in
 *      its root `cordis.patch.yml`. A hand-written row in the profile's own
 *      `cordis.patch.yml` would be a second mount of the same entry id;
 *   3. sweep such a hand-written row when an earlier revision of this script
 *      left one behind, so the profile ends up with exactly one mount.
 *
 * dsh-sidebar-browser, dsh-token-usage and dsh-sidebar-chat mount the same way,
 * so all four sidebar plugins sit in one place.
 *
 * The profile hot-reloads both the manifest's `bundles` list and the profile
 * patch, so the mount lands without a restart.
 *
 * Usage:
 *   node tools/install-into-profile.mjs [--profile <dir>] [--name <profile>] [--copy] [--dry-run]
 *   node tools/install-into-profile.mjs --uninstall [--dry-run]
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name: the Loader row name, the client module id, and the directory name. */
const PACKAGE_NAME = 'dsh-sidebar-git'
/** Loader entry id of the mounted row. */
const ENTRY_ID = 'sidebar-git'
/** Insert the bundle row after the chat tab, so the sidebar plugins stay grouped. */
const BUNDLE_AFTER = 'dsh-sidebar-chat'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const dryRun = flag('--dry-run')
const uninstall = flag('--uninstall')
const copy = flag('--copy')

/** The harness home this deployment actually booted with. */
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** The profile to install into: `$DSH_PROFILE_DIR`, else `<home>/profiles/<name>`. */
const profileDir = resolve(
  option(
    '--profile',
    process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', option('--name', 'desktop')),
  ),
)

/** Prefix a progress line for a dry run. */
const say = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)

/**
 * Drop one patch entry, the comment paragraph documenting it, and — for an
 * `- insert:` list — the `- insert:` line that owns the row.
 *
 * The entry is located by its id, so both shapes this package can leave in a
 * profile are recognized: the hand-written mount
 * (`- insert:` + `    - id: sidebar-git`), and the disable switch
 * (`- id: sidebar-git` + `  disabled: true`). Comments may be separated from
 * the entry by a blank line and may sit above or below other entries.
 *
 * @param text - the patch file's contents.
 * @param id - the entry id to drop.
 * @param options - `insertOnly` leaves a plain (non-insert) entry alone.
 * @returns the patch without that entry, and whether anything was removed.
 */
function dropEntry(text, id, options = {}) {
  const { insertOnly = false } = options
  const lines = text.split('\n')
  const at = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line))
  if (at < 0) return { text, removed: false }

  let end = at + 1
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1

  let start = at
  if (start > 0 && lines[start - 1].trim() === '- insert:') start -= 1
  else if (insertOnly) return { text, removed: false }

  while (start > 0 && (lines[start - 1].trim() === '' || /^\s*#/.test(lines[start - 1]))) start -= 1

  lines.splice(start, end - start)
  // Keep the entries that surrounded the block apart: the removed paragraph
  // owned the blank line that separated them.
  if (start > 0 && start < lines.length && lines[start - 1].trim() !== '' && lines[start].trim() !== '') {
    lines.splice(start, 0, '')
  }
  const next = `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s*$/, '')}\n`
  return { text: next, removed: true }
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`找不到 profile：${profileDir}（先启动一次 DSH 让它初始化）`)
  process.exit(1)
}
say(`profile: ${profileDir}`)
say(`source:  ${projectRoot}`)

const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const patchPath = join(profileDir, 'cordis.patch.yml')
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''

// ------------------------------------------------------------------ uninstall

if (uninstall) {
  // The patch first: a dangling `- id: sidebar-git` would only make the Loader
  // warn on every reload once the row it configures is gone.
  const { text, removed } = dropEntry(patch, ENTRY_ID)
  if (removed) {
    say(`cordis.patch.yml -= ${ENTRY_ID} 行`)
    if (!dryRun) writeFileSync(patchPath, text)
  } else {
    say(`cordis.patch.yml 没有 ${ENTRY_ID} 行`)
  }

  let manifestChanged = false
  if (manifest.dependencies[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME]
    manifestChanged = true
    say(`dependencies -= ${PACKAGE_NAME}`)
  }
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME)
    manifestChanged = true
    say(`dsh.profile.bundles -= ${PACKAGE_NAME}`)
  }
  if (manifestChanged && !dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const target = join(profileDir, 'node_modules', PACKAGE_NAME)
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    say(`删除 ${target}`)
    if (!dryRun) rmSync(target, { recursive: true, force: true })
  }
  say('完成。loader 会热卸载；硬刷新浏览器即可。')
  process.exit(0)
}

// ------------------------------------------------------------------ 1. link

const target = join(profileDir, 'node_modules', PACKAGE_NAME)
if (dryRun) {
  say(`会${copy ? '复制' : '软链'}到 ${target}`)
} else {
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    rmSync(target, { recursive: true, force: true })
  }
  if (copy) {
    cpSync(projectRoot, target, {
      recursive: true,
      filter: (source) => !source.includes('/.git') && !source.includes('/node_modules') && !source.includes('/test'),
    })
    say(`已复制到 ${target}`)
  } else {
    symlinkSync(projectRoot, target, 'dir')
    say(`已软链 ${target} → ${projectRoot}`)
  }
}

// ---------------------------------------------------- 2. dependency + bundle

const dependencySpec = copy ? `file:${target}` : `link:${projectRoot}`
let manifestChanged = false
if (manifest.dependencies[PACKAGE_NAME] !== dependencySpec) {
  manifest.dependencies[PACKAGE_NAME] = dependencySpec
  manifestChanged = true
  say(`dependencies += ${PACKAGE_NAME}: ${dependencySpec}`)
} else {
  say(`dependencies 已包含 ${PACKAGE_NAME}`)
}

const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes(PACKAGE_NAME)) {
  const at = bundles.indexOf(BUNDLE_AFTER)
  if (at >= 0) bundles.splice(at + 1, 0, PACKAGE_NAME)
  else bundles.push(PACKAGE_NAME)
  manifestChanged = true
  say(`dsh.profile.bundles += ${PACKAGE_NAME}`)
} else {
  say(`dsh.profile.bundles 已包含 ${PACKAGE_NAME}`)
}
manifest.dsh.profile.bundles = bundles

if (manifestChanged && !dryRun) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// ---------------------------------------------------------------- 3. the patch

// A hand-written mount from an earlier revision of this installer has to go: it
// would insert the same entry id the bundle layer already contributes. A plain
// `- id: sidebar-git` entry is left alone — that is the documented disable
// switch, and installing is not the place to overrule it.
const swept = dropEntry(patch, ENTRY_ID, { insertOnly: true })
if (swept.removed) {
  say(`cordis.patch.yml -= 手写的挂载行（改由 bundle 层提供）`)
  if (!dryRun) writeFileSync(patchPath, swept.text)
} else {
  say(`cordis.patch.yml 没有手写的挂载行`)
}

say(
  '完成。profile 的 bundles 列表会被热重载，几秒后刷新页面即可在右侧栏看到「Git」页签；无需重启 DSH。',
)
