#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT_VALUE="${PORT:-8000}"

while [ $# -gt 0 ]; do
  case "$1" in
    -p)
      PORT_VALUE="${2:-$PORT_VALUE}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

export PORT="$PORT_VALUE"
exec node "$SCRIPT_DIR/server.mjs"
