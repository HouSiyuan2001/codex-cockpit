// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ check: vi.fn(), openUrl: vi.fn() }));
vi.mock('./bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }));
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, openReleasePage, RELEASE_URL } from './appUpdate';
describe('private build update boundary', () => {
  it('never checks upstream on either channel', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await checkForAppUpdate('stable')).toBeNull();
    expect(await checkForAppUpdate('beta')).toBeNull();
    expect(mocks.check).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('refuses download and install even if invoked directly', async () => {
    await expect(downloadAppUpdate(vi.fn())).rejects.toThrow();
    await expect(installAppUpdate()).rejects.toThrow();
  });
  it('never opens an externally supplied upstream release', async () => {
    await openReleasePage('https://github.com/silverlion2/quota-float/releases/latest');
    if (RELEASE_URL) expect(mocks.openUrl).toHaveBeenCalledWith(RELEASE_URL);
    else expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
