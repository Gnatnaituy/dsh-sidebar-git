/**
 * Per-repository serial execution for mutating git operations.
 *
 * Git's own index locks make two concurrent writers runners-up to a crash of
 * one of them with `index.lock exists`; the tab's own writes serialize instead,
 * so "stage + commit" from a double click lands in a defined order. Reads run
 * concurrently — they hold no locks except the optional ones this plugin
 * disables (`GIT_OPTIONAL_LOCKS=0`).
 *
 * @module dsh-sidebar-git/queue
 */

/**
 * Create a queue.
 *
 * @returns an object whose `run(key, job)` awaits the tail of `key`'s chain;
 *   jobs for different keys run in parallel, a rejected job never poisons the
 *   key's chain, and the returned promise carries the job's own result.
 */
export function createQueue() {
  /** @type {Map<string, Promise<void>>} tail of each key's chain, never rejected. */
  const tails = new Map()

  return {
    run(key, job) {
      const prior = tails.get(key) ?? Promise.resolve()
      const guarded = prior.then(() => job())
      tails.set(
        key,
        guarded.then(
          () => undefined,
          () => undefined,
        ),
      )
      return guarded
    },
  }
}
