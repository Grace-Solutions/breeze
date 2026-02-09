import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db';
import { deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { CommandTypes, executeCommand } from '../../services/commandQueue';
import {
  buildCleanupPreview,
  getLatestFilesystemSnapshot,
  parseFilesystemAnalysisStdout,
  saveFilesystemSnapshot,
  safeCleanupCategories,
} from '../../services/filesystemAnalysis';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgCheck } from './helpers';

export const filesystemRoutes = new Hono();

filesystemRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().uuid(),
});

const scanFilesystemBodySchema = z.object({
  path: z.string().min(1).max(2048),
  maxDepth: z.number().int().min(1).max(12).optional(),
  topFiles: z.number().int().min(1).max(500).optional(),
  topDirs: z.number().int().min(1).max(200).optional(),
  maxEntries: z.number().int().min(1000).max(1_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(120).optional(),
  followSymlinks: z.boolean().optional(),
});

const cleanupPreviewBodySchema = z.object({
  categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
});

const cleanupExecuteBodySchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
});

filesystemRoutes.get(
  '/:id/filesystem',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem analysis available yet' }, 404);
    }

    return c.json({
      data: {
        id: snapshot.id,
        deviceId: snapshot.deviceId,
        capturedAt: snapshot.capturedAt,
        trigger: snapshot.trigger,
        partial: snapshot.partial,
        summary: snapshot.summary,
        topLargestFiles: snapshot.largestFiles,
        topLargestDirectories: snapshot.largestDirs,
        tempAccumulation: snapshot.tempAccumulation,
        oldDownloads: snapshot.oldDownloads,
        unrotatedLogs: snapshot.unrotatedLogs,
        trashUsage: snapshot.trashUsage,
        duplicateCandidates: snapshot.duplicateCandidates,
        cleanupCandidates: snapshot.cleanupCandidates,
        errors: snapshot.errors,
      },
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanFilesystemBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const timeoutMs = Math.max(15_000, ((payload.timeoutSeconds ?? 20) + 10) * 1000);
    const result = await executeCommand(
      deviceId,
      CommandTypes.FILESYSTEM_ANALYSIS,
      payload,
      { userId: auth.user.id, timeoutMs }
    );

    if (result.status !== 'completed') {
      const error = result.error || 'Filesystem analysis failed';
      return c.json({ error }, 502);
    }

    const parsed = parseFilesystemAnalysisStdout(result.stdout ?? '{}');
    const snapshot = await saveFilesystemSnapshot(deviceId, 'on_demand', parsed);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.scan',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        snapshotId: snapshot?.id ?? null,
        path: payload.path,
        maxDepth: payload.maxDepth ?? null,
      },
      result: snapshot ? 'success' : 'failure',
    });

    if (!snapshot) {
      return c.json({ error: 'Failed to persist filesystem snapshot' }, 500);
    }

    return c.json({
      success: true,
      data: {
        id: snapshot.id,
        capturedAt: snapshot.capturedAt,
        partial: snapshot.partial,
        summary: snapshot.summary,
        topLargestFiles: snapshot.largestFiles,
        topLargestDirectories: snapshot.largestDirs,
        tempAccumulation: snapshot.tempAccumulation,
        oldDownloads: snapshot.oldDownloads,
        unrotatedLogs: snapshot.unrotatedLogs,
        trashUsage: snapshot.trashUsage,
        duplicateCandidates: snapshot.duplicateCandidates,
        cleanupCandidates: snapshot.cleanupCandidates,
        errors: snapshot.errors,
      },
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-preview',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupPreviewBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { categories } = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem snapshot available. Run a scan first.' }, 404);
    }

    const preview = buildCleanupPreview(snapshot, categories);
    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        requestedBy: auth.user.id,
        plan: {
          snapshotId: snapshot.id,
          categories: categories ?? safeCleanupCategories,
          preview,
        },
        status: 'previewed',
      })
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.preview',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        snapshotId: snapshot.id,
        categories: categories ?? safeCleanupCategories,
        estimatedBytes: preview.estimatedBytes,
        candidateCount: preview.candidateCount,
      },
    });

    return c.json({
      success: true,
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        ...preview,
      },
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-execute',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupExecuteBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { paths } = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem snapshot available. Run a scan first.' }, 404);
    }

    const preview = buildCleanupPreview(snapshot);
    const byPath = new Map(preview.candidates.map((candidate) => [candidate.path, candidate]));
    const requested = Array.from(new Set(paths));
    const selected = requested
      .map((path) => byPath.get(path))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);

    if (selected.length === 0) {
      return c.json({ error: 'No valid cleanup paths selected from latest previewable candidates' }, 400);
    }

    const actions: Array<{ path: string; category: string; sizeBytes: number; status: string; error?: string }> = [];
    let bytesReclaimed = 0;

    for (const candidate of selected) {
      const commandResult = await executeCommand(
        deviceId,
        CommandTypes.FILE_DELETE,
        { path: candidate.path, recursive: true },
        { userId: auth.user.id, timeoutMs: 30_000 }
      );

      if (commandResult.status === 'completed') {
        bytesReclaimed += candidate.sizeBytes;
      }

      actions.push({
        path: candidate.path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: commandResult.status,
        error: commandResult.error ?? undefined,
      });
    }

    const failedCount = actions.filter((action) => action.status !== 'completed').length;
    const runStatus = failedCount === actions.length ? 'failed' : 'executed';

    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: snapshot.id,
          requestedPaths: requested,
          selectedPaths: selected.map((candidate) => candidate.path),
        },
        executedActions: actions,
        bytesReclaimed,
        status: runStatus,
        error: failedCount > 0 ? `${failedCount} cleanup action(s) failed` : null,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.execute',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        cleanupRunId: cleanupRun?.id ?? null,
        requestedCount: requested.length,
        selectedCount: selected.length,
        failedCount,
        bytesReclaimed,
      },
      result: runStatus === 'executed' ? 'success' : 'failure',
    });

    return c.json({
      success: runStatus === 'executed',
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        status: runStatus,
        bytesReclaimed,
        selectedCount: selected.length,
        failedCount,
        actions,
      },
    }, runStatus === 'executed' ? 200 : 500);
  }
);
