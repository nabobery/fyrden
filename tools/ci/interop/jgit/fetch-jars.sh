#!/usr/bin/env bash
# Downloads the pinned JGit jars (jars.txt) into a directory, checks each
# SHA-256, and prints the Java classpath. Jars already present and matching
# are kept, so a cached directory is reused.
#
#   export FYRDEN_JGIT_CLASSPATH="$(tools/ci/interop/jgit/fetch-jars.sh ~/.cache/fyrden-jgit)"
set -euo pipefail

dir="${1:?usage: fetch-jars.sh <directory>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dir"

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

classpath=""
while read -r path expected; do
  case "$path" in "" | "#"*) continue ;; esac
  jar="$dir/$(basename "$path")"
  if [ ! -f "$jar" ] || [ "$(sha256 "$jar")" != "$expected" ]; then
    curl --fail --silent --show-error --location --retry 3 \
      -o "$jar.part" "https://repo1.maven.org/maven2/$path"
    actual="$(sha256 "$jar.part")"
    if [ "$actual" != "$expected" ]; then
      rm -f "$jar.part"
      echo "$(basename "$path"): SHA-256 $actual, expected $expected" >&2
      exit 1
    fi
    mv "$jar.part" "$jar"
  fi
  classpath="${classpath:+$classpath:}$jar"
done < "$here/jars.txt"
echo "$classpath"
