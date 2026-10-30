import { configDir } from './account'
import { socketsDir } from './place'

// The environment a worker starts with, and what of it the OS scheduler and the UI server keep for
// the workers they start.

// How full, in percent of its auto-compact window, a conversation nod starts (a worker's, nod
// open's) gets before Claude Code (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) compacts it and goes on from a
// summary: before a worker that takes on more work for hours fills up. Claude Code's own default
// with a 1M window is about 967K tokens, and the variable can only lower it. A value the person set
// stays: their shell's passes on (PASS_ENV), and `env` in their Claude Code settings replaces the
// environment's. Measured on 2.1.310 with a 1M window, when this was 70 (60 is not measured): at 70
// it compacted once the conversation was between 654,459 and 699,430 tokens; at 10, the turn went
// on after compacting, in the same session.
// ponytail: a nod command run inside a session nod started takes the value it inherits for the
// person's, and `nod schedule on` or the UI server's install (savedEnv) there saves it; after
// changing this, do both again from outside, or mark nod's own value if that bites.
export const AUTOCOMPACT_PCT = '60'

// What a worker keeps of the environment it starts from: these names only. A terminal or an agent
// host marks each of its panes with variables of its own, and a worker that kept them would pass
// itself off as that pane to whatever reads them (one that switches accounts restarted a person's
// pane as the worker's conversation). No list of such markers is ever complete, so nod lists what
// a worker needs instead: who it runs as (the login keychain needs USER and HOME), its shell, temp
// folder, locale and time zone, the XDG folders git and gh read config from, the SSH agent, proxies
// and CA certificates, and Anthropic API settings, where nod's own tmux keeps its socket, for its
// hooks, and how early Claude Code compacts (AUTOCOMPACT_PCT). Anything else goes in Claude Code's
// own settings (`env` in settings.json), which it applies itself.
const PASS_ENV =
  /^(HOME|USER|LOGNAME|SHELL|TMPDIR|TZ|LANG|LC_[A-Z]+|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|XDG_RUNTIME_DIR|SSH_AUTH_SOCK|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|ANTHROPIC_[A-Z0-9_]+|TMUX_TMPDIR|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)$/
// Bun leaves proxy variables set while it runs out of process.env's keys (1.3.14), and the tick sets
// the saved environment so, so these are looked up by name as well.
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].flatMap((n) => [
  n,
  n.toLowerCase(),
])
// What a saved environment leaves out: names that hold a secret (a header carries a token), values
// that are a URL with a user in it (a proxy's password), proxies with a user and no scheme, which
// curl and git take too, and the SSH agent's socket, a new path at each boot, so a saved one would
// break the workers' SSH git after a restart.
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|HEADER/
const USER_IN_URL = /:\/\/[^/?#\s]*@/
const UNSAVED_ENV = new Set(['SSH_AUTH_SOCK'])
const hasUser = (key: string, value: string): boolean =>
  USER_IN_URL.test(value) || (/_PROXY$/i.test(key) && value.includes('@'))

// What PASS_ENV keeps of nod's environment.
function passedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of new Set([...Object.keys(process.env), ...PROXY_ENV])) {
    const value = process.env[key]
    if (value !== undefined && PASS_ENV.test(key)) env[key] = value
  }
  return env
}

// What the OS scheduler and the UI server keep of the shell that sets them up, for the workers they
// start (`nod schedule on`, desktop/launchd/ui.sh): what a worker gets, but secrets, which would
// sit in a plain file there, and SSH_AUTH_SOCK. A worker gets those from Claude Code's settings
// `env` instead, and the SSH agent from the environment it is started in.
export function savedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(passedEnv()).filter(
      ([key, value]) => !SECRET_ENV.test(key) && !hasUser(key, value) && !UNSAVED_ENV.has(key),
    ),
  )
}

// The whole environment a worker starts with (Terminals.start passes nothing else): what PASS_ENV
// keeps of nod's, nod's PATH, the account `config`, and AUTOCOMPACT_PCT unless nod's says. NOD_TASK
// names the task, so a todo the worker changes records `worker:<task>` (todos.ts), and NOD_SOCKETS
// tells its tests where they may keep Unix sockets (socketsDir).
export function workerEnv(
  home: string,
  taskId: number | null,
  config: string | null = configDir(home),
): Record<string, string> {
  const env = passedEnv()
  env.NOD_HOME = home
  env.PATH = process.env.PATH ?? ''
  if (taskId !== null) {
    env.NOD_TASK = String(taskId)
    env.NOD_SOCKETS = socketsDir(home, taskId)
  }
  if (config !== null) env.CLAUDE_CONFIG_DIR = config
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ||= AUTOCOMPACT_PCT
  return env
}
