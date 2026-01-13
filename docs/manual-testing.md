---
summary: 'Copy/paste CLI smoke checklist for local verification.'
read_when:
  - Pre-merge validation
  - Reproducing a reported CLI bug
---

# Manual testing (CLI)

## Setup
- Ensure logged in: `bun clawdhub whoami` (or `bun clawdhub login`).
- Optional: set env
  - `CLAWDHUB_SITE=https://clawdhub.com`
  - `CLAWDHUB_REGISTRY=https://clawdhub.com`

## Smoke
- `bun clawdhub --help`
- `bun clawdhub --cli-version`
- `bun clawdhub whoami`

## Search
- `bun clawdhub search gif --limit 5`

## Install / list / update
- `mkdir -p /tmp/clawdhub-manual && cd /tmp/clawdhub-manual`
- `bunx clawdhub@beta install gifgrep --force`
- `bunx clawdhub@beta list`
- `bunx clawdhub@beta update gifgrep --force`

## Publish (changelog optional)
- `mkdir -p /tmp/clawdhub-skill-demo/SKILL && cd /tmp/clawdhub-skill-demo`
- Create files:
  - `SKILL.md`
  - `notes.md`
- Publish:
  - `bun clawdhub publish . --slug clawdhub-manual-<ts> --name "Manual <ts>" --version 1.0.0 --tags latest`
- Publish update with empty changelog:
  - `bun clawdhub publish . --slug clawdhub-manual-<ts> --name "Manual <ts>" --version 1.0.1 --tags latest`

## Delete / undelete (owner/admin)
- `bun clawdhub delete clawdhub-manual-<ts> --yes`
- Verify hidden:
- `curl -i "https://clawdhub.com/api/v1/skills/clawdhub-manual-<ts>"`
- Restore:
  - `bun clawdhub undelete clawdhub-manual-<ts> --yes`
- Cleanup:
  - `bun clawdhub delete clawdhub-manual-<ts> --yes`

## Sync
- `bun clawdhub sync --dry-run --all`

## Playwright (menu smoke)

Run against prod:

```
PLAYWRIGHT_BASE_URL=https://clawdhub.com bun run test:pw
```

Run against a local preview server:

```
bun run test:e2e:local
```
