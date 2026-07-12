SHELL    := /bin/bash
ROOT     := $(shell pwd)
SERVER   := $(ROOT)/bumblebee-server
AGENT    := $(ROOT)/bumblebee
DATA_DIR := $(ROOT)/fleet-data

.PHONY: build build-server build-agent run-server run-agent uninstall-agent clean

## Build both binaries (always builds from THIS source tree)
build: build-server build-agent
	@echo ""
	@echo "✅  Built:"
	@echo "    server : $(SERVER)"
	@echo "    agent  : $(AGENT)"
	@echo ""
	@echo "  make run-server       — start fleet console on http://localhost:8080"
	@echo "  make run-agent        — scan this machine and report to localhost"
	@echo "  make uninstall-agent  — remove launchd/cron schedule"
	@echo "  make clean            — kill server, wipe data, remove binaries"

build-server:
	@echo "→ building bumblebee-server..."
	go build -v -o $(SERVER) ./cmd/bumblebee-server

build-agent:
	@echo "→ building bumblebee (agent)..."
	go build -v -o $(AGENT) ./cmd/bumblebee
	@$(AGENT) scan --help 2>&1 | grep -q "http-tls-skip-verify" \
		&& echo "  ✓ TLS skip-verify flag present" \
		|| echo "  ✓ agent built (HTTP mode — no TLS needed)"

## Start the fleet server on http://localhost:8080
run-server: $(SERVER)
	$(SERVER) --addr :8080 --data-dir $(DATA_DIR) --report-interval 48h

## Scan this machine and report to the local server
run-agent: $(AGENT)
	$(AGENT) scan \
		--profile baseline \
		--output http \
		--http-url http://localhost:8080/ingest \
		--http-gzip

# Build server binary if it doesn't exist
$(SERVER):
	@echo "→ bumblebee-server not found — building first..."
	go build -o $(SERVER) ./cmd/bumblebee-server

# Build agent binary if it doesn't exist
$(AGENT):
	@echo "→ bumblebee not found — building first..."
	go build -o $(AGENT) ./cmd/bumblebee

## Remove the scheduled agent (launchd / cron) from THIS machine
uninstall-agent:
	@echo "→ removing scheduled agent..."
	@if [ -f "$(HOME)/Library/LaunchAgents/com.bumblebee.scan.plist" ]; then \
		launchctl unload "$(HOME)/Library/LaunchAgents/com.bumblebee.scan.plist" 2>/dev/null || true; \
		rm -f "$(HOME)/Library/LaunchAgents/com.bumblebee.scan.plist"; \
		echo "  removed launchd agent"; \
	fi
	@if crontab -l 2>/dev/null | grep -q bumblebee; then \
		crontab -l 2>/dev/null | grep -v bumblebee | crontab -; \
		echo "  removed cron entry"; \
	fi
	@echo "  done"

## Kill server, wipe fleet data, remove binaries — full reset
clean: uninstall-agent
	@pkill -f bumblebee-server 2>/dev/null && echo "→ stopped bumblebee-server" || true
	@rm -rf $(DATA_DIR) && echo "→ wiped $(DATA_DIR)"
	@rm -f $(SERVER) $(AGENT) && echo "→ removed binaries"
	@echo "✅  Clean slate. Run 'make build' to start fresh."
