package main

import (
	"sync"

	"github.com/shiv3/gocpp/csms"
)

type registry struct {
	mu    sync.RWMutex
	conns map[string]*csms.Conn
}

func newRegistry() *registry {
	return &registry{conns: make(map[string]*csms.Conn)}
}

func (r *registry) add(conn *csms.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[conn.ID()] = conn
}

func (r *registry) del(conn *csms.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[conn.ID()] != conn {
		return
	}
	delete(r.conns, conn.ID())
}

func (r *registry) get(cpID string) (*csms.Conn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	conn, ok := r.conns[cpID]
	return conn, ok
}
