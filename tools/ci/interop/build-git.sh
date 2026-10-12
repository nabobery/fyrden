#!/usr/bin/env bash
# Builds one pinned git release from its kernel.org tarball into a prefix, for
# the interoperability matrix. The tarball is checked against the SHA-256 in
# git-versions.txt before anything is unpacked.
#
#   tools/ci/interop/build-git.sh 2.43.7 /opt/git/2.43.7
#
# Needs a C toolchain and libcurl headers (Ubuntu: libcurl4-openssl-dev,
# zlib1g-dev). Only what smart HTTP needs is built: no Tcl/Tk, gettext, Perl,
# Python or expat (dumb-HTTP push).
set -euo pipefail

version="${1:?usage: build-git.sh <version> <prefix>}"
prefix="${2:?usage: build-git.sh <version> <prefix>}"
here="$(cd "$(dirname "$0")" && pwd)"

expected="$(awk -v v="$version" '$1 == v { print $2 }' "$here/git-versions.txt")"
if [ -z "$expected" ]; then
  echo "git $version is not pinned in git-versions.txt" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tarball="$work/git-$version.tar.xz"
curl --fail --silent --show-error --location --retry 3 \
  -o "$tarball" "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$version.tar.xz"

if command -v sha256sum > /dev/null; then
  actual="$(sha256sum "$tarball" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
fi
if [ "$actual" != "$expected" ]; then
  echo "git-$version.tar.xz: SHA-256 $actual, expected $expected" >&2
  exit 1
fi

tar -xJf "$tarball" -C "$work"
jobs="$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)"
make -C "$work/git-$version" -j"$jobs" prefix="$prefix" \
  NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_EXPAT=1 \
  install > "$work/build.log" 2>&1 || {
  tail -50 "$work/build.log" >&2
  exit 1
}
"$prefix/bin/git" --version
