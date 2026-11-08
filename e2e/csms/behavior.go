package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Authorization modes. "offline" is not an authorization policy: it takes the
// CSMS off the network (see offlineGate) and is kept in the same field so one
// switch describes how the fixture currently behaves.
const (
	modeAcceptAll = "accept-all"
	modeWhitelist = "whitelist"
	modeBlacklist = "blacklist"
	modeRateLimit = "rate-limit"
	modeOffline   = "offline"
)

// verdict is the version-neutral outcome of an authorization decision; each
// handler maps it onto the status enum of its OCPP version.
type verdict int

const (
	verdictAccepted verdict = iota
	// verdictUnknown is an idTag the whitelist does not list.
	verdictUnknown
	// verdictBlocked is a blacklisted idTag or one over the rate limit.
	verdictBlocked
)

const (
	defaultBootInterval = 300
	defaultRateMax      = 1
	defaultRateWindow   = time.Minute
)

// behaviorConfig is the wire form of POST /behavior. A field left out keeps
// its current value, except that setting "boot" restarts every charge point's
// position in the sequence.
type behaviorConfig struct {
	// Boot lists the BootNotification statuses to answer in order
	// ("Accepted", "Pending", "Rejected"); the last one repeats.
	Boot []string `json:"boot,omitempty"`
	// BootIntervalSeconds is the `interval` of every BootNotification answer.
	BootIntervalSeconds *int32 `json:"bootIntervalSeconds,omitempty"`
	// Mode is one of accept-all, whitelist, blacklist, rate-limit, offline.
	Mode *string `json:"mode,omitempty"`
	// IDTags is the whitelist or blacklist, depending on Mode.
	IDTags []string `json:"idTags,omitempty"`
	// RateMax is the number of authorization requests one idTag may make in
	// RateWindowMs before it is answered Blocked.
	RateMax      *int `json:"rateMax,omitempty"`
	RateWindowMs *int `json:"rateWindowMs,omitempty"`
}

type behaviorState struct {
	Boot                []string `json:"boot"`
	BootIntervalSeconds int32    `json:"bootIntervalSeconds"`
	Mode                string   `json:"mode"`
	IDTags              []string `json:"idTags"`
	RateMax             int      `json:"rateMax"`
	RateWindowMs        int      `json:"rateWindowMs"`
}

// Behavior is the switchable part of the fixture. The zero value is not
// usable; use newBehavior, whose defaults are the fixture's historical
// behavior: Accepted to everything.
type Behavior struct {
	mu          sync.Mutex
	boot        []string
	bootPos     map[string]int
	bootEvery   int32
	mode        string
	tags        map[string]struct{}
	rateMax     int
	rateWindow  time.Duration
	rateHits    map[string][]time.Time
	onOffline   func()
	offlineFlag bool
}

func newBehavior() *Behavior {
	return &Behavior{
		boot:       []string{"Accepted"},
		bootPos:    map[string]int{},
		bootEvery:  defaultBootInterval,
		mode:       modeAcceptAll,
		tags:       map[string]struct{}{},
		rateMax:    defaultRateMax,
		rateWindow: defaultRateWindow,
		rateHits:   map[string][]time.Time{},
	}
}

var validBootStatuses = map[string]bool{"Accepted": true, "Pending": true, "Rejected": true}

// Apply validates cfg and applies it atomically: an invalid config changes
// nothing.
func (b *Behavior) Apply(cfg behaviorConfig) error {
	for _, s := range cfg.Boot {
		if !validBootStatuses[s] {
			return fmt.Errorf("unsupported boot status %q; expected Accepted, Pending or Rejected", s)
		}
	}
	if cfg.Mode != nil {
		switch *cfg.Mode {
		case modeAcceptAll, modeWhitelist, modeBlacklist, modeRateLimit, modeOffline:
		default:
			return fmt.Errorf("unsupported mode %q; expected accept-all, whitelist, blacklist, rate-limit or offline", *cfg.Mode)
		}
	}
	if cfg.RateMax != nil && *cfg.RateMax < 1 {
		return fmt.Errorf("rateMax must be at least 1")
	}
	if cfg.RateWindowMs != nil && *cfg.RateWindowMs < 1 {
		return fmt.Errorf("rateWindowMs must be at least 1")
	}
	if cfg.BootIntervalSeconds != nil && *cfg.BootIntervalSeconds < 1 {
		return fmt.Errorf("bootIntervalSeconds must be at least 1")
	}

	b.mu.Lock()
	if len(cfg.Boot) > 0 {
		b.boot = append([]string(nil), cfg.Boot...)
		b.bootPos = map[string]int{}
	}
	if cfg.BootIntervalSeconds != nil {
		b.bootEvery = *cfg.BootIntervalSeconds
	}
	if cfg.IDTags != nil {
		b.tags = make(map[string]struct{}, len(cfg.IDTags))
		for _, t := range cfg.IDTags {
			b.tags[t] = struct{}{}
		}
	}
	if cfg.RateMax != nil {
		b.rateMax = *cfg.RateMax
	}
	if cfg.RateWindowMs != nil {
		b.rateWindow = time.Duration(*cfg.RateWindowMs) * time.Millisecond
	}
	if cfg.Mode != nil {
		b.mode = *cfg.Mode
		b.rateHits = map[string][]time.Time{}
	}
	goOffline := b.mode == modeOffline
	b.offlineFlag = goOffline
	hook := b.onOffline
	b.mu.Unlock()

	if goOffline && hook != nil {
		hook()
	}
	return nil
}

