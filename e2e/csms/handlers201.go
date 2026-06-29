package main

import (
	"context"
	"time"

	"github.com/shiv3/gocpp/csms"
	v201h "github.com/shiv3/gocpp/v201/handlers"
	v201msg "github.com/shiv3/gocpp/v201/messages"
)

type handler201 struct {
	v201h.UnimplementedCSMSHandler

	rec *Recorder
}

func register201(srv *csms.Server, rec *Recorder) error {
	return v201h.RegisterCSMS(srv, &handler201{rec: rec})
}

func (h *handler201) OnBootNotification(_ context.Context, conn *csms.Conn, req v201msg.BootNotificationRequest) (v201msg.BootNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "BootNotification", req); err != nil {
		return v201msg.BootNotificationResponse{}, err
	}
	return v201msg.BootNotificationResponse{
		CurrentTime: time.Now().UTC(),
		Interval:    300,
		Status:      "Accepted",
	}, nil
}

func (h *handler201) OnHeartbeat(_ context.Context, conn *csms.Conn, req v201msg.HeartbeatRequest) (v201msg.HeartbeatResponse, error) {
	if err := h.rec.Record(conn.ID(), "Heartbeat", req); err != nil {
		return v201msg.HeartbeatResponse{}, err
	}
	return v201msg.HeartbeatResponse{CurrentTime: time.Now().UTC()}, nil
}

func (h *handler201) OnStatusNotification(_ context.Context, conn *csms.Conn, req v201msg.StatusNotificationRequest) (v201msg.StatusNotificationResponse, error) {
	if err := h.rec.Record(conn.ID(), "StatusNotification", req); err != nil {
		return v201msg.StatusNotificationResponse{}, err
	}
	return v201msg.StatusNotificationResponse{}, nil
}

func (h *handler201) OnAuthorize(_ context.Context, conn *csms.Conn, req v201msg.AuthorizeRequest) (v201msg.AuthorizeResponse, error) {
	if err := h.rec.Record(conn.ID(), "Authorize", req); err != nil {
		return v201msg.AuthorizeResponse{}, err
	}
	return v201msg.AuthorizeResponse{
		IDTokenInfo: v201msg.IdTokenInfoType{Status: "Accepted"},
	}, nil
}

func (h *handler201) OnTransactionEvent(_ context.Context, conn *csms.Conn, req v201msg.TransactionEventRequest) (v201msg.TransactionEventResponse, error) {
	if err := h.rec.Record(conn.ID(), "TransactionEvent", req); err != nil {
		return v201msg.TransactionEventResponse{}, err
	}
	return v201msg.TransactionEventResponse{}, nil
}

func (h *handler201) OnMeterValues(_ context.Context, conn *csms.Conn, req v201msg.MeterValuesRequest) (v201msg.MeterValuesResponse, error) {
	if err := h.rec.Record(conn.ID(), "MeterValues", req); err != nil {
		return v201msg.MeterValuesResponse{}, err
	}
	return v201msg.MeterValuesResponse{}, nil
}

func (h *handler201) OnNotifyReport(_ context.Context, conn *csms.Conn, req v201msg.NotifyReportRequest) (v201msg.NotifyReportResponse, error) {
	if err := h.rec.Record(conn.ID(), "NotifyReport", req); err != nil {
		return v201msg.NotifyReportResponse{}, err
	}
	return v201msg.NotifyReportResponse{}, nil
}

func (h *handler201) OnDataTransfer(_ context.Context, conn *csms.Conn, req v201msg.DataTransferRequest) (v201msg.DataTransferResponse, error) {
	if err := h.rec.Record(conn.ID(), "DataTransfer", req); err != nil {
		return v201msg.DataTransferResponse{}, err
	}
	return v201msg.DataTransferResponse{Status: "Accepted"}, nil
}
