#!/bin/sh
# Keeps nod's UI server (ui/, http://127.0.0.1:4800) up from login, for the desktop app.
#
#   sh desktop/launchd/ui.sh install     build ui/ and (re)start the agent; again after a pull
#   sh desktop/launchd/ui.sh uninstall   stop the agent and remove it
#
# The agent serves ui/'s build, not the dev server, which fails for a moment whenever the repo
# switches branches. Like `nod schedule on`, it runs with this shell's PATH (bun, tmux, git, claude),
# its NOD_HOME and CLAUDE_CONFIG_DIR when they are set, and what else nod passes to workers but
# secrets.
set -eu

label=io.github.kkokworks.nod.ui
here=$(cd "$(dirname "$0")" && pwd)
ui=$(cd "$here/../../ui" && pwd)
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/nod-ui.log"
domain="gui/$(id -u)"

case "${1:-}" in
install)
  bun=$(command -v bun) || {
    echo "bun is not on this shell's PATH; install it (https://bun.sh) or run this from a shell that has it" >&2
    exit 1
  }
  (cd "$ui" && "$bun" install && "$bun" run build)
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cp "$here/nod-ui.plist" "$plist"
  # -replace on an array index inserts, so the sample's bun comes out first.
  plutil -remove ProgramArguments.0 "$plist"
  plutil -insert ProgramArguments.0 -string "$bun" "$plist"
  plutil -replace WorkingDirectory -string "$ui" "$plist"
  plutil -replace EnvironmentVariables.PATH -string "$PATH" "$plist"
  plutil -replace StandardOutPath -string "$log" "$plist"
  plutil -replace StandardErrorPath -string "$log" "$plist"
  for name in NOD_HOME CLAUDE_CONFIG_DIR; do
    value=$(printenv "$name" || true)
    if [ -n "$value" ]; then
      plutil -replace "EnvironmentVariables.$name" -string "$value" "$plist"
    fi
  done
  # And what else a worker gets of this shell but secrets (savedEnv): proxies, locale, TMUX_TMPDIR.
  src=$(cd "$here/../../src" && pwd)
  "$bun" -e "import { savedEnv } from '$src/worker.ts'
for (const [name, value] of Object.entries(savedEnv())) console.log(name + '\t' + value)" |
    while IFS="$(printf '\t')" read -r name value; do
      plutil -replace "EnvironmentVariables.$name" -string "$value" "$plist"
    done
  chmod 600 "$plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  echo "nod UI server: http://127.0.0.1:4800 (agent $plist, log $log)"
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
