# Fleet server (central UI)

`bumblebee-server` is a single self-contained binary (stdlib only, no
external dependencies) that gives you a central dashboard for a fleet of
`bumblebee` agents. Each agent already supports posting NDJSON to an
HTTPS endpoint (`--output=http`); this adds the receiving side: storage,
a traffic-light dashboard, and a one-line agent installer.

## 1. Run the server

**Important: always use `./` when building from a local checkout.**
Without it, `go install` only compiles the single file you name and
misses the other `.go` files in the package.

```sh
# from the repo root (bumblebee-main/)
go build -o bumblebee-server ./cmd/bumblebee-server

# or add it to your $PATH in one step:
go install ./cmd/bumblebee-server

# after the code is pushed to GitHub, the full module path also works:
# go install github.com/perplexityai/bumblebee/cmd/bumblebee-server@latest
```

Run it:

```sh
./bumblebee-server --addr :8443 --data-dir ./fleet-data --report-interval 6h
```

- Listens on **HTTPS only**. If you don't pass `--tls-cert`/`--tls-key`,
  it generates and reuses a self-signed certificate on first run
  (`fleet-data/server.crt` / `server.key` if you set those flags, or an
  in-memory one each run if you don't — pass `--tls-cert`/`--tls-key`
  pointing at a persistent path so the cert/fingerprint is stable across
  restarts).
- **No login is required to view the dashboard** at `https://localhost:8443/`,
  by design (matches "central UI without credentials but with HTTPS").
  This is meant for a trusted host/LAN. If the box is reachable from
  untrusted networks, put it behind a reverse proxy with auth, or set
  `--ingest-token-env BUMBLEBEE_INGEST_TOKEN` to at least require a
  bearer token on the `/ingest` endpoint (agents pass it via
  `--auth-token` to the install script).
- State persists to `<data-dir>/fleet_state.json` (current snapshot) and
  `<data-dir>/raw/<endpoint-id>.ndjson` (full audit trail per host), so
  there's no database to stand up.

Open `https://localhost:8443/` (accept the self-signed cert warning once)
to see the fleet grid.

## 2. Install the agent on an endpoint

The server hosts the installer itself at `/install.sh`, so enrolling a
new machine is one line:

```bash
curl -fsSL https://YOUR-SERVER:8443/install.sh | bash -s -- \
    --server YOUR-SERVER --port 8443 --interval 6
```

- **Linux** — installs a crontab entry (`0 */6 * * *`).
- **macOS** — installs a `launchd` LaunchAgent (`StartInterval`).
- **Windows** — run the same command from **Git Bash** (or WSL); it
  registers a Task Scheduler task via `schtasks`. From plain
  PowerShell/cmd.exe, first install Git for Windows (provides Git
  Bash), then:
  ```
  "C:\Program Files\Git\bin\bash.exe" -lc "curl -fsSL https://YOUR-SERVER:8443/install.sh | bash -s -- --server YOUR-SERVER --port 8443"
  ```

The script downloads the `bumblebee` release binary for the host's
OS/arch (override with `--binary-url` to point at an internal mirror
instead of GitHub Releases), schedules it to run every `--interval`
hours, and runs one scan immediately so the endpoint shows up on the
dashboard right away. It uses `--output=http --http-gzip` against
`https://YOUR-SERVER:PORT/ingest` — the exact same flags documented in
`docs/transport.md`, nothing custom.

Use `--insecure` (agent side) only while testing against a self-signed
cert across machines; it sets `--http-allow-insecure` and is otherwise
unnecessary on loopback.

## 3. Traffic-light findings

The dashboard classifies each endpoint from its most recently
**completed** scan (matching the receiver contract in
`internal/output`: a run is never promoted to "current" until its
`scan_summary` with `status=complete` arrives):

| Light  | Meaning |
|--------|---------|
| 🔴 red    | a `critical`/`high` severity finding on the latest scan, or the agent's last run reported `status=error` |
| 🟡 yellow | only `low`/`medium`/unscored findings, or the last run was `status=partial` |
| 🟢 green  | latest completed scan found nothing |
| ⚪ gray   | no report received within `2 × --report-interval` (default 13h on a 6h cadence) — likely offline or the schedule isn't running |

Click any card for the full finding list (package, ecosystem, matched
threat-intel entry, source file) for that host.
