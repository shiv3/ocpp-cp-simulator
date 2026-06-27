package main

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/shiv3/gocpp/csms"
	v16h "github.com/shiv3/gocpp/v16/handlers"
	v16msg "github.com/shiv3/gocpp/v16/messages"
)

type handler16 struct {
	v16h.UnimplementedCSMSHandler

	rec    *Recorder
	nextTx atomic.Int32
}

func register16(srv *csms.Server, rec *Recorder) error {
	return v16h.RegisterCSMS(srv, &handler16{rec: rec})
}

func (h *handler16) OnBootNotification(_ context.Context, conn *csms.Conn, req v16msg.BootNotificationRequest) (v16msg.BootNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "BootNotification", req); err != nil {
		return v16msg.BootNotificationResponse{}, err
	}
	return v16msg.BootNotificationResponse{
		CurrentTime: time.Now().UTC(),
		Interval:    300,
		Status:      v16msg.RegistrationStatusAccepted,
	}, nil
}

func (h *handler16) OnHeartbeat(_ context.Context, conn *csms.Conn, req v16msg.HeartbeatRequest) (v16msg.HeartbeatResponse, error) {
	if err := h.rec.Record(conn.ID(), "Heartbeat", req); err != nil {
		return v16msg.HeartbeatResponse{}, err
	}
	return v16msg.HeartbeatResponse{CurrentTime: time.Now().UTC()}, nil
}

func (h *handler16) OnStatusNotification(_ context.Context, conn *csms.Conn, req v16msg.StatusNotificationRequest) (v16msg.StatusNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "StatusNotification", req); err != nil {
		return v16msg.StatusNotificationResponse{}, err
	}
	return v16msg.StatusNotificationResponse{}, nil
}

func (h *handler16) OnAuthorize(_ context.Context, conn *csms.Conn, req v16msg.AuthorizeRequest) (v16msg.AuthorizeResponse, error) {
	if err := h.rec.Record(conn.ID(), "Authorize", req); err != nil {
		return v16msg.AuthorizeResponse{}, err
	}
	return v16msg.AuthorizeResponse{
		IDTagInfo: v16msg.IDTagInfo{Status: v16msg.IDTagInfoStatusAccepted},
	}, nil
}

func (h *handler16) OnStartTransaction(_ context.Context, conn *csms.Conn, req v16msg.StartTransactionRequest) (v16msg.StartTransactionResponse, error) {
	if err := h.rec.Record(conn.ID(), "StartTransaction", req); err != nil {
		return v16msg.StartTransactionResponse{}, err
	}
	return v16msg.StartTransactionResponse{
		IDTagInfo:     v16msg.IDTagInfo{Status: v16msg.IDTagInfoStatusAccepted},
		TransactionID: h.nextTx.Add(1),
	}, nil
}

func (h *handler16) OnStopTransaction(_ context.Context, conn *csms.Conn, req v16msg.StopTransactionRequest) (v16msg.StopTransactionResponse, error) {
	if err := h.rec.Record(conn.ID(), "StopTransaction", req); err != nil {
		return v16msg.StopTransactionResponse{}, err
	}
	return v16msg.StopTransactionResponse{}, nil
}

func (h *handler16) OnMeterValues(_ context.Context, conn *csms.Conn, req v16msg.MeterValuesRequest) (v16msg.MeterValuesResponse, error) {
	if err := h.rec.Record(conn.ID(), "MeterValues", req); err != nil {
		return v16msg.MeterValuesResponse{}, err
	}
	return v16msg.MeterValuesResponse{}, nil
}

func (h *handler16) OnDataTransfer(_ context.Context, conn *csms.Conn, req v16msg.DataTransferRequest) (v16msg.DataTransferResponse, error) {
	if err := h.rec.Record(conn.ID(), "DataTransfer", req); err != nil {
		return v16msg.DataTransferResponse{}, err
	}
	return v16msg.DataTransferResponse{
		Status: v16msg.DataTransferResponseStatusAccepted,
	}, nil
}
