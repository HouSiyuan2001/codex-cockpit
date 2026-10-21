#!/usr/bin/env bash
set -euo pipefail

# Run only on the disposable release runner, with synthetic empty app state.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || {
  echo 'Linux package smoke test requires a GitHub-hosted Linux job.' >&2
  exit 1
}
[[ "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || exit 1
shopt -s nullglob
debs=(src-tauri/target/release/bundle/deb/*.deb)
images=(src-tauri/target/release/bundle/appimage/*.AppImage)
[[ ${#debs[@]} -eq 1 && ${#images[@]} -eq 1 ]]
stage="$(mktemp -d "${RUNNER_TEMP}/cockpit-package-XXXXXX")"
dpkg-deb --info "${debs[0]}"
sudo apt-get install -y "$(realpath "${debs[0]}")"
binary=/usr/bin/quota-float
test -x "$binary"
if ldd "$binary" | grep -q 'not found'; then
  echo 'Installed Debian package has unresolved native libraries.' >&2
  exit 1
fi

smoke_launch() {
  local label="$1"
  shift
  mkdir -p "$stage/$label/config" "$stage/$label/data" "$stage/$label/cache"
  set +e
  XDG_CONFIG_HOME="$stage/$label/config" XDG_DATA_HOME="$stage/$label/data" \
    XDG_CACHE_HOME="$stage/$label/cache" GDK_BACKEND=x11 \
    xvfb-run -a dbus-run-session -- timeout --signal=TERM 20s "$@" \
    >"$stage/$label.log" 2>&1
  local result=$?
  set -e
  cat "$stage/$label.log"
  [[ $result -eq 124 ]] || {
    echo "$label exited before the startup smoke interval (exit $result)." >&2
    exit 1
  }
  if grep -Eiq 'panicked at|error while loading shared libraries|cannot open display' "$stage/$label.log"; then
    echo "$label reported a startup failure." >&2
    exit 1
  fi
}
for attempt in 1 2 3; do
  smoke_launch "deb-$attempt" "$binary"
done
image="$(realpath "${images[0]}")"
chmod +x "$image"
mkdir -p "$stage/appimage"
(cd "$stage/appimage" && "$image" --appimage-extract >/dev/null)
for attempt in 1 2 3; do
  smoke_launch "appimage-$attempt" "$stage/appimage/squashfs-root/AppRun"
done
sudo dpkg --remove "$(dpkg-deb --field "${debs[0]}" Package)"
echo 'Linux package install/startup/uninstall smoke passed; this is not interactive desktop acceptance.'
