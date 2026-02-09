import { describe, expect, it } from 'vitest';
import { buildCleanupPreview } from './filesystemAnalysis';

describe('filesystemAnalysis service', () => {
  it('builds safe cleanup preview from snapshot candidates', () => {
    const snapshot = {
      id: 'snap-1',
      cleanupCandidates: [
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 100, safe: true },
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 80, safe: true },
        { path: '/cache/b.bin', category: 'browser_cache', sizeBytes: 200, safe: true },
        { path: '/unsafe/c.log', category: 'logs', sizeBytes: 999, safe: true },
        { path: '/tmp/d.tmp', category: 'temp_files', sizeBytes: 50, safe: false }
      ]
    };

    const preview = buildCleanupPreview(snapshot);

    expect(preview.snapshotId).toBe('snap-1');
    expect(preview.candidateCount).toBe(2);
    expect(preview.estimatedBytes).toBe(300);
    expect(preview.candidates[0]?.path).toBe('/cache/b.bin');
    expect(preview.candidates[1]?.path).toBe('/tmp/a.tmp');
  });

  it('filters cleanup preview by requested categories', () => {
    const snapshot = {
      id: 'snap-2',
      cleanupCandidates: [
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 100, safe: true },
        { path: '/cache/b.bin', category: 'browser_cache', sizeBytes: 200, safe: true }
      ]
    };

    const preview = buildCleanupPreview(snapshot, ['temp_files']);
    expect(preview.candidateCount).toBe(1);
    expect(preview.estimatedBytes).toBe(100);
    expect(preview.candidates[0]?.category).toBe('temp_files');
  });
});
