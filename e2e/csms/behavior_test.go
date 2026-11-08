package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func strp(s string) *string { return &s }
func intp(i int) *int       { return &i }

func TestBootSequenceIsPerChargePointAndRepeatsTheLastStatus(t *testing.T) {
	b := newBehavior()
	if err := b.Apply(behaviorConfig{Boot: []string{"Pending", "Pending", "Accepted"}}); err != nil {
		t.Fatal(err)
	}
	var got []string
	for i := 0; i < 5; i++ {
		s, _ := b.NextBoot("cp-a")
		got = append(got, s)
	}
	if want := "Pending Pending Accepted Accepted Accepted"; strings.Join(got, " ") != want {
		t.Fatalf("cp-a: got %v, want %s", got, want)
	}
	if s, _ := b.NextBoot("cp-b"); s != "Pending" {
		t.Fatalf("cp-b starts its own sequence, got %s", s)
	}
	// A new sequence restarts every charge point.
	if err := b.Apply(behaviorConfig{Boot: []string{"Rejected", "Accepted"}}); err != nil {
		t.Fatal(err)
	}
	if s, _ := b.NextBoot("cp-a"); s != "Rejected" {
		t.Fatalf("after reconfiguring, got %s", s)
	}
}

func TestDefaultsAcceptEverything(t *testing.T) {
	b := newBehavior()
	if s, iv := b.NextBoot("cp"); s != "Accepted" || iv != defaultBootInterval {
		t.Fatalf("boot: %s %d", s, iv)
	}
	if v := b.Authorize("anyone", time.Now()); v != verdictAccepted {
		t.Fatalf("authorize: %v", v)
	}
	if b.Policed() || b.Offline() {
		t.Fatal("defaults must be online with no policy")
	}
}

func TestWhitelistAndBlacklist(t *testing.T) {
	now := time.Now()
	b := newBehavior()
	_ = b.Apply(behaviorConfig{Mode: strp(modeWhitelist), IDTags: []string{"GOOD"}})
	if b.Authorize("GOOD", now) != verdictAccepted || b.Authorize("OTHER", now) != verdictUnknown {
		t.Fatal("whitelist: listed tag accepted, others unknown")
	}
	if verdictUnknown.status16() != "Invalid" || verdictUnknown.status2x() != "Unknown" {
		t.Fatal("whitelist miss maps to Invalid (1.6) / Unknown (2.x)")
	}
	_ = b.Apply(behaviorConfig{Mode: strp(modeBlacklist), IDTags: []string{"BAD"}})
	if b.Authorize("BAD", now) != verdictBlocked || b.Authorize("GOOD", now) != verdictAccepted {
		t.Fatal("blacklist: listed tag blocked, others accepted")
	}
}

func TestRateLimitSlidingWindowPerTag(t *testing.T) {
	b := newBehavior()
	if err := b.Apply(behaviorConfig{Mode: strp(modeRateLimit), RateMax: intp(2), RateWindowMs: intp(1000)}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Unix(1000, 0)
	for i := 0; i < 2; i++ {
		if b.Authorize("A", t0) != verdictAccepted {
			t.Fatalf("request %d within the limit", i)
		}
	}
	if b.Authorize("A", t0.Add(500*time.Millisecond)) != verdictBlocked {
		t.Fatal("third request in the window is blocked")
	}
	if b.Authorize("B", t0) != verdictAccepted {
		t.Fatal("limit is per idTag")
	}
	if b.Authorize("A", t0.Add(1100*time.Millisecond)) != verdictAccepted {
		t.Fatal("window slid past the first requests")
	}
}

func TestApplyRejectsInvalidConfigWithoutChangingState(t *testing.T) {
	b := newBehavior()
	bad := []behaviorConfig{
		{Boot: []string{"Accepted", "Maybe"}},
		{Mode: strp("chaos")},
		{RateMax: intp(0)},
		{RateWindowMs: intp(0)},
	}
	for _, cfg := range bad {
		if err := b.Apply(cfg); err == nil {
			t.Fatalf("expected an error for %+v", cfg)
		}
	}
	if st := b.State(); st.Mode != modeAcceptAll || len(st.Boot) != 1 {
		t.Fatalf("state changed: %+v", st)
	}
}

func TestOfflineModeRunsTheDropHookAndRefusesConnections(t *testing.T) {
	b := newBehavior()
	dropped := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	g := newOfflineGate(b, next)
	orig := b.onOffline
	b.onOffline = func() { dropped = true; orig() }

	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ocpp/cp", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("online: %d", rec.Code)
	}
	_ = b.Apply(behaviorConfig{Mode: strp(modeOffline)})
	if !dropped {
		t.Fatal("going offline must drop open connections")
	}
	rec = httptest.NewRecorder()
	g.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ocpp/cp", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("offline: %d", rec.Code)
	}
	_ = b.Apply(behaviorConfig{Mode: strp(modeAcceptAll)})
	rec = httptest.NewRecorder()
	g.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ocpp/cp", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("back online: %d", rec.Code)
	}
}

func TestBehaviorEndpoint(t *testing.T) {
	b := newBehavior()
	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		b.handleBehavior(rec, httptest.NewRequest(http.MethodPost, "/behavior", strings.NewReader(body)))
		return rec
	}
	if rec := post(`{"boot":["Pending","Accepted"],"mode":"whitelist","idTags":["X"]}`); rec.Code != http.StatusOK {
		t.Fatalf("valid: %d %s", rec.Code, rec.Body)
	}
	if rec := post(`{"mood":"calm"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field must be a 400, got %d", rec.Code)
	}
	if rec := post(`{"mode":"chaos"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode must be a 400, got %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	b.handleBehavior(rec, httptest.NewRequest(http.MethodDelete, "/behavior", nil))
	if rec.Code != http.StatusOK || b.State().Mode != modeAcceptAll {
		t.Fatalf("DELETE restores defaults: %d %+v", rec.Code, b.State())
	}
}
