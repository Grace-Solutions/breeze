package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	defaultFSMaxDepth      = 6
	defaultFSTopFiles      = 50
	defaultFSTopDirs       = 30
	defaultFSMaxEntries    = 200000
	defaultFSTimeoutSecs   = 20
	maxFSErrors            = 200
	maxFSCleanupCandidates = 1000
	unrotatedLogMinBytes   = 100 * 1024 * 1024
)

type scanDirFrame struct {
	path  string
	depth int
}

type fsDirAggregate struct {
	Path      string
	Parent    string
	Depth     int
	SizeBytes int64
	FileCount int64
}

type duplicateGroup struct {
	Key       string
	SizeBytes int64
	Paths     []string
}

// AnalyzeFilesystem runs deep filesystem analysis for BE-1.
func AnalyzeFilesystem(payload map[string]any) CommandResult {
	start := time.Now()

	rootPath, errResult := RequirePayloadString(payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	maxDepth := clampInt(GetPayloadInt(payload, "maxDepth", defaultFSMaxDepth), 1, 12)
	topFilesLimit := clampInt(GetPayloadInt(payload, "topFiles", defaultFSTopFiles), 1, 500)
	topDirsLimit := clampInt(GetPayloadInt(payload, "topDirs", defaultFSTopDirs), 1, 200)
	maxEntries := clampInt(GetPayloadInt(payload, "maxEntries", defaultFSMaxEntries), 1000, 1000000)
	timeoutSecs := clampInt(GetPayloadInt(payload, "timeoutSeconds", defaultFSTimeoutSecs), 5, 120)
	followSymlinks := GetPayloadBool(payload, "followSymlinks", false)

	cleanRoot := filepath.Clean(rootPath)
	rootInfo, err := os.Stat(cleanRoot)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to stat path: %w", err), time.Since(start).Milliseconds())
	}
	if !rootInfo.IsDir() {
		return NewErrorResult(fmt.Errorf("path is not a directory: %s", cleanRoot), time.Since(start).Milliseconds())
	}

	now := time.Now()
	deadline := now.Add(time.Duration(timeoutSecs) * time.Second)
	oldDownloadsThreshold := now.Add(-30 * 24 * time.Hour)

	dirStats := map[string]*fsDirAggregate{
		cleanRoot: {
			Path:   cleanRoot,
			Parent: "",
			Depth:  0,
		},
	}
	dirStack := []scanDirFrame{{path: cleanRoot, depth: 0}}
	visitedDirs := map[string]struct{}{cleanRoot: {}}

	tempBytes := make(map[string]int64)
	duplicateByKey := make(map[string]*duplicateGroup)
	cleanupByPath := make(map[string]FilesystemCleanupCandidate)

	topLargestFiles := make([]FilesystemLargestFile, 0, topFilesLimit)
	topLargestDirs := make([]FilesystemLargestDirectory, 0, topDirsLimit)
	oldDownloads := make([]FilesystemOldDownload, 0, 128)
	unrotatedLogs := make([]FilesystemUnrotatedLog, 0, 128)
	trashUsage := make([]FilesystemTrashUsage, 0, 4)
	scanErrors := make([]FilesystemScanError, 0, 32)

	var filesScanned int64
	var dirsScanned int64
	var bytesScanned int64
	var permissionDeniedCount int64
	var maxDepthReached int
	entriesSeen := 0
	partial := false
	reason := ""

outer:
	for len(dirStack) > 0 {
		if time.Now().After(deadline) {
			partial = true
			reason = "timeout reached"
			break
		}

		// DFS-style pop keeps memory bounded for deep trees.
		idx := len(dirStack) - 1
		frame := dirStack[idx]
		dirStack = dirStack[:idx]

		entries, readErr := os.ReadDir(frame.path)
		if readErr != nil {
			appendScanError(&scanErrors, frame.path, readErr, &permissionDeniedCount)
			continue
		}
		dirsScanned++
		if frame.depth > maxDepthReached {
			maxDepthReached = frame.depth
		}

		for _, entry := range entries {
			if time.Now().After(deadline) {
				partial = true
				reason = "timeout reached"
				break outer
			}
			entriesSeen++
			if entriesSeen > maxEntries {
				partial = true
				reason = "max entries reached"
				break outer
			}

			entryPath := filepath.Join(frame.path, entry.Name())
			info, infoErr := entry.Info()
			if infoErr != nil {
				appendScanError(&scanErrors, entryPath, infoErr, &permissionDeniedCount)
				continue
			}

			mode := info.Mode()
			if mode&os.ModeSymlink != 0 && !followSymlinks {
				continue
			}

			isDir := info.IsDir()
			if mode&os.ModeSymlink != 0 && followSymlinks {
				targetInfo, statErr := os.Stat(entryPath)
				if statErr != nil {
					appendScanError(&scanErrors, entryPath, statErr, &permissionDeniedCount)
					continue
				}
				info = targetInfo
				isDir = targetInfo.IsDir()
			}

			if isDir {
				childDepth := frame.depth + 1
				normalizedPath := entryPath
				if _, ok := dirStats[normalizedPath]; !ok {
					dirStats[normalizedPath] = &fsDirAggregate{
						Path:   normalizedPath,
						Parent: frame.path,
						Depth:  childDepth,
					}
				}
				if childDepth <= maxDepth {
					if _, seen := visitedDirs[normalizedPath]; !seen {
						visitedDirs[normalizedPath] = struct{}{}
						dirStack = append(dirStack, scanDirFrame{path: normalizedPath, depth: childDepth})
					}
				}
				continue
			}

			fileSize := info.Size()
			if fileSize < 0 {
				fileSize = 0
			}
			filesScanned++
			bytesScanned += fileSize

			if parentAgg, ok := dirStats[frame.path]; ok {
				parentAgg.SizeBytes += fileSize
				parentAgg.FileCount++
			}

			modifiedAt := info.ModTime().UTC().Format(time.RFC3339)
			addTopLargestFile(&topLargestFiles, FilesystemLargestFile{
				Path:       entryPath,
				SizeBytes:  fileSize,
				ModifiedAt: modifiedAt,
				Owner:      getFileOwner(info),
			}, topFilesLimit)

			if category := classifyCleanupCategory(entryPath); category != "" {
				tempBytes[category] += fileSize
				addCleanupCandidate(cleanupByPath, FilesystemCleanupCandidate{
					Path:       entryPath,
					Category:   category,
					SizeBytes:  fileSize,
					Safe:       true,
					Reason:     "temporary/cache file",
					ModifiedAt: modifiedAt,
				}, maxFSCleanupCandidates)
			}

			if isOldDownload(entryPath, info.ModTime(), oldDownloadsThreshold) {
				oldDownloads = append(oldDownloads, FilesystemOldDownload{
					Path:       entryPath,
					SizeBytes:  fileSize,
					ModifiedAt: modifiedAt,
					Owner:      getFileOwner(info),
				})
			}

			if isUnrotatedLog(entryPath, fileSize) {
				unrotatedLogs = append(unrotatedLogs, FilesystemUnrotatedLog{
					Path:       entryPath,
					SizeBytes:  fileSize,
					ModifiedAt: modifiedAt,
				})
			}

			addDuplicateCandidate(duplicateByKey, entryPath, fileSize)
		}
	}

	// Aggregate child directory sizes into parents.
	orderedDirs := make([]*fsDirAggregate, 0, len(dirStats))
	for _, agg := range dirStats {
		orderedDirs = append(orderedDirs, agg)
	}
	sort.Slice(orderedDirs, func(i, j int) bool {
		return orderedDirs[i].Depth > orderedDirs[j].Depth
	})
	for _, agg := range orderedDirs {
		if agg.Parent == "" {
			continue
		}
		parent, ok := dirStats[agg.Parent]
		if !ok {
			continue
		}
		parent.SizeBytes += agg.SizeBytes
		parent.FileCount += agg.FileCount
	}

	for _, agg := range dirStats {
		addTopLargestDir(&topLargestDirs, FilesystemLargestDirectory{
			Path:      agg.Path,
			SizeBytes: agg.SizeBytes,
			FileCount: agg.FileCount,
		}, topDirsLimit)
	}
	sort.Slice(oldDownloads, func(i, j int) bool { return oldDownloads[i].SizeBytes > oldDownloads[j].SizeBytes })
	if len(oldDownloads) > 200 {
		oldDownloads = oldDownloads[:200]
	}
	sort.Slice(unrotatedLogs, func(i, j int) bool { return unrotatedLogs[i].SizeBytes > unrotatedLogs[j].SizeBytes })
	if len(unrotatedLogs) > 200 {
		unrotatedLogs = unrotatedLogs[:200]
	}

	// Trash usage is calculated separately from known locations.
	for _, trashPath := range getTrashPaths() {
		size, _, timedOut, trashErr := estimateDirectorySize(trashPath, deadline, maxEntries/2)
		if trashErr != nil {
			if !os.IsNotExist(trashErr) {
				appendScanError(&scanErrors, trashPath, trashErr, &permissionDeniedCount)
			}
			continue
		}
		if timedOut {
			partial = true
			if reason == "" {
				reason = "timeout reached while scanning trash"
			}
		}
		if size <= 0 {
			continue
		}
		trashUsage = append(trashUsage, FilesystemTrashUsage{
			Path:      trashPath,
			SizeBytes: size,
		})
		addCleanupCandidate(cleanupByPath, FilesystemCleanupCandidate{
			Path:      trashPath,
			Category:  "trash",
			SizeBytes: size,
			Safe:      true,
			Reason:    "trash/recycle bin cleanup",
		}, maxFSCleanupCandidates)
	}

	tempAccumulation := make([]FilesystemAccumulation, 0, len(tempBytes))
	for category, bytes := range tempBytes {
		tempAccumulation = append(tempAccumulation, FilesystemAccumulation{
			Category: category,
			Bytes:    bytes,
		})
	}
	sort.Slice(tempAccumulation, func(i, j int) bool { return tempAccumulation[i].Bytes > tempAccumulation[j].Bytes })
	sort.Slice(trashUsage, func(i, j int) bool { return trashUsage[i].SizeBytes > trashUsage[j].SizeBytes })

	duplicateCandidates := buildDuplicateCandidateList(duplicateByKey, 200)
	cleanupCandidates := mapCleanupCandidates(cleanupByPath, maxFSCleanupCandidates)

	completedAt := time.Now()
	response := FilesystemAnalysisResponse{
		Path:        cleanRoot,
		StartedAt:   start.UTC().Format(time.RFC3339),
		CompletedAt: completedAt.UTC().Format(time.RFC3339),
		DurationMs:  completedAt.Sub(start).Milliseconds(),
		Partial:     partial,
		Reason:      reason,
		Summary: FilesystemAnalysisSummary{
			FilesScanned:          filesScanned,
			DirsScanned:           dirsScanned,
			BytesScanned:          bytesScanned,
			MaxDepthReached:       maxDepthReached,
			PermissionDeniedCount: permissionDeniedCount,
		},
		TopLargestFiles:     topLargestFiles,
		TopLargestDirs:      topLargestDirs,
		TempAccumulation:    tempAccumulation,
		OldDownloads:        oldDownloads,
		UnrotatedLogs:       unrotatedLogs,
		TrashUsage:          trashUsage,
		DuplicateCandidates: duplicateCandidates,
		CleanupCandidates:   cleanupCandidates,
		Errors:              scanErrors,
	}

	return NewSuccessResult(response, response.DurationMs)
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func addTopLargestFile(top *[]FilesystemLargestFile, file FilesystemLargestFile, limit int) {
	if limit <= 0 {
		return
	}
	if len(*top) < limit {
		*top = append(*top, file)
		sort.Slice(*top, func(i, j int) bool { return (*top)[i].SizeBytes > (*top)[j].SizeBytes })
		return
	}
	minIdx := len(*top) - 1
	if file.SizeBytes <= (*top)[minIdx].SizeBytes {
		return
	}
	(*top)[minIdx] = file
	sort.Slice(*top, func(i, j int) bool { return (*top)[i].SizeBytes > (*top)[j].SizeBytes })
}

func addTopLargestDir(top *[]FilesystemLargestDirectory, dir FilesystemLargestDirectory, limit int) {
	if limit <= 0 {
		return
	}
	if len(*top) < limit {
		*top = append(*top, dir)
		sort.Slice(*top, func(i, j int) bool { return (*top)[i].SizeBytes > (*top)[j].SizeBytes })
		return
	}
	minIdx := len(*top) - 1
	if dir.SizeBytes <= (*top)[minIdx].SizeBytes {
		return
	}
	(*top)[minIdx] = dir
	sort.Slice(*top, func(i, j int) bool { return (*top)[i].SizeBytes > (*top)[j].SizeBytes })
}

func appendScanError(errors *[]FilesystemScanError, path string, err error, permissionDeniedCount *int64) {
	if err == nil {
		return
	}
	if os.IsPermission(err) {
		(*permissionDeniedCount)++
	}
	if len(*errors) >= maxFSErrors {
		return
	}
	*errors = append(*errors, FilesystemScanError{
		Path:  path,
		Error: err.Error(),
	})
}

func normalizePathForChecks(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	return strings.ToLower(path)
}

func classifyCleanupCategory(path string) string {
	n := normalizePathForChecks(path)
	switch {
	case strings.Contains(n, "/tmp/"),
		strings.HasSuffix(n, "/tmp"),
		strings.Contains(n, "/windows/temp/"),
		strings.Contains(n, "/appdata/local/temp/"),
		strings.Contains(n, "/var/tmp/"):
		return "temp_files"
	case strings.Contains(n, "/google/chrome/user data/"),
		strings.Contains(n, "/mozilla/firefox/"),
		strings.Contains(n, "/library/caches/com.apple.safari/"),
		strings.Contains(n, "/library/caches/"),
		strings.Contains(n, "/.cache/"),
		strings.Contains(n, "/edge/user data/"):
		return "browser_cache"
	case strings.Contains(n, "/var/cache/apt/"),
		strings.Contains(n, "/var/cache/dnf/"),
		strings.Contains(n, "/var/cache/yum/"),
		strings.Contains(n, "/library/caches/homebrew/"),
		strings.Contains(n, "/appdata/local/packages/"):
		return "package_cache"
	default:
		return ""
	}
}

func isOldDownload(path string, modifiedAt time.Time, threshold time.Time) bool {
	if modifiedAt.After(threshold) {
		return false
	}
	n := normalizePathForChecks(path)
	return strings.Contains(n, "/downloads/") || strings.HasSuffix(n, "/downloads")
}

func isUnrotatedLog(path string, sizeBytes int64) bool {
	if sizeBytes < unrotatedLogMinBytes {
		return false
	}
	n := normalizePathForChecks(path)
	return strings.HasSuffix(n, ".log")
}

func normalizeDuplicateName(name string) string {
	n := strings.TrimSpace(strings.ToLower(name))
	n = strings.ReplaceAll(n, " (copy)", "")
	n = strings.ReplaceAll(n, " - copy", "")
	return n
}

func addDuplicateCandidate(groups map[string]*duplicateGroup, path string, sizeBytes int64) {
	base := normalizeDuplicateName(filepath.Base(path))
	if base == "" || sizeBytes <= 0 {
		return
	}
	key := fmt.Sprintf("%d|%s", sizeBytes, base)
	group, ok := groups[key]
	if !ok {
		groups[key] = &duplicateGroup{
			Key:       key,
			SizeBytes: sizeBytes,
			Paths:     []string{path},
		}
		return
	}
	if len(group.Paths) < 50 {
		group.Paths = append(group.Paths, path)
	}
}

func buildDuplicateCandidateList(groups map[string]*duplicateGroup, limit int) []FilesystemDuplicateCandidate {
	candidates := make([]FilesystemDuplicateCandidate, 0, len(groups))
	for _, group := range groups {
		if len(group.Paths) < 2 {
			continue
		}
		candidates = append(candidates, FilesystemDuplicateCandidate{
			Key:       group.Key,
			SizeBytes: group.SizeBytes,
			Count:     len(group.Paths),
			Paths:     group.Paths,
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].SizeBytes == candidates[j].SizeBytes {
			return candidates[i].Count > candidates[j].Count
		}
		return candidates[i].SizeBytes > candidates[j].SizeBytes
	})
	if len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func addCleanupCandidate(existing map[string]FilesystemCleanupCandidate, candidate FilesystemCleanupCandidate, maxItems int) {
	if len(existing) >= maxItems {
		return
	}
	if candidate.Path == "" || candidate.SizeBytes <= 0 {
		return
	}
	prev, ok := existing[candidate.Path]
	if !ok || candidate.SizeBytes > prev.SizeBytes {
		existing[candidate.Path] = candidate
	}
}

func mapCleanupCandidates(existing map[string]FilesystemCleanupCandidate, limit int) []FilesystemCleanupCandidate {
	candidates := make([]FilesystemCleanupCandidate, 0, len(existing))
	for _, candidate := range existing {
		candidates = append(candidates, candidate)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].SizeBytes > candidates[j].SizeBytes })
	if len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func getTrashPaths() []string {
	paths := make([]string, 0, 4)
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		paths = append(paths, `C:\$Recycle.Bin`)
	case "darwin":
		if home != "" {
			paths = append(paths, filepath.Join(home, ".Trash"))
		}
	case "linux":
		if home != "" {
			paths = append(paths, filepath.Join(home, ".local", "share", "Trash"))
		}
	}
	return paths
}

