#!/bin/sh
# Keeps nod's UI server (ui/, http://127.0.0.1:4800) up from login, for the desktop app.
#
#   sh desktop/launchd/ui.sh install     build ui/ and (re)start the agent; again after a pull
#   sh desktop/launchd/ui.sh uninstall   stop the agent and remove it
#
# The agent serves ui/'s build, not the dev server, which fails for a moment whenever the repo
# switches branches. Like `nod schedule on`, it runs with this shell's PATH (bun, tmux, git, claude),
# its NOD_HOME and CLAUDE_CONFIG_DIR when they are set, and what else nod passes to workers but
# secrets and the SSH agent.
set -eu

label=io.github.kkokworks.nod.ui
here=$(cd "$(dirname "$0")" && pwd)
ui=$(cd "$here/../../ui" && pwd)
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/nod-ui.log"
domain="gui/$(id -u)"
url=http://127.0.0.1:4800

# Waits up to $2 seconds for curl on the server's address to exit with $1: 0 once a server
# answers there, 7 once nothing listens. Not through this shell's proxy, which would answer, nor
# with ~/.curlrc (-q), whose options can change the exit code.
await() {
  tries=$2
  while :; do
    code=0
    curl -q -s -o /dev/null --max-time 5 --noproxy '*' "$url" || code=$?
    [ "$code" -ne "$1" ] || return 0
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || return 1
    sleep 1
  done
}

case "${1:-}" in
install)
  bun=$(command -v bun) || {
    echo "bun is not on this shell's PATH; install it (https://bun.sh) or run this from a shell that has it" >&2
    exit 1
  }
  # ui/ is a workspace of the repo, so this installs the whole repo from the root bun.lock, not
  # ui/ alone (--filter ./ui): the server imports ../src, which needs the root's dependencies.
  # Built aside and swapped in: building in place empties dist/, which the running server serves.
  (cd "$ui" && "$bun" install && rm -rf dist.next && "$bun" run build --outDir dist.next)
  rm -rf "$ui/dist"
  mv "$ui/dist.next" "$ui/dist"
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  # Made aside and moved in last, so a failure leaves the agent as it was, not half made for the
  # next login to load.
  new=$(mktemp "${TMPDIR:-/tmp}/nod-ui-plist.XXXXXX")
  saved=$(mktemp "${TMPDIR:-/tmp}/nod-ui-env.XXXXXX")
  trap 'rm -f "$new" "$saved"' EXIT
  cp "$here/nod-ui.plist" "$new"
  # -replace on an array index inserts, so the sample's bun comes out first.
  plutil -remove ProgramArguments.0 "$new"
  plutil -insert ProgramArguments.0 -string "$bun" "$new"
  plutil -replace WorkingDirectory -string "$ui" "$new"
  plutil -replace EnvironmentVariables.PATH -string "$PATH" "$new"
  plutil -replace StandardOutPath -string "$log" "$new"
  plutil -replace StandardErrorPath -string "$log" "$new"
  for name in NOD_HOME CLAUDE_CONFIG_DIR; do
    value=$(printenv "$name" || true)
    if [ -n "$value" ]; then
      plutil -replace "EnvironmentVariables.$name" -string "$value" "$new"
    fi
  done
  # And what else a worker gets of this shell but secrets and the SSH agent (savedEnv): proxies,
  # locale, TMUX_TMPDIR.
  # Through a file, not a pipe: sh has no pipefail, so a pipe would hide bun failing.
  src=$(cd "$here/../../src" && pwd)
  "$bun" -e "import { savedEnv } from '$src/env.ts'
for (const [name, value] of Object.entries(savedEnv())) console.log(name + '\t' + value)" >"$saved"
  while IFS="$(printf '\t')" read -r name value; do
    plutil -replace "EnvironmentVariables.$name" -string "$value" "$new"
  done <"$saved"
  chmod 600 "$new"
  mv "$new" "$plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  # The server exits at once while another holds the port (`bun run dev` serves on it too), and
  # launchd would start it again and again.
  if ! await 7 10; then
    echo "another server answers on $url, a dev server perhaps (cd ui && bun run dev); stop it and run this again" >&2
    exit 1
  fi
  # How much of the log is from earlier runs, which a failure below leaves out.
  seen=$({ wc -c <"$log"; } 2>/dev/null || echo 0)
  # Right after the bootout, launchd may still be letting the old agent go, and a bootstrap then
  # fails with "5: Input/output error".
  tries=5
  until launchctl bootstrap "$domain" "$plist"; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || exit 1
    sleep 1
  done
  # launchd loads the agent even when its server dies at once, so it is up only once it answers.
  if ! await 0 15; then
    echo "the nod UI server did not answer on $url; the end of what it wrote to $log:" >&2
    tail -c "+$((seen + 1))" "$log" 2>/dev/null | tail -n 20 >&2
    exit 1
  fi
  echo "nod UI server: $url (agent $plist, log $log)"
  ;;
uninstall)
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $plist"
  ;;
*)
  echo "usage: sh $0 install|uninstall" >&2
  exit 2
  ;;
esac
