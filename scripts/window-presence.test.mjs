import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const presence = source.split('fn apply_widget_window_presence(')[1].split('\nfn animate_window_to(')[0];

test('generic asynchronous level setter is excluded from macOS presence updates', () => {
  assert.match(presence, /#\[cfg\(not\(target_os = "macos"\)\)\]\s+window\s+\.set_always_on_top/);
  assert.match(presence, /#\[cfg\(target_os = "macos"\)\]\s+apply_macos_window_presence/);
  assert.equal((presence.match(/\.set_always_on_top/g) ?? []).length, 1);
  assert.doesNotMatch(presence, /set_focus|makeKey|activate/);
});

test('macOS hides the Dock only with a working tray and retains a failure fallback', () => {
  const traySetup = source.split('if setup_tray(app).is_err() {')[1].split('if preferences.locked')[0];
  const [fallback, success] = traySetup.split('} else {');
  assert.match(fallback, /#\[cfg\(target_os = "macos"\)\]\s+app\.set_activation_policy\(tauri::ActivationPolicy::Regular\)/);
  assert.match(fallback, /set_skip_taskbar\(false\)/);
  assert.match(success, /#\[cfg\(target_os = "macos"\)\]\s+app\.set_activation_policy\(tauri::ActivationPolicy::Accessory\)/);
  assert.doesNotMatch(fallback, /ActivationPolicy::Accessory/);
  const plist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});
