package main

import (
	"context"
	"time"

	"github.com/shiv3/gocpp/csms"
	v21h "github.com/shiv3/gocpp/v21/handlers"
	v21msg "github.com/shiv3/gocpp/v21/messages"
)

type handler21 struct {
	v21h.UnimplementedCSMSHandler

	rec *Recorder
}

func register21(srv *csms.Server, rec *Recorder) error {
	return v21h.RegisterCSMS(srv, &handler21{rec: rec})
}

func (h *handler21) OnBootNotification(_ context.Context, conn *csms.Conn, req v21msg.BootNotificationRequest) (v21msg.BootNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "BootNotification", req); err != nil {
		return v21msg.BootNotificationResponse{}, err
	}
	return v21msg.BootNotificationResponse{
		CurrentTime: time.Now().UTC(),
		Interval:    300,
		Status:      "Accepted",
	}, nil
}

func (h *handler21) OnHeartbeat(_ context.Context, conn *csms.Conn, req v21msg.HeartbeatRequest) (v21msg.HeartbeatResponse, error) {
	if err := h.rec.Record(conn.ID(), "Heartbeat", req); err != nil {
		return v21msg.HeartbeatResponse{}, err
	}
	return v21msg.HeartbeatResponse{CurrentTime: time.Now().UTC()}, nil
}

func (h *handler21) OnStatusNotification(_ context.Context, conn *csms.Conn, req v21msg.StatusNotificationRequest) (v21msg.StatusNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "StatusNotification", req); err != nil {
		return v21msg.StatusNotificationResponse{}, err
	}
	return v21msg.StatusNotificationResponse{}, nil
}

func (h *handler21) OnAuthorize(_ context.Context, conn *csms.Conn, req v21msg.AuthorizeRequest) (v21msg.AuthorizeResponse, error) {
	if err := h.rec.Record(conn.ID(), "Authorize", req); err != nil {
		return v21msg.AuthorizeResponse{}, err
	}
	return v21msg.AuthorizeResponse{
		IDTokenInfo: v21msg.IdTokenInfoType{Status: "Accepted"},
	}, nil
}

func (h *handler21) OnTransactionEvent(_ context.Context, conn *csms.Conn, req v21msg.TransactionEventRequest) (v21msg.TransactionEventResponse, error) {
	if err := h.rec.Record(conn.ID(), "TransactionEvent", req); err != nil {
		return v21msg.TransactionEventResponse{}, err
	}
	return v21msg.TransactionEventResponse{}, nil
}

func (h *handler21) OnMeterValues(_ context.Context, conn *csms.Conn, req v21msg.MeterValuesRequest) (v21msg.MeterValuesResponse, error) {
	if err := h.rec.Record(conn.ID(), "MeterValues", req); err != nil {
		return v21msg.MeterValuesResponse{}, err
	}
	return v21msg.MeterValuesResponse{}, nil
}

func (h *handler21) OnNotifyReport(_ context.Context, conn *csms.Conn, req v21msg.NotifyReportRequest) (v21msg.NotifyReportResponse, error) {
	if err := h.rec.Record(conn.ID(), "NotifyReport", req); err != nil {
		return v21msg.NotifyReportResponse{}, err
	}
	return v21msg.NotifyReportResponse{}, nil
}
