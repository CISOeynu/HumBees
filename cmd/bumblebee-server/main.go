// Command bumblebee-server is the central fleet console for bumblebee.
//
// It listens on plain HTTP (no TLS, no credentials required) and exposes:
//
//	POST /ingest        — NDJSON record sink, wire-compatible with
//	                      internal/output.HTTPSink (gzip optional)
//	GET  /api/fleet     — JSON list of every endpoint's current state
//	GET  /api/endpoint/ — JSON detail for one endpoint
//	GET  /              — dashboard UI (fleet view + reports + install guide)
//
// State persists to disk as a JSON snapshot plus per-endpoint raw NDJSON
// audit logs — no database required.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	var (
		addr           = flag.String("addr", ":8080", "address to listen on, e.g. :8080 or 0.0.0.0:8080")
		dataDir        = flag.String("data-dir", "./bumblebee-server-data", "directory for fleet state + raw audit log")
		reportEvery    = flag.Duration("report-interval", 6*time.Hour, "expected agent reporting cadence; endpoints go gray after 2× this")
		ingestTokenEnv = flag.String("ingest-token-env", "", "env var holding an optional bearer token agents must send to /ingest (default: no auth)")
	)
	flag.Parse()

	store, err := NewStore(*dataDir, *reportEvery*2+30*time.Minute)
	if err != nil {
		log.Fatalf("init store: %v", err)
	}

	ingestToken := ""
	if *ingestTokenEnv != "" {
		ingestToken = os.Getenv(*ingestTokenEnv)
		if ingestToken == "" {
			log.Fatalf("--ingest-token-env=%s set but the env var is empty", *ingestTokenEnv)
		}
	}

	srv := &Server{store: store, ingestToken: ingestToken}

	httpServer := &http.Server{
		Addr:    *addr,
		Handler: srv.routes(),
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}

	go func() {
		log.Printf("bumblebee-server listening on http://%s  (data: %s, agent cadence: %s)", *addr, *dataDir, *reportEvery)
		if ingestToken == "" {
			log.Printf("note: /ingest has no auth token — fine for a trusted LAN. Set --ingest-token-env to require one.")
		}
		if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	fmt.Println()
	log.Println("shutting down...")
	_ = httpServer.Shutdown(ctx)
}
