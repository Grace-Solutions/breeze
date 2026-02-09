package logging

import (
	"bytes"
	"strings"
	"testing"
)

func TestPreInitLoggerUsesConfiguredHandler(t *testing.T) {
	logger := L("websocket")

	var buf bytes.Buffer
	Init("text", "info", &buf)

	logger.Info("connected", "server", "http://localhost:3001")

	out := buf.String()
	if strings.Contains(out, `msg="INFO connected`) {
		t.Fatalf("unexpected nested severity prefix in message: %s", out)
	}
	if !strings.Contains(out, "msg=connected") {
		t.Fatalf("expected plain connected message, got: %s", out)
	}
	if !strings.Contains(out, "component=websocket") {
		t.Fatalf("expected component field, got: %s", out)
	}
	if !strings.Contains(out, "server=http://localhost:3001") {
		t.Fatalf("expected server field, got: %s", out)
	}
}

func TestPreInitLoggerRespectsConfiguredLevel(t *testing.T) {
	logger := L("websocket")

	var buf bytes.Buffer
	Init("text", "warn", &buf)

	logger.Info("hidden")
	logger.Warn("shown")

	out := buf.String()
	if strings.Contains(out, "hidden") {
		t.Fatalf("info log should be filtered at warn level: %s", out)
	}
	if !strings.Contains(out, "shown") {
		t.Fatalf("warn log should be emitted: %s", out)
	}
}
