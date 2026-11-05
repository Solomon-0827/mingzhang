#!/bin/sh
set -eu

pid="$1"
archive="$2"
target="$3"
version="$4"
work="$(mktemp -d "${TMPDIR:-/tmp}/mingzhang-update.XXXXXX")"
backup="${target}.previous"
trap 'rm -rf "$work"' EXIT

while kill -0 "$pid" 2>/dev/null; do sleep 1; done
/usr/bin/ditto -x -k "$archive" "$work"
candidate="$work/明账.app"
test -d "$candidate"
/usr/bin/codesign --verify --deep --strict "$candidate"
rm -rf "$backup"
mv "$target" "$backup"
if mv "$candidate" "$target"; then
  rm -rf "$backup" "$archive"
  /usr/bin/open "$target"
else
  mv "$backup" "$target"
  exit 1
fi