func estimateDirectorySize(root string, deadline time.Time, maxEntries int) (sizeBytes int64, filesScanned int64, timedOut bool, err error) {
	info, statErr := os.Stat(root)
	if statErr != nil {
		return 0, 0, false, statErr
	}
	if !info.IsDir() {
		return info.Size(), 1, false, nil
	}

	stack := []string{root}
	entries := 0

	for len(stack) > 0 {
		if time.Now().After(deadline) {
			return sizeBytes, filesScanned, true, nil
		}
		idx := len(stack) - 1
		current := stack[idx]
		stack = stack[:idx]

		children, readErr := os.ReadDir(current)
		if readErr != nil {
			if os.IsPermission(readErr) {
				continue
			}
			return sizeBytes, filesScanned, false, readErr
		}
		for _, child := range children {
			entries++
			if entries > maxEntries {
				return sizeBytes, filesScanned, true, nil
			}
			if time.Now().After(deadline) {
				return sizeBytes, filesScanned, true, nil
			}
			childPath := filepath.Join(current, child.Name())
			childInfo, infoErr := child.Info()
			if infoErr != nil {
				continue
			}
			if childInfo.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if childInfo.IsDir() {
				stack = append(stack, childPath)
				continue
			}
			size := childInfo.Size()
			if size < 0 {
				size = 0
			}
			sizeBytes += size
			filesScanned++
		}
	}

	return sizeBytes, filesScanned, false, nil
}
