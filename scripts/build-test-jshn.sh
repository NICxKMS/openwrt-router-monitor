#!/bin/sh
# Host-only test prerequisite; never installs anything on a router.
set -eu
revision=a396f38a8568a1d670c240465cd8d24fdfdf6463
prefix=${1:?Usage: build-test-jshn.sh ABSOLUTE_INSTALL_DIRECTORY}
case "$prefix" in /*) ;; *) echo 'Use an absolute installation directory.' >&2; exit 1;; esac
if [ -x "$prefix/bin/jshn" ] && [ "$(cat "$prefix/.nicx-libubox-revision" 2>/dev/null)" = "$revision" ]; then exit 0; fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
git init -q "$temporary/source"
git -C "$temporary/source" remote add origin https://git.openwrt.org/project/libubox.git
git -C "$temporary/source" fetch --depth 1 origin "$revision"
git -C "$temporary/source" checkout -q --detach FETCH_HEAD
test "$(git -C "$temporary/source" rev-parse HEAD)" = "$revision"
cmake -S "$temporary/source" -B "$temporary/build" -DBUILD_LUA=OFF -DBUILD_EXAMPLES=OFF -DCMAKE_INSTALL_PREFIX="$prefix"
cmake --build "$temporary/build" --parallel 2
cmake --install "$temporary/build"
test -x "$prefix/bin/jshn"
printf '%s\n' "$revision" > "$prefix/.nicx-libubox-revision"
