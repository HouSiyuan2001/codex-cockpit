import { describe, expect, it } from 'vitest';
// @ts-expect-error node release script deliberately uses JavaScript
import { makeManifest, assertNewer } from './updater-manifest.mjs';
describe('update publication boundary', () => {
  const fixture = { repository: 'HouSiyuan2001/codex-cockpit', version: '0.3.0-beta.3', files: ['Codex.Cockpit.app.tar.gz', 'Codex.Cockpit_0.3.0-beta.3_x64-setup.exe'], signature: () => 'signed-fixture', notes: 'test', date: '2026-10-02T00:00:00Z' };
  it('covers both Mac CPUs and Windows using versioned assets in the original repo', () => {
    const feed = makeManifest(fixture);
    expect(Object.keys(feed.platforms)).toEqual(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
    expect(feed.platforms['darwin-aarch64']).toEqual(feed.platforms['darwin-x86_64']);
    expect(feed.platforms['windows-x86_64'].url).toContain('/codex-cockpit/releases/download/v0.3.0-beta.3/');
  });
  it('refuses incomplete or unsigned platform sets', () => {
    expect(() => makeManifest({ ...fixture, files: fixture.files.slice(0, 1) })).toThrow();
    expect(() => makeManifest({ ...fixture, signature: () => '' })).toThrow();
  });
  it('prevents an older concurrent build from replacing a newer feed', () => {
    expect(() => assertNewer('0.3.0-beta.3', '0.3.0-beta.2')).not.toThrow();
    expect(() => assertNewer('0.3.0', '0.3.0-beta.3')).not.toThrow();
    expect(() => assertNewer('0.3.0-beta.2', '0.3.0-beta.3')).toThrow();
    expect(() => assertNewer('0.3.0-beta.3', '0.3.0-beta.3')).toThrow();
  });
});
