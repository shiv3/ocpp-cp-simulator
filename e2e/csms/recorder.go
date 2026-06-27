package main

import (
	"bufio"
	"encoding/json"
	"sync"
)

type Recorder struct {
	mu  sync.Mutex
	seq int64
	enc *json.Encoder
	out *bufio.Writer
}

type recordedFrame struct {
	Seq     int64  `json:"seq"`
	CPID    string `json:"cpId"`
	Action  string `json:"action"`
	Payload any    `json:"payload"`
}

func NewRecorder(out *bufio.Writer) *Recorder {
	return &Recorder{
		enc: json.NewEncoder(out),
		out: out,
	}
}

func (r *Recorder) Record(cpID, action string, payload any) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.seq++
	if err := r.enc.Encode(recordedFrame{
		Seq:     r.seq,
		CPID:    cpID,
		Action:  action,
		Payload: payload,
	}); err != nil {
		return err
	}
	return r.out.Flush()
}

func (r *Recorder) Flush() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.out.Flush()
}
