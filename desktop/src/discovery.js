/**
 * Launch-token recovery for the desktop shell's readiness probe.
 *
 * Since dsh 0.1.5 a web server authenticates the browser with a per-process
 * launch token: the bare root URL answers 401, and only the printed
 * `/?token=...` URL mints the session cookie before redirecting to `/`. A
 * readiness probe that fetches `/` therefore never sees the app, so it must
 * present the token — and the token exists only on that process's stdout, which
 * the shell already tees into a log file.
 *
 * Older dsh releases print no token; every helper here returns null then, and
 * the probe falls back to the bare root.
 */

/** The `token` query parameter of a `dsh web` URL, or null. */
function tokenFromUrl(url) {
  const match = /[?&]token=([^&\s]+)/.exec(url || '')
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * The last `dsh web: <url>` line's token in a log's text, or null.
 *
 * The last occurrence wins: a log is appended to across restarts, and the
 * newest server owns the token that is currently valid.
 * @param text - the raw log text.
 * @returns the token, or null when the log carries no tokenized URL.
 */
function tokenFromLog(text) {
  const matches = [...String(text || '').matchAll(/dsh web:\s*(http:\/\/\S+)/g)]
  const url = matches.at(-1)?.[1]
  return url ? tokenFromUrl(url) : null
}

/**
 * Every `dsh web: <url>` token in a log's text, newest first.
 *
 * One log accumulates a line per run, and a stale line is indistinguishable from
 * a live one, so callers get all of them in recency order and confirm a candidate
 * against the running server instead of trusting the newest line alone.
 * @param text - the raw log text.
 * @returns distinct tokens, newest first.
 */
function tokensFromLog(text) {
  const matches = [...String(text || '').matchAll(/dsh web:\s*(http:\/\/\S+)/g)]
  const out = []
  for (const match of matches.reverse()) {
    const token = tokenFromUrl(match[1])
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * The root URL to probe.
 * @param port - the local port.
 * @param token - the launch token, or null/undefined when none is known.
 * @returns the tokenized URL when a token is known, else the bare root.
 */
function probeUrl(port, token) {
  return token
    ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    : `http://127.0.0.1:${port}/`
}

module.exports = { tokenFromUrl, tokenFromLog, tokensFromLog, probeUrl }