// Reset restores the defaults (Accepted to everything, online).
func (b *Behavior) Reset() {
	b.mu.Lock()
	b.boot = []string{"Accepted"}
	b.bootPos = map[string]int{}
	b.bootEvery = defaultBootInterval
	b.mode = modeAcceptAll
	b.tags = map[string]struct{}{}
	b.rateMax = defaultRateMax
	b.rateWindow = defaultRateWindow
	b.rateHits = map[string][]time.Time{}
	b.offlineFlag = false
	b.mu.Unlock()
}

func (b *Behavior) State() behaviorState {
	b.mu.Lock()
	defer b.mu.Unlock()
	tags := make([]string, 0, len(b.tags))
	for t := range b.tags {
		tags = append(tags, t)
	}
	return behaviorState{
		Boot:                append([]string(nil), b.boot...),
		BootIntervalSeconds: b.bootEvery,
		Mode:                b.mode,
		IDTags:              tags,
		RateMax:             b.rateMax,
		RateWindowMs:        int(b.rateWindow / time.Millisecond),
	}
}

// Policed reports whether an authorization policy other than accept-all is
// active; handlers then attach an idTokenInfo to answers that carry none by
// default.
func (b *Behavior) Policed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.mode != modeAcceptAll
}

// Offline reports whether new OCPP connections must be refused.
func (b *Behavior) Offline() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.offlineFlag
}

// NextBoot answers the next status of the sequence for cpID and the interval
// to send with it. Each charge point walks the sequence on its own; the last
// status repeats.
func (b *Behavior) NextBoot(cpID string) (status string, interval int32) {
	b.mu.Lock()
	defer b.mu.Unlock()
	i := b.bootPos[cpID]
	if i >= len(b.boot) {
		i = len(b.boot) - 1
	} else {
		b.bootPos[cpID] = i + 1
	}
	return b.boot[i], b.bootEvery
}

// Authorize decides one authorization request (Authorize, or the idTag of a
// StartTransaction / TransactionEvent) made at time now.
func (b *Behavior) Authorize(idTag string, now time.Time) verdict {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.mode {
	case modeWhitelist:
		if _, ok := b.tags[idTag]; !ok {
			return verdictUnknown
		}
	case modeBlacklist:
		if _, ok := b.tags[idTag]; ok {
			return verdictBlocked
		}
	case modeRateLimit:
		cutoff := now.Add(-b.rateWindow)
		kept := b.rateHits[idTag][:0]
		for _, t := range b.rateHits[idTag] {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		if len(kept) >= b.rateMax {
			b.rateHits[idTag] = kept
			return verdictBlocked
		}
		b.rateHits[idTag] = append(kept, now)
	}
	return verdictAccepted
}

func (v verdict) status16() string {
	switch v {
	case verdictUnknown:
		return "Invalid"
	case verdictBlocked:
		return "Blocked"
	default:
		return "Accepted"
	}
}

func (v verdict) status2x() string {
	switch v {
	case verdictUnknown:
		return "Unknown"
	case verdictBlocked:
		return "Blocked"
	default:
		return "Accepted"
	}
}

// handleBehavior serves GET /behavior (current state), POST /behavior (apply
// a behaviorConfig) and DELETE /behavior (restore the defaults).
func (b *Behavior) handleBehavior(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var cfg behaviorConfig
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cfg); err != nil {
			writeCommandError(w, http.StatusBadRequest, fmt.Sprintf("decode behavior: %v", err))
			return
		}
		if err := b.Apply(cfg); err != nil {
			writeCommandError(w, http.StatusBadRequest, err.Error())
			return
		}
	case http.MethodDelete:
		b.Reset()
	default:
		writeCommandError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeCommandJSON(w, http.StatusOK, commandResponse{OK: true, Result: b.State()})
}
