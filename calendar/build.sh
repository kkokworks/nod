#!/bin/sh
# Builds CalendarEvents.app into nod's home. It is an app bundle, ad-hoc signed, so macOS keeps the
# Calendar permission on it. Needs Xcode Command Line Tools (swiftc); rebuilding may ask again.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
app="${NOD_HOME:-$HOME/.nod}/CalendarEvents.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$dir/Info.plist" "$app/Contents/Info.plist"
swiftc -O -swift-version 5 "$dir/calendar-events.swift" -o "$app/Contents/MacOS/calendar-events"
codesign -s - --force "$app"
echo "built $app; run nod today once in a terminal to allow Calendar access"
