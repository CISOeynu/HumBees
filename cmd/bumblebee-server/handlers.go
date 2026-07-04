package main

import (
	"bufio"
	"compress/gzip"
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/perplexityai/bumblebee/internal/model"
)

//go:embed web/*.html web/*.css web/*.js web/*.sh web/*.ps1
var webFS embed.FS

type Server struct {
	store       *Store
	ingestToken string
}

type genericRecord struct {
	RecordType string `json:"record_type"`
}

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()

	// API
	mux.HandleFunc("/ingest", s.handleIngest)
	mux.HandleFunc("/api/fleet", s.handleFleet)
	mux.HandleFunc("/api/endpoint/", s.handleEndpoint)
	mux.HandleFunc("/api/packages/", s.handlePackages)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	// Templated scripts — server/port injected from the request Host header
	mux.HandleFunc("/install.sh", s.handleScript("web/install.sh", "text/x-shellscript"))
	mux.HandleFunc("/uninstall.sh", s.handleScript("web/uninstall.sh", "text/x-shellscript"))
	mux.HandleFunc("/install.ps1", s.handleScript("web/install.ps1", "text/plain"))
	mux.HandleFunc("/uninstall.ps1", s.handleScript("web/uninstall.ps1", "text/plain"))

	// Static dashboard
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed web assets: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))
	return mux
}

// handleScript serves a shell or PowerShell script from the embedded filesystem,
// replacing __SERVER__ and __PORT__ with the values extracted from the Host header
// so the downloaded script works without any extra arguments.
func (s *Server) handleScript(embedPath, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := webFS.ReadFile(embedPath)
		if err != nil {
			http.Error(w, "script not found", http.StatusNotFound)
			return
		}
		host := r.Host // "hostname:port" or just "hostname"
		serverHost, serverPort := splitHostPort(host)
		script := strings.ReplaceAll(string(raw), "__SERVER__", serverHost)
		script = strings.ReplaceAll(script, "__PORT__", serverPort)
		w.Header().Set("Content-Type", contentType)
		w.Write([]byte(script))
	}
}

// splitHostPort splits host:port, defaulting port to "8080".
func splitHostPort(hostport string) (host, port string) {
	if i := strings.LastIndex(hostport, ":"); i >= 0 {
		return hostport[:i], hostport[i+1:]
	}
	return hostport, "8080"
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ingestToken != "" {
		if r.Header.Get("Authorization") != "Bearer "+s.ingestToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	body := io.Reader(r.Body)
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, "bad gzip body: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer gz.Close()
		body = gz
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var endpointID string
	count := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		lineCopy := append([]byte(nil), line...)

		var gen genericRecord
		if err := json.Unmarshal(lineCopy, &gen); err != nil {
			continue
		}

		switch gen.RecordType {
		case model.RecordTypePackage:
			var rec model.Record
			if err := json.Unmarshal(lineCopy, &rec); err == nil {
				s.store.IngestPackage(rec)
				endpointID = EndpointID(rec.Endpoint)
			}
		case model.RecordTypeFinding:
			var f model.Finding
			if err := json.Unmarshal(lineCopy, &f); err == nil {
				s.store.IngestFinding(f)
				endpointID = EndpointID(f.Endpoint)
			}
		case model.RecordTypeScanSummary:
			var sum model.ScanSummary
			if err := json.Unmarshal(lineCopy, &sum); err == nil {
				if err := s.store.IngestSummary(sum); err != nil {
					log.Printf("ingest: persist: %v", err)
				}
				endpointID = EndpointID(sum.Endpoint)
			}
		}

		if endpointID != "" {
			s.store.AppendRaw(endpointID, lineCopy)
		}
		count++
	}
	if err := scanner.Err(); err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"accepted": count})
}

func (s *Server) handleFleet(w http.ResponseWriter, r *http.Request) {
	states := s.store.Snapshot()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(states)
}

func (s *Server) handleEndpoint(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/endpoint/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	st, ok := s.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

// handlePackages reads the raw NDJSON audit log for an endpoint and returns
// all package records from its most recently completed run. This keeps the
// in-memory state lean while still serving the full package list on demand.
func (s *Server) handlePackages(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/packages/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	state, ok := s.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}

	rawPath := s.store.dataDir + "/raw/" + id + ".ndjson"
	f, err := os.Open(rawPath)
	if err != nil {
		// No raw file yet — return empty list
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}
	defer f.Close()

	type slim struct {
		RecordType string `json:"record_type"`
		RunID      string `json:"run_id"`
	}
	type pkg struct {
		Ecosystem  string `json:"ecosystem"`
		Name       string `json:"package_name"`
		Version    string `json:"version"`
		SourceFile string `json:"source_file"`
		SourceType string `json:"source_type"`
	}

	targetRun := state.LastRunID
	var pkgs []pkg

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var s slim
		if json.Unmarshal(line, &s) != nil {
			continue
		}
		if s.RecordType != model.RecordTypePackage || s.RunID != targetRun {
			continue
		}
		var p pkg
		if json.Unmarshal(line, &p) == nil {
			pkgs = append(pkgs, p)
		}
	}
	if pkgs == nil {
		pkgs = []pkg{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pkgs)
}
