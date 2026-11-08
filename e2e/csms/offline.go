package main

import (
	"net"
	"net/http"
	"sync"
)

// offlineGate takes the OCPP listener off the network on demand: while the
// Behavior is offline a WebSocket upgrade is answered 503, and switching
// offline drops every connection that is open. The simulator then sees what a
// CSMS outage looks like: a closed socket and a refused reconnect.
type offlineGate struct {
	beh  *Behavior
	next http.Handler

	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

func newOfflineGate(beh *Behavior, next http.Handler) *offlineGate {
	g := &offlineGate{beh: beh, next: next, conns: map[net.Conn]struct{}{}}
	beh.onOffline = g.dropAll
	return g
}

func (g *offlineGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.beh.Offline() {
		http.Error(w, "CSMS offline", http.StatusServiceUnavailable)
		return
	}
	g.next.ServeHTTP(w, r)
}

// connState is the http.Server.ConnState hook. A hijacked (WebSocket)
// connection leaves the server's own accounting, so the gate keeps its own
// list from the moment the TCP connection is accepted.
func (g *offlineGate) connState(c net.Conn, state http.ConnState) {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch state {
	case http.StateNew:
		g.conns[c] = struct{}{}
	case http.StateClosed:
		delete(g.conns, c)
	}
}

func (g *offlineGate) dropAll() {
	g.mu.Lock()
	open := make([]net.Conn, 0, len(g.conns))
	for c := range g.conns {
		open = append(open, c)
	}
	g.mu.Unlock()
	for _, c := range open {
		_ = c.Close()
	}
}
