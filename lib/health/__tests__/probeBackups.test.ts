import { describe, it, expect } from 'vitest';
import { probeBackups, type BackupFs } from '../probes';
import { HEALTH_DETAILS } from '../details';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

function fakeFs(files: Record<string, number>, failList = false): BackupFs {
  return {
    async readdir() { if (failList) throw new Error('ENOENT'); return Object.keys(files); },
    async mtimeMs(path) { const name = path.split('/').pop() ?? ''; return files[name]; },
  };
}

describe('probeBackups', () => {
  it('is ok when the newest backup is within the allowed age', async () => {
    const fs = fakeFs({ 'db-20260926-020000.sql.gz': NOW - 10 * HOUR, 'db-20260925-020000.sql.gz': NOW - 34 * HOUR });
    expect(await probeBackups('/backups', 48, { fs, now: () => NOW })).toEqual({ ok: true, detail: HEALTH_DETAILS.backupRecent });
  });

  it('is degraded when the newest backup is too old', async () => {
    const fs = fakeFs({ 'db-20260920-020000.sql.gz': NOW - 150 * HOUR });
    expect(await probeBackups('/backups', 48, { fs, now: () => NOW })).toEqual({ ok: false, detail: HEALTH_DETAILS.backupStale });
  });

  it('is degraded when there is no backup, ignoring files that are not backups', async () => {
    const fs = fakeFs({ 'notes.txt': NOW, 'db-partial.sql.gz.tmp': NOW, 'models-20260926-020000.tar.gz': NOW });
    expect(await probeBackups('/backups', 48, { fs, now: () => NOW })).toEqual({ ok: false, detail: HEALTH_DETAILS.backupMissing });
  });

  it('is degraded, without throwing or naming a path, when the folder cannot be read', async () => {
    const result = await probeBackups('/secret/place', 48, { fs: fakeFs({}, true), now: () => NOW });
    expect(result).toEqual({ ok: false, detail: HEALTH_DETAILS.backupMissing });
    expect(JSON.stringify(result)).not.toContain('/secret');
  });
});
