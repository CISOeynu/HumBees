# 🐝 bumblebee, but with a fleet console

bumblebee (perplexityai/bumblebee ) is a fast, zero-dependency endpoint scanner that detects developer packages that have been hijacked, backdoored, or have known 0-day exposure. It scans npm, PyPI, Go, Homebrew, Ruby, Composer, browser extensions, MCP servers, and more.

This fork adds `bumblebee-server`: a central fleet console that collects reports from many endpoints over HTTP, stores state per host, and serves a traffic-light dashboard with full HTML reports — all as a single binary with no database required.

**Supported platforms: macOS and Linux (amd64 and arm64)**

---

## Quick start (single machine)

```sh
git clone https://github.com/CISOeynu/HumBees/bumblebee.git
cd bumblebee
make build
make run-agent    # scans this machine, prints NDJSON to stdout
```
*** OR
Download bumblebee-with-fleet-server.zip, extract it localy

---

## Fleet setup

### Step 1 — Start the server (once, on your management host)

```sh
make build
make run-server
```

Open **http://localhost:8080** in your browser. The dashboard is empty until agents report in.

The server stores state in `./fleet-data/` — no database needed. It survives restarts.

**Server flags** (passed to `./bumblebee-server`):

| Flag | Default | Purpose |
|---|---|---|
| `--addr` | `:8080` | listen address |
| `--data-dir` | `./fleet-data` | state + audit log location |
| `--report-interval` | `6h` | expected agent cadence; hosts go gray after 2× this |
| `--ingest-token-env` | — | env var holding a bearer token agents must send |

### Step 2 — Enroll any macOS or Linux machine (one line)

The server hosts its own installer. From the target machine:

```sh
curl -fsSL http://YOUR-SERVER:8080/install.sh | bash
```

That's it. The script:
1. Downloads the correct bumblebee binary from **github.com/perplexityai/bumblebee @latest** (official GitHub releases, unmodified)
2. Installs it to `~/.bumblebee/bin/`
3. Schedules a scan every 6 hours (launchd on macOS, cron on Linux)
4. Runs one scan immediately so the host appears on the dashboard

**To uninstall an agent** (run on the remote machine):

```sh
curl -fsSL http://YOUR-SERVER:8080/uninstall.sh | bash
```

---

## Makefile reference

```sh
make build            # build bumblebee + bumblebee-server into this directory
make run-server       # start fleet console on http://localhost:8080
make run-agent        # scan this machine and report to localhost:8080
make uninstall-agent  # remove launchd / cron schedule from this machine
make clean            # stop server, wipe fleet-data, remove binaries
```

> **Always use `make` or `./bumblebee` with the `./` prefix.**  
> Without it your shell may find an older system-installed binary instead of the one you just built.

---
## Coverage

| Family | Emitted `ecosystem` | Sources |
|---|---|---|
| npm | `npm` | `package-lock.json`, `npm-shrinkwrap.json`, `node_modules/.package-lock.json`, `node_modules/<pkg>/package.json` |
| pnpm | `npm` | `pnpm-lock.yaml`, `.pnpm/.../package.json` |
| Yarn | `npm` | `yarn.lock` (Classic + Berry) |
| Bun | `npm` | `bun.lock`; `bun.lockb` presence as diagnostic |
| PyPI | `pypi` | `*.dist-info/METADATA`, `INSTALLER`, `direct_url.json`, `*.egg-info/PKG-INFO` |
| Go modules | `go` | `go.sum`, `go.mod` |
| RubyGems | `rubygems` | `Gemfile.lock`, installed `*.gemspec` |
| Composer | `packagist` | `composer.lock`, `vendor/composer/installed.json` |
| MCP | `mcp` | JSON host configs: `mcp.json`, `.mcp.json`, `claude_desktop_config.json`, `mcp_config.json`, `mcp_settings.json`, `cline_mcp_settings.json`, plus `~/.gemini/settings.json` (Gemini CLI / Code Assist) and `~/.claude.json` (Claude Code user- and project-scoped `mcpServers`). Non-JSON configs (Codex `config.toml`, Continue YAML) are not parsed in v0.1. |
| Agent skills | `agent-skill` | `skills.sh` / `vercel-labs/skills` lock files: global `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`) and project-local `skills-lock.json`. Loose `SKILL.md` directories without a lock file are not enumerated. |
| Editor extensions | `editor-extension` | VS Code, Cursor, Windsurf, VSCodium manifests |
| Browser extensions | `browser-extension` | Chromium-family (`manifest.json`) and Firefox (`extensions.json`) per profile |
| Homebrew | `homebrew` | Formula `INSTALL_RECEIPT.json` files and cask `.metadata` install markers |

Per-ecosystem detail: [docs/inventory-sources.md](docs/inventory-sources.md).

## Threat INTL updaets
BubmleBee DOES NOT automatically connect to the internat and fetch updates, instead schedule this command:
Inside the bumblebee directory:

```sh
git pull origin main
```


## Dashboard

Open **http://YOUR-SERVER:8080** after at least one agent has reported.

| Tab | What it shows |
|---|---|
| **Fleet** | Live grid of all endpoints, auto-refreshes every 10 s |
| **Reports** | One row per endpoint — click ⬇ HTML Report for a full self-contained report including all scanned packages and all findings |
| **Install Agent** | Copy-paste one-liners with your server address pre-filled |

**Traffic light:**

| 🔴 Red | `critical` or `high` finding, or last scan errored |
|---|---|
| 🟡 Yellow | `low` or `medium` finding, or scan was partial |
| 🟢 Green | latest completed scan found nothing |
| ⚪ Gray | no report received in over 2× the expected interval |

---

## Scan profiles

| Profile | Scope |
|---|---|
| `baseline` | well-known package manager roots on the local machine |
| `project` | adds configured developer/project directories |
| `deep` | full home directory scan; for incident response |

---

## Exposure catalog

Point `--exposure-catalog` at a JSON file (or directory of `*.json` files):

```json
{
  "schema_version": "0.1",
  "entries": [
    {
      "id": "my-001",
      "name": "evil-pkg",
      "ecosystem": "npm",
      "normalized_name": "evil-pkg",
      "versions": ["1.0.0"],
      "severity": "critical",
      "description": "Backdoored package"
    }
  ]
}
```

Matching is exact: `ecosystem` + `normalized_name` + `version`.

---

## Coverage

npm · PyPI · Go · Homebrew · Ruby gems · Composer · browser extensions · VS Code / Cursor / Windsurf extensions · MCP servers · agent skills · Bun · pnpm · Yarn

---

## License

See [LICENSE](LICENSE). The scanner binary installed on agents is the unmodified [perplexityai/bumblebee](https://github.com/perplexityai/bumblebee) — this fork only adds the server component.
