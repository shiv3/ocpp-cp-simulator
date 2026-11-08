package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeExec struct {
	mu    sync.Mutex
	calls []string
	at    []time.Time
	fail  string
}

func (f *fakeExec) exec(_ context.Context, body []byte) (any, int, error) {
	var env commandEnvelope
	_ = json.Unmarshal(body, &env)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, env.Action)
	f.at = append(f.at, time.Now())
	if env.Action == f.fail {
		return nil, 200, errors.New("boom")
	}
	return map[string]string{"action": env.Action}, 200, nil
}

func (f *fakeExec) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func cmd(action string) json.RawMessage {
	return json.RawMessage(`{"cpId":"cp","action":"` + action + `"}`)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestSequenceRunsStepsInOrderWithDelays(t *testing.T) {
	f := &fakeExec{fail: "B"}
	s := newSequencer(f.exec)
	start := time.Now()
	run, err := s.Start(sequenceRequest{Steps: []sequenceStep{
		{Command: cmd("A")},
		{DelayMs: 60, Command: cmd("B")},
		{DelayMs: 10, Command: cmd("C")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "three steps", func() bool { return f.count() == 3 })
	if got := f.calls; got[0] != "A" || got[1] != "B" || got[2] != "C" {
		t.Fatalf("order: %v", got)
	}
	if f.at[1].Sub(start) < 60*time.Millisecond {
		t.Fatalf("step 2 ran %v after start, want >= 60ms", f.at[1].Sub(start))
	}
	waitFor(t, "run to finish", func() bool { return !s.Snapshot()[0].Running })
	res := s.Snapshot()[0].Results
	if run.ID != 1 || len(res) != 3 || !res[0].OK || res[1].OK || res[1].Error != "boom" || !res[2].OK {
		t.Fatalf("results: %+v", res)
	}
}

func TestSequencePeriodicRepeatsAndStops(t *testing.T) {
	f := &fakeExec{}
	s := newSequencer(f.exec)
	if _, err := s.Start(sequenceRequest{Steps: []sequenceStep{{Command: cmd("A")}}, PeriodMs: 20, Repeat: 3}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "three rounds", func() bool { return !s.Snapshot()[0].Running })
	if f.count() != 3 {
		t.Fatalf("repeat=3 ran %d rounds", f.count())
	}

	// repeat 0 runs until stopped.
	if _, err := s.Start(sequenceRequest{Steps: []sequenceStep{{Command: cmd("A")}}, PeriodMs: 10}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a few rounds", func() bool { return f.count() >= 6 })
	s.Stop()
	waitFor(t, "stop", func() bool { return !s.Snapshot()[1].Running })
	n := f.count()
	time.Sleep(60 * time.Millisecond)
	if f.count() != n {
		t.Fatal("a stopped sequence must not send more commands")
	}
}

func TestSequenceValidation(t *testing.T) {
	s := newSequencer((&fakeExec{}).exec)
	bad := []sequenceRequest{
		{},
		{Steps: []sequenceStep{{}}},
		{Steps: []sequenceStep{{DelayMs: -1, Command: cmd("A")}}},
		{Steps: []sequenceStep{{Command: cmd("A")}}, Repeat: 2},
		{Steps: []sequenceStep{{Command: cmd("A")}}, PeriodMs: -1},
	}
	for i, req := range bad {
		if _, err := s.Start(req); err == nil {
			t.Fatalf("case %d: expected an error", i)
		}
	}
}
