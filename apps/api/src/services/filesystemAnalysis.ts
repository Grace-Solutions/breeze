import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceFilesystemSnapshots,
  filesystemSnapshotTriggerEnum,
} from '../db/schema/filesystem';

const SAFE_CLEANUP_CATEGORIES = new Set(['temp_files', 'browser_cache', 'package_cache', 'trash']);

export type FilesystemSnapshotTrigger = typeof filesystemSnapshotTriggerEnum.enumValues[number];

export type FilesystemCleanupCandidate = {
  path: string;
  category: string;
  sizeBytes: number;
  safe: boolean;
  reason?: string;
  modifiedAt?: string;
};

type AnyObject = Record<string, unknown>;

function asRecord(value: unknown): AnyObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as AnyObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

export function parseFilesystemAnalysisStdout(stdout: string): AnyObject {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const record = asRecord(parsed);
    return record ?? {};
  } catch {
    return {};
  }
}

export async function saveFilesystemSnapshot(
  deviceId: string,
  trigger: FilesystemSnapshotTrigger,
  payload: AnyObject
) {
  const summary = asRecord(payload.summary) ?? {};
  const partial = asBoolean(payload.partial, false);

  const [snapshot] = await db
    .insert(deviceFilesystemSnapshots)
    .values({
      deviceId,
      trigger,
      partial,
      summary,
      largestFiles: asArray(payload.topLargestFiles),
      largestDirs: asArray(payload.topLargestDirectories),
      tempAccumulation: asArray(payload.tempAccumulation),
      oldDownloads: asArray(payload.oldDownloads),
      unrotatedLogs: asArray(payload.unrotatedLogs),
      trashUsage: asArray(payload.trashUsage),
      duplicateCandidates: asArray(payload.duplicateCandidates),
      cleanupCandidates: asArray(payload.cleanupCandidates),
      errors: asArray(payload.errors),
      rawPayload: payload,
    })
    .returning();

  return snapshot ?? null;
}

export async function getLatestFilesystemSnapshot(deviceId: string) {
  const [snapshot] = await db
    .select()
    .from(deviceFilesystemSnapshots)
    .where(eq(deviceFilesystemSnapshots.deviceId, deviceId))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

function toCleanupCandidate(value: unknown): FilesystemCleanupCandidate | null {
  const record = asRecord(value);
  if (!record) return null;

  const path = typeof record.path === 'string' ? record.path : '';
  const category = typeof record.category === 'string' ? record.category : '';
  if (!path || !category) return null;

  const sizeRaw = record.sizeBytes;
  const sizeBytes =
    typeof sizeRaw === 'number'
      ? sizeRaw
      : typeof sizeRaw === 'string'
        ? Number(sizeRaw)
        : 0;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;

  return {
    path,
    category,
    sizeBytes,
    safe: typeof record.safe === 'boolean' ? record.safe : SAFE_CLEANUP_CATEGORIES.has(category),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : undefined,
  };
}

export function buildCleanupPreview(
  snapshot: { cleanupCandidates: unknown; id: string },
  requestedCategories?: string[]
) {
  const requestedSet = requestedCategories && requestedCategories.length > 0
    ? new Set(requestedCategories)
    : null;

  const allCandidates = asArray(snapshot.cleanupCandidates)
    .map(toCleanupCandidate)
    .filter((candidate): candidate is FilesystemCleanupCandidate => candidate !== null)
    .filter((candidate) => candidate.safe && SAFE_CLEANUP_CATEGORIES.has(candidate.category))
    .filter((candidate) => (requestedSet ? requestedSet.has(candidate.category) : true));

  const deduped = new Map<string, FilesystemCleanupCandidate>();
  for (const candidate of allCandidates) {
    const existing = deduped.get(candidate.path);
    if (!existing || candidate.sizeBytes > existing.sizeBytes) {
      deduped.set(candidate.path, candidate);
    }
  }

  const candidates = Array.from(deduped.values()).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const estimatedBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);

  const byCategory = new Map<string, { count: number; estimatedBytes: number }>();
  for (const candidate of candidates) {
    const current = byCategory.get(candidate.category) ?? { count: 0, estimatedBytes: 0 };
    current.count += 1;
    current.estimatedBytes += candidate.sizeBytes;
    byCategory.set(candidate.category, current);
  }

  return {
    snapshotId: snapshot.id,
    estimatedBytes,
    candidateCount: candidates.length,
    categories: Array.from(byCategory.entries()).map(([category, stats]) => ({
      category,
      count: stats.count,
      estimatedBytes: stats.estimatedBytes,
    })),
    candidates,
  };
}

export const safeCleanupCategories = Array.from(SAFE_CLEANUP_CATEGORIES);
