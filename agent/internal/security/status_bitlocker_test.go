package security

import "testing"

func TestParseBitLockerProtectionStatus(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    bool
		wantErr bool
	}{
		{name: "numeric on", input: "1", want: true},
		{name: "numeric off", input: "0", want: false},
		{name: "text on", input: "On", want: true},
		{name: "text off", input: "Off", want: false},
		{name: "bool true", input: "true", want: true},
		{name: "bool false", input: "false", want: false},
		{name: "trimmed enabled", input: "  enabled \n", want: true},
		{name: "trimmed disabled", input: "  disabled \r\n", want: false},
		{name: "unexpected", input: "Unknown", wantErr: true},
		{name: "empty", input: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseBitLockerProtectionStatus(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("unexpected value: got %v want %v", got, tt.want)
			}
		})
	}
}
