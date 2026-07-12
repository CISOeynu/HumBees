// Package main (bumblebee-server) — fleet state store.
//
// The store keeps one current-state record per endpoint, derived from
// the most recently *completed* scan run reported by that endpoint.
// Records belonging to an in-flight run are buffered in memory keyed by
// run_id until a scan_summary with status=complete (or error/partial)
// arrives, at which point the endpoint's state is replaced atomically.
// This mirrors the receiver contract documented in the scanner's
// internal/output package: never promote partial data to "current".
//
// State is persisted to disk as a single JSON snapshot after every
// commit so the dashboard survives server restarts without requiring
// a database. Raw NDJSON is additionally appended per-endpoint under
// <data-dir>/raw/ for audit / replay.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/perplexityai/bumblebee/internal/model"
)

// Light is the traffic-light classification shown in the dashboard.
type Light string

const (
	LightGreen  Light = "green"
	LightYellow Light = "yellow"
	LightRed    Light = "red"
	LightGray   Light = "gray" // no report received recently
)

// EndpointState is the current-state snapshot for one fleet member.
type EndpointState struct {
	ID             string          `json:"id"`
	Endpoint       model.Endpoint  `json:"endpoint"`
	Profile        string          `json:"profile"`
	AgentVersion   string          `json:"agent_version"`
	FirstSeen      time.Time       `json:"first_seen"`
	LastSeen       time.Time       `json:"last_seen"`
	LastRunID      string          `json:"last_run_id"`
	LastScanTime   time.Time       `json:"last_scan_time"`
	LastStatus     string          `json:"last_status"`
	LastError      string          `json:"last_error,omitempty"`
	PackageCount   int             `json:"package_count"`
	SeverityCounts map[string]int  `json:"severity_counts"`
	Findings       []model.Finding `json:"findings"`
	Light          Light           `json:"light"`
}

// runBuffer accumulates records belonging to one in-flight run until its
// scan_summary arrives.
type runBuffer struct {
	endpointID   string
	endpoint     model.Endpoint
	profile      string
	packageCount int
	findings     []model.Finding
	started      time.Time
}

// Store is the in-memory + on-disk fleet store. Safe for concurrent use.
type Store struct {
	mu         sync.Mutex
	dataDir    string
	states     map[string]*EndpointState // endpoint id -> state
	buffers    map[string]*runBuffer     // endpoint id + "|" + run id -> buffer
	staleAfter time.Duration
}

func NewStore(dataDir string, staleAfter time.Duration) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "raw"), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{
		dataDir:    dataDir,
		states:     map[string]*EndpointState{},
		buffers:    map[string]*runBuffer{},
		staleAfter: staleAfter,
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	// Load persisted stale-after if the operator updated it via the UI
	if saved := s.loadStaleAfter(); saved > 0 {
		s.staleAfter = saved
	}
	return s, nil
}

// GetStaleAfter returns the current stale-after threshold.
func (s *Store) GetStaleAfter() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.staleAfter
}

// UpdateStaleAfter updates the stale-after threshold and persists it.
func (s *Store) UpdateStaleAfter(d time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.staleAfter = d
	return os.WriteFile(
		filepath.Join(s.dataDir, "stale_after.txt"),
		[]byte(d.String()),
		0o644,
	)
}

func (s *Store) loadStaleAfter() time.Duration {
	b, err := os.ReadFile(filepath.Join(s.dataDir, "stale_after.txt"))
	if err != nil {
		return 0
	}
	d, err := time.ParseDuration(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return d
}

// Delete removes an endpoint from the fleet and its raw audit log.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.states, id)
	// clean up any in-flight buffers for this endpoint
	for key := range s.buffers {
		if strings.HasPrefix(key, id+"|") {
			delete(s.buffers, key)
		}
	}
	// remove raw audit log (best-effort)
	_ = os.Remove(filepath.Join(s.dataDir, "raw", id+".ndjson"))
	return s.persistLocked()
}

func (s *Store) snapshotPath() string {
	return filepath.Join(s.dataDir, "fleet_state.json")
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.snapshotPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read snapshot: %w", err)
	}
	var states map[string]*EndpointState
	if err := json.Unmarshal(b, &states); err != nil {
		return fmt.Errorf("parse snapshot: %w", err)
	}
	s.states = states
	return nil
}

// persistLocked writes the current snapshot to disk. Caller must hold s.mu.
func (s *Store) persistLocked() error {
	b, err := json.MarshalIndent(s.states, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.snapshotPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.snapshotPath())
}

// EndpointID derives a stable fleet identity. DeviceID wins when present;
// otherwise a hash of hostname+os+arch+username stands in for it so
// fleets that haven't set --device-id-env still dedupe sanely.
func EndpointID(e model.Endpoint) string {
	if e.DeviceID != "" {
		return "dev:" + e.DeviceID
	}
	h := sha256.New()
	h.Write([]byte(e.Hostname + "\x1f" + e.OS + "\x1f" + e.Arch + "\x1f" + e.Username))
	return "host:" + hex.EncodeToString(h.Sum(nil))[:24]
}

