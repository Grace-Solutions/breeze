//go:build windows

package tools

import "os"

func getFileOwner(_ os.FileInfo) string {
	// Owner lookup on Windows requires ACL interrogation and can be expensive.
	// We keep this best-effort field empty in the initial BE-1 implementation.
	return ""
}
