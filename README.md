# Breeze

Breeze is a multi-platform RMM stack with agent, API, web app, and supporting tooling.

## Key Docs

- Architecture: `docs/architecture.md`
- Developer guide: `docs/DEVELOPER_GUIDE.md`
- Agent installation: `docs/AGENT_INSTALLATION.md`
- Windows installer/signing: `docs/WINDOWS_INSTALLER_SIGNING.md`
- macOS/Linux packaging/signing: `docs/MACOS_LINUX_INSTALLER_SIGNING.md`
- Signing operations (official vs fork): `docs/ARTIFACT_SIGNING_OPERATIONS.md`

## Signing Quick Start

### Official Breeze distribution

1. Use the signing-enabled release workflow at `.github/workflows/release.yml`.
2. Configure GitHub environments: `signing-production` and `signing-prerelease`.
3. Add required signing secrets in those environments:
   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SIGNING_ENDPOINT`
   - `AZURE_SIGNING_ACCOUNT_NAME`
   - `AZURE_CERT_PROFILE_PROD`
   - `AZURE_CERT_PROFILE_PRERELEASE`
4. Release from tags (`v*`); workflow signs Windows EXE/MSI and verifies signatures.

### Independent self-host / fork distribution

1. Use your own signing identities and accounts (do not reuse official Breeze credentials).
2. Configure your own CI environments/secrets and cert profile names.
3. Change publisher/branding identifiers before distribution so trust identity matches your org.
4. Validate signatures on clean VMs before publishing artifacts.

For full operational guidance and controls, see `docs/ARTIFACT_SIGNING_OPERATIONS.md`.
