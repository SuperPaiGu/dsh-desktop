/**
 * Launcher selection for the desktop shell's window service.
 *
 * Extracted from main.js so the preference rules are unit-testable: the choice
 * decides which dsh a window runs, and getting it wrong silently moves a user's
 * session data to a different build.
 *
 * The window's own service follows `launcher`:
 *   auto      — a deepseek-harness checkout when one exists, else installed
 *   installed — the installed CLI only, so a checkout upgrade cannot move it
 *   checkout  — a checkout only; no installed fallback
 * The auxiliary instance never reaches here: it always runs the installed CLI.
 */

/**
 * Pick the launcher for the window's own `dsh web`.
 * @param options - the resolved facts this decision depends on.
 * @param options.preference - the configured `launcher` value; anything else means `auto`.
 * @param options.repo - an existing checkout directory, or '' / null for none.
 * @param options.decide - maps a checkout directory to its launch spec; throws when unrunnable.
 * @param options.installed - the installed-CLI command path, or null for none.
 * @param options.report - receives a human-readable reason for the choice.
 * @returns the launcher, or null when the preference cannot be satisfied.
 */
function chooseLauncher({ preference, repo, decide, installed, report }) {
  const mode = preference === 'installed' || preference === 'checkout' ? preference : 'auto'
  const installedLauncher = installed === null || installed === undefined
    ? null
    : { kind: 'dsh-bin', cmd: installed }

  if (mode !== 'installed' && repo) {
    try {
      return { kind: 'checkout', launch: decide(repo), repo }
    } catch (error) {
      // A checkout that exists but cannot run must not block the fallback: the
      // installed CLI is a complete launcher on its own.
      report(`checkout launcher unavailable: ${error.message}`)
      if (mode === 'checkout') return null
    }
  } else if (mode === 'checkout') {
    report('launcher=checkout but no deepseek-harness checkout was found')
    return null
  }

  return installedLauncher
}

module.exports = { chooseLauncher }
