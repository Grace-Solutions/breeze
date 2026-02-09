//go:build !windows

package tools

import (
	"os"
	"os/user"
	"strconv"
	"syscall"
)

func getFileOwner(info os.FileInfo) string {
	if info == nil || info.Sys() == nil {
		return ""
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}

	uid := strconv.FormatUint(uint64(stat.Uid), 10)
	usr, err := user.LookupId(uid)
	if err != nil {
		return uid
	}
	return usr.Username
}
