package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// sequenceStep is one CSMS->CP command of a sequence. Command is the body
// POST /command takes. DelayMs is how long to wait before sending it, counted
// from the previous step (from the start for the first one).
type sequenceStep struct {
	DelayMs int             `json:"delayMs,omitempty"`
	Command json.RawMessage `json:"command"`
}

// sequenceRequest is the body of POST /sequence. The steps run in order in the
// background. With PeriodMs the whole sequence starts again that long after
// the previous round began, Repeat times in total (0 = until stopped).
type sequenceRequest struct {
	Steps    []sequenceStep `json:"steps"`
	PeriodMs int            `json:"periodMs,omitempty"`
	Repeat   int            `json:"repeat,omitempty"`
}

// stepResult is the outcome of one sent command.
type stepResult struct {
	Round  int    `json:"round"`
	Step   int    `json:"step"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type sequenceRun struct {
	ID      int          `json:"id"`
	Running bool         `json:"running"`
	Results []stepResult `json:"results"`

	cancel context.CancelFunc
}

type executeFunc func(ctx context.Context, body []byte) (any, int, error)

type sequencer struct {
	exec executeFunc

	mu   sync.Mutex
	next int
	runs []*sequenceRun
}

func newSequencer(exec executeFunc) *sequencer {
	return &sequencer{exec: exec}
}

func (r sequenceRequest) validate() error {
	if len(r.Steps) == 0 {
		return fmt.Errorf("steps must not be empty")
	}
	for i, st := range r.Steps {
		if st.DelayMs < 0 {
			return fmt.Errorf("steps[%d].delayMs must not be negative", i)
		}
		if len(st.Command) == 0 {
			return fmt.Errorf("steps[%d].command is required", i)
		}
	}
	if r.PeriodMs < 0 || r.Repeat < 0 {
		return fmt.Errorf("periodMs and repeat must not be negative")
	}
	if r.Repeat > 1 && r.PeriodMs == 0 {
		return fmt.Errorf("repeat needs periodMs")
	}
	return nil
}

// Start validates req and runs it in the background; the run lives until it
// finishes or Stop is called.
func (s *sequencer) Start(req sequenceRequest) (*sequenceRun, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.next++
	run := &sequenceRun{ID: s.next, Running: true, cancel: cancel}
	s.runs = append(s.runs, run)
	s.mu.Unlock()

	go s.run(ctx, run, req)
	return run, nil
}

func (s *sequencer) run(ctx context.Context, run *sequenceRun, req sequenceRequest) {
	defer func() {
		s.mu.Lock()
		run.Running = false
		s.mu.Unlock()
	}()
	rounds := 1
	if req.PeriodMs > 0 {
		rounds = req.Repeat // 0 = until stopped
	}
	for round := 1; rounds == 0 || round <= rounds; round++ {
		started := time.Now()
		for i, st := range req.Steps {
			if !sleepCtx(ctx, time.Duration(st.DelayMs)*time.Millisecond) {
				return
			}
			res := stepResult{Round: round, Step: i}
			result, _, err := s.exec(ctx, st.Command)
			if err != nil {
				res.Error = err.Error()
			} else {
				res.OK, res.Result = true, result
			}
			s.mu.Lock()
			run.Results = append(run.Results, res)
			s.mu.Unlock()
		}
		if req.PeriodMs == 0 {
			return
		}
		wait := time.Duration(req.PeriodMs)*time.Millisecond - time.Since(started)
		if !sleepCtx(ctx, wait) {
			return
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Stop cancels every running sequence.
func (s *sequencer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.runs {
		r.cancel()
	}
}

// Snapshot copies the runs and their results so far.
func (s *sequencer) Snapshot() []sequenceRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]sequenceRun, 0, len(s.runs))
	for _, r := range s.runs {
		c := *r
		c.Results = append([]stepResult(nil), r.Results...)
		out = append(out, c)
	}
	return out
}

// handle serves POST /sequence (start; answers the run id), GET /sequence
// (every run with the results so far) and DELETE /sequence (stop all runs).
func (s *sequencer) handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var req sequenceRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeCommandError(w, http.StatusBadRequest, fmt.Sprintf("decode sequence: %v", err))
			return
		}
		run, err := s.Start(req)
		if err != nil {
			writeCommandError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeCommandJSON(w, http.StatusOK, commandResponse{OK: true, Result: map[string]int{"id": run.ID}})
	case http.MethodGet:
		writeCommandJSON(w, http.StatusOK, commandResponse{OK: true, Result: s.Snapshot()})
	case http.MethodDelete:
		s.Stop()
		writeCommandJSON(w, http.StatusOK, commandResponse{OK: true})
	default:
		writeCommandError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
