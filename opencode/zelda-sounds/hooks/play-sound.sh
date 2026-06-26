#!/usr/bin/env bash
# Cross-platform sound player for zelda-sounds plugin
SOUND_FILE="$1"
[ -z "$SOUND_FILE" ] && exit 1
[ ! -f "$SOUND_FILE" ] && exit 1

case "$(uname -s)" in
  Darwin)
    afplay "$SOUND_FILE" &
    ;;
  Linux)
    if command -v paplay &>/dev/null; then
      paplay "$SOUND_FILE" &
    elif command -v aplay &>/dev/null; then
      aplay "$SOUND_FILE" &
    elif command -v ffplay &>/dev/null; then
      ffplay -nodisp -autoexit "$SOUND_FILE" &>/dev/null &
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    powershell.exe -c "(New-Object Media.SoundPlayer '$SOUND_FILE').PlaySync()" &
    ;;
esac
