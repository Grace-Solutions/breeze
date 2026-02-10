# Contributing to Breeze

Thanks for your interest in contributing to Breeze! This guide will help you get started.

## Reporting Bugs

Found a bug? [Open an issue](https://github.com/lanternops/breeze/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, browser, agent version)

## Suggesting Features

Have an idea? [Start a discussion](https://github.com/lanternops/breeze/discussions) and describe your use case.

## Development Setup

```bash
# Clone and install
git clone https://github.com/lanternops/breeze.git
cd breeze
pnpm install

# Configure environment
cp .env.example .env
# REQUIRED: generate real values for these:
#   JWT_SECRET: openssl rand -base64 64
#   AGENT_ENROLLMENT_SECRET: openssl rand -hex 32
#   APP_ENCRYPTION_KEY: openssl rand -hex 32

# Start infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# Set up the database
pnpm db:push
pnpm db:seed

# Start dev servers
pnpm dev
```

- **Frontend**: http://localhost:4321
- **API**: http://localhost:3001
- **Default login**: `admin@breeze.local` / `BreezeAdmin123!` (change after first login)

### Agent Development

```bash
cd agent
make run       # Dev mode with hot-reload
make build     # Build for current platform
make build-all # Cross-platform builds
```

## Code Style

- **TypeScript**: ESLint with project config. Run `pnpm lint` to check.
- **Go**: Standard `gofmt` formatting. Run `gofmt -w .` in the `agent/` directory.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests: `pnpm test` (TypeScript), `cd agent && make test` (Go)
5. Submit a PR against `main`

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `chore:` — Maintenance, dependencies
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature

## Code of Conduct

Be respectful, inclusive, and constructive. We're building something together.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