// AppendRaw writes one raw NDJSON line to the per-endpoint audit log.
func (s *Store) AppendRaw(endpointID string, line []byte) {
	f, err := os.OpenFile(filepath.Join(s.dataDir, "raw", endpointID+".ndjson"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(line)
	if len(line) == 0 || line[len(line)-1] != '\n' {
		f.Write([]byte("\n"))
	}
}

// IngestPackage buffers a package record under its run.
func (s *Store) IngestPackage(r model.Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	eid := EndpointID(r.Endpoint)
	buf := s.bufferLocked(eid, r.RunID, r.Endpoint, r.Profile)
	buf.packageCount++
}

// IngestFinding buffers a finding record under its run.
func (s *Store) IngestFinding(f model.Finding) {
	s.mu.Lock()
	defer s.mu.Unlock()
	eid := EndpointID(f.Endpoint)
	buf := s.bufferLocked(eid, f.RunID, f.Endpoint, f.Profile)
	buf.findings = append(buf.findings, f)
}

func (s *Store) bufferLocked(eid, runID string, ep model.Endpoint, profile string) *runBuffer {
	key := eid + "|" + runID
	buf, ok := s.buffers[key]
	if !ok {
		buf = &runBuffer{endpointID: eid, endpoint: ep, profile: profile, started: time.Now()}
		s.buffers[key] = buf
	}
	return buf
}

// IngestSummary commits (or discards, on a non-complete run) the buffered
// state for a run and updates the endpoint's current-state snapshot.
func (s *Store) IngestSummary(sum model.ScanSummary) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	eid := EndpointID(sum.Endpoint)
	key := eid + "|" + sum.RunID
	buf, ok := s.buffers[key]
	if !ok {
		// scan_summary arrived without any buffered records (e.g. an
		// errored run before any package was emitted, or a run that
		// found nothing). Still record the heartbeat / status.
		buf = &runBuffer{endpointID: eid, endpoint: sum.Endpoint, profile: sum.Profile}
	}
	delete(s.buffers, key)

	state, ok := s.states[eid]
	if !ok {
		state = &EndpointState{ID: eid, FirstSeen: time.Now()}
		s.states[eid] = state
	}
	state.Endpoint = sum.Endpoint
	state.Profile = sum.Profile
	state.AgentVersion = sum.ScannerVersion
	state.LastSeen = time.Now()
	state.LastRunID = sum.RunID
	if t, err := time.Parse(time.RFC3339, sum.ScanTime); err == nil {
		state.LastScanTime = t
	} else {
		state.LastScanTime = time.Now()
	}
	state.LastStatus = sum.Status
	state.LastError = sum.Error

	// Only a *complete* run replaces the visible findings/package count.
	// Partial/error runs still update the heartbeat and status (so the
	// dashboard shows the failure) but keep the last-known-good findings
	// rather than silently clearing them.
	if sum.Status == model.ScanStatusComplete {
		state.PackageCount = buf.packageCount
		state.Findings = buf.findings
		state.SeverityCounts = severityCounts(buf.findings)
	}
	state.Light = s.computeLight(state)

	return s.persistLocked()
}

func severityCounts(findings []model.Finding) map[string]int {
	counts := map[string]int{}
	for _, f := range findings {
		sev := f.Severity
		if sev == "" {
			sev = "unknown"
		}
		counts[sev]++
	}
	return counts
}

func (s *Store) computeLight(state *EndpointState) Light {
	if time.Since(state.LastSeen) > s.staleAfter {
		return LightGray
	}
	if state.LastStatus == model.ScanStatusError {
		return LightRed
	}
	if state.SeverityCounts["critical"] > 0 || state.SeverityCounts["high"] > 0 {
		return LightRed
	}
	if state.SeverityCounts["medium"] > 0 || state.SeverityCounts["low"] > 0 ||
		state.SeverityCounts["unknown"] > 0 || state.LastStatus == model.ScanStatusPartial {
		return LightYellow
	}
	return LightGreen
}

// Snapshot returns a copy of all endpoint states with light values
// refreshed against the current time (so staleness updates even between
// ingests, without needing a background ticker).
func (s *Store) Snapshot() []*EndpointState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*EndpointState, 0, len(s.states))
	for _, st := range s.states {
		cp := *st
		cp.Light = s.computeLight(&cp)
		out = append(out, &cp)
	}
	return out
}

// Get returns a single endpoint's state.
func (s *Store) Get(id string) (*EndpointState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return nil, false
	}
	cp := *st
	cp.Light = s.computeLight(&cp)
	return &cp, true
}
