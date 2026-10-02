// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), download: vi.fn(), install: vi.fn(), close: vi.fn(), relaunch: vi.fn(), openUrl: vi.fn() }));
vi.mock('./bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-updater', () => ({ Update: class {
  version: string; body: string; date: string;
  constructor(metadata: { version: string; body: string; date: string }) { this.version = metadata.version; this.body = metadata.body; this.date = metadata.date; }
  download = mocks.download; install = mocks.install; close = mocks.close;
} }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }));
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, discardAppUpdate, openReleasePage, RELEASE_URL } from './appUpdate';
const metadata = { rid: 1, currentVersion: '0.3.0-beta.2', version: '0.3.0-beta.3', body: '更新', date: '2026-10-02T00:00:00Z', rawJson: {} };
describe('signed desktop updates', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.invoke.mockResolvedValue(metadata); });
  afterEach(async () => { await discardAppUpdate(); });
  it('uses the constrained native source and selected channel', async () => {
    expect(await checkForAppUpdate('beta')).toMatchObject({ version: metadata.version, channel: 'beta', automaticInstall: true });
    expect(mocks.invoke).toHaveBeenCalledWith('check_cockpit_update', { channel: 'beta' });
  });
  it('deduplicates simultaneous checks', async () => {
    await Promise.all([checkForAppUpdate('stable'), checkForAppUpdate('stable')]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('returns null only when the native check succeeds with no update', async () => {
    mocks.invoke.mockResolvedValue(null);
    expect(await checkForAppUpdate()).toBeNull();
    mocks.invoke.mockRejectedValue(new Error('private repository'));
    await expect(checkForAppUpdate()).rejects.toThrow('private repository');
  });
  it('downloads, reports progress and only then installs and relaunches', async () => {
    await checkForAppUpdate();
    await expect(installAppUpdate()).rejects.toThrow('Download and verify');
    const progress = vi.fn();
    mocks.download.mockImplementation(async callback => {
      callback({ event: 'Started', data: { contentLength: 100 } });
      callback({ event: 'Progress', data: { chunkLength: 50 } });
      callback({ event: 'Finished' });
    });
    await downloadAppUpdate(progress);
    expect(progress).toHaveBeenCalledWith({ downloadedBytes: 50, totalBytes: 100, percent: 50 });
    await installAppUpdate();
    expect(mocks.install).toHaveBeenCalledOnce(); expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it('never installs after signature/download failure', async () => {
    await checkForAppUpdate(); mocks.download.mockRejectedValue(new Error('invalid signature'));
    await expect(downloadAppUpdate(vi.fn())).rejects.toThrow('invalid signature');
    await expect(installAppUpdate()).rejects.toThrow('Download and verify');
    expect(mocks.install).not.toHaveBeenCalled(); expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it('releases old resources and ignores externally supplied release links', async () => {
    await checkForAppUpdate(); await discardAppUpdate();
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(downloadAppUpdate(vi.fn())).rejects.toThrow('Check for an update');
    await openReleasePage('https://github.com/silverlion2/quota-float/releases/latest');
    if (RELEASE_URL) expect(mocks.openUrl).toHaveBeenCalledWith(RELEASE_URL);
    else expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
