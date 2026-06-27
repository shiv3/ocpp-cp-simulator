package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/shiv3/gocpp/csms"
	v16client "github.com/shiv3/gocpp/v16/client"
	v16msg "github.com/shiv3/gocpp/v16/messages"
	v201client "github.com/shiv3/gocpp/v201/client"
	v201msg "github.com/shiv3/gocpp/v201/messages"
	v21client "github.com/shiv3/gocpp/v21/client"
	v21msg "github.com/shiv3/gocpp/v21/messages"
)

type controlHandler struct {
	version         string
	reg             *registry
	nextRemoteStart atomic.Int32
}

type commandEnvelope struct {
	CPID   string `json:"cpId"`
	Action string `json:"action"`
}

type commandResponse struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func newControlHandler(version string, reg *registry) http.Handler {
	h := &controlHandler{version: version, reg: reg}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", h.healthz)
	mux.HandleFunc("/command", h.command)
	return mux
}

func (h *controlHandler) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCommandError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeCommandJSON(w, http.StatusOK, commandResponse{OK: true})
}

func (h *controlHandler) command(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCommandError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeCommandError(w, http.StatusBadRequest, fmt.Sprintf("read command: %v", err))
		return
	}

	var base commandEnvelope
	if err := json.Unmarshal(body, &base); err != nil {
		writeCommandError(w, http.StatusBadRequest, fmt.Sprintf("decode command: %v", err))
		return
	}
	if base.CPID == "" {
		writeCommandError(w, http.StatusBadRequest, "cpId is required")
		return
	}
	if base.Action == "" {
		writeCommandError(w, http.StatusBadRequest, "action is required")
		return
	}

	conn, ok := h.reg.get(base.CPID)
	if !ok {
		writeCommandError(w, http.StatusNotFound, fmt.Sprintf("charge point %q is not connected", base.CPID))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	result, err := h.dispatch(ctx, conn, base.Action, body)
	if err != nil {
		writeCommandError(w, http.StatusOK, err.Error())
		return
	}
	writeCommandJSON(w, http.StatusOK, commandResponse{OK: true, Result: result})
}

func (h *controlHandler) dispatch(ctx context.Context, conn *csms.Conn, action string, body []byte) (any, error) {
	switch h.version {
	case "1.6":
		return h.dispatch16(ctx, conn, action, body)
	case "2.0.1":
		return h.dispatch201(ctx, conn, action, body)
	case "2.1":
		return h.dispatch21(ctx, conn, action, body)
	default:
		return nil, fmt.Errorf("unsupported version %q", h.version)
	}
}

func (h *controlHandler) dispatch16(ctx context.Context, conn *csms.Conn, action string, body []byte) (any, error) {
	client := v16client.NewCSMS(conn)
	switch action {
	case "RemoteStartTransaction":
		cmd, err := decodeCommand[remoteStartTransaction16Command](body)
		if err != nil {
			return nil, err
		}
		return client.RemoteStartTransaction(ctx, v16msg.RemoteStartTransactionRequest{
			ConnectorID: cmd.ConnectorID,
			IDTag:       cmd.IDTag,
		})
	case "RemoteStopTransaction":
		cmd, err := decodeCommand[remoteStopTransaction16Command](body)
		if err != nil {
			return nil, err
		}
		return client.RemoteStopTransaction(ctx, v16msg.RemoteStopTransactionRequest{
			TransactionID: cmd.TransactionID,
		})
	case "Reset":
		cmd, err := decodeCommand[reset16Command](body)
		if err != nil {
			return nil, err
		}
		return client.Reset(ctx, v16msg.ResetRequest{Type: v16msg.ResetRequestType(cmd.Type)})
	case "ReserveNow":
		cmd, err := decodeCommand[reserveNow16Command](body)
		if err != nil {
			return nil, err
		}
		return client.ReserveNow(ctx, v16msg.ReserveNowRequest{
			ConnectorID:   cmd.ConnectorID,
			ExpiryDate:    cmd.ExpiryDate,
			IDTag:         cmd.IDTag,
			ParentIDTag:   cmd.ParentIDTag,
			ReservationID: cmd.ReservationID,
		})
	case "CancelReservation":
		cmd, err := decodeCommand[cancelReservation16Command](body)
		if err != nil {
			return nil, err
		}
		return client.CancelReservation(ctx, v16msg.CancelReservationRequest{
			ReservationID: cmd.ReservationID,
		})
	default:
		return nil, fmt.Errorf("unsupported 1.6 action %q", action)
	}
}

func (h *controlHandler) dispatch201(ctx context.Context, conn *csms.Conn, action string, body []byte) (any, error) {
	client := v201client.NewCSMS(conn)
	switch action {
	case "RequestStartTransaction":
		cmd, err := decodeCommand[requestStartTransaction201Command](body)
		if err != nil {
			return nil, err
		}
		return client.RequestStartTransaction(ctx, v201msg.RequestStartTransactionRequest{
			EVSEID:        cmd.EVSEID,
			IDToken:       cmd.IDToken,
			RemoteStartID: h.remoteStartID(cmd.RemoteStartID),
		})
	case "RequestStopTransaction":
		cmd, err := decodeCommand[requestStopTransactionCommand](body)
		if err != nil {
			return nil, err
		}
		return client.RequestStopTransaction(ctx, v201msg.RequestStopTransactionRequest{
			TransactionID: cmd.TransactionID,
		})
	case "Reset":
		cmd, err := decodeCommand[resetCommand](body)
		if err != nil {
			return nil, err
		}
		return client.Reset(ctx, v201msg.ResetRequest{Type: cmd.Type})
	case "ChangeAvailability":
		cmd, err := decodeCommand[changeAvailability201Command](body)
		if err != nil {
			return nil, err
		}
		return client.ChangeAvailability(ctx, v201msg.ChangeAvailabilityRequest{
			EVSE:              cmd.EVSE,
			OperationalStatus: cmd.OperationalStatus,
		})
	case "TriggerMessage":
		cmd, err := decodeCommand[triggerMessage201Command](body)
		if err != nil {
			return nil, err
		}
		return client.TriggerMessage(ctx, v201msg.TriggerMessageRequest{
			EVSE:             cmd.EVSE,
			RequestedMessage: cmd.RequestedMessage,
		})
	case "UnlockConnector":
		cmd, err := decodeCommand[unlockConnectorCommand](body)
		if err != nil {
			return nil, err
		}
		return client.UnlockConnector(ctx, v201msg.UnlockConnectorRequest{
			ConnectorID: cmd.ConnectorID,
			EVSEID:      cmd.EVSEID,
		})
	case "GetVariables":
		cmd, err := decodeCommand[getVariables201Command](body)
		if err != nil {
			return nil, err
		}
		return client.GetVariables(ctx, v201msg.GetVariablesRequest{
			GetVariableData: cmd.GetVariableData,
		})
	case "SetVariables":
		cmd, err := decodeCommand[setVariables201Command](body)
		if err != nil {
			return nil, err
		}
		return client.SetVariables(ctx, v201msg.SetVariablesRequest{
			SetVariableData: cmd.SetVariableData,
		})
	case "GetBaseReport":
		cmd, err := decodeCommand[getBaseReportCommand](body)
		if err != nil {
			return nil, err
		}
		return client.GetBaseReport(ctx, v201msg.GetBaseReportRequest{
			ReportBase: cmd.ReportBase,
			RequestID:  cmd.RequestID,
		})
	case "ReserveNow":
		cmd, err := decodeCommand[reserveNow201Command](body)
		if err != nil {
			return nil, err
		}
		return client.ReserveNow(ctx, v201msg.ReserveNowRequest{
			EVSEID:         cmd.EVSEID,
			ExpiryDateTime: cmd.ExpiryDateTime,
			ID:             cmd.ID,
			IDToken:        cmd.IDToken,
		})
	default:
		return nil, fmt.Errorf("unsupported 2.0.1 action %q", action)
	}
}

func (h *controlHandler) dispatch21(ctx context.Context, conn *csms.Conn, action string, body []byte) (any, error) {
	client := v21client.NewCSMS(conn)
	switch action {
	case "RequestStartTransaction":
		cmd, err := decodeCommand[requestStartTransaction21Command](body)
		if err != nil {
			return nil, err
		}
		return client.RequestStartTransaction(ctx, v21msg.RequestStartTransactionRequest{
			EVSEID:        cmd.EVSEID,
			IDToken:       cmd.IDToken,
			RemoteStartID: h.remoteStartID(cmd.RemoteStartID),
		})
	case "RequestStopTransaction":
		cmd, err := decodeCommand[requestStopTransactionCommand](body)
		if err != nil {
			return nil, err
		}
		return client.RequestStopTransaction(ctx, v21msg.RequestStopTransactionRequest{
			TransactionID: cmd.TransactionID,
		})
	case "UsePriorityCharging":
		cmd, err := decodeCommand[usePriorityChargingCommand](body)
		if err != nil {
			return nil, err
		}
		return client.UsePriorityCharging(ctx, v21msg.UsePriorityChargingRequest{
			Activate:      cmd.Activate,
			TransactionID: cmd.TransactionID,
		})
	default:
		return nil, fmt.Errorf("unsupported 2.1 action %q", action)
	}
}

func (h *controlHandler) remoteStartID(value *int32) int32 {
	if value != nil {
		return *value
	}
	return h.nextRemoteStart.Add(1)
}

func decodeCommand[T any](body []byte) (T, error) {
	var cmd T
	if err := json.Unmarshal(body, &cmd); err != nil {
		return cmd, fmt.Errorf("decode command: %w", err)
	}
	return cmd, nil
}

func writeCommandJSON(w http.ResponseWriter, status int, resp commandResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

func writeCommandError(w http.ResponseWriter, status int, msg string) {
	writeCommandJSON(w, status, commandResponse{OK: false, Error: msg})
}

type remoteStartTransaction16Command struct {
	commandEnvelope
	ConnectorID *int32 `json:"connectorId,omitempty"`
	IDTag       string `json:"idTag"`
}

type remoteStopTransaction16Command struct {
	commandEnvelope
	TransactionID int32 `json:"transactionId"`
}

type reset16Command struct {
	commandEnvelope
	Type string `json:"type"`
}

type reserveNow16Command struct {
	commandEnvelope
	ConnectorID   int32     `json:"connectorId"`
	ExpiryDate    time.Time `json:"expiryDate"`
	IDTag         string    `json:"idTag"`
	ParentIDTag   *string   `json:"parentIdTag,omitempty"`
	ReservationID int32     `json:"reservationId"`
}

type cancelReservation16Command struct {
	commandEnvelope
	ReservationID int32 `json:"reservationId"`
}

type requestStartTransaction201Command struct {
	commandEnvelope
	EVSEID        *int32              `json:"evseId,omitempty"`
	IDToken       v201msg.IdTokenType `json:"idToken"`
	RemoteStartID *int32              `json:"remoteStartId,omitempty"`
}

type requestStartTransaction21Command struct {
	commandEnvelope
	EVSEID        *int32             `json:"evseId,omitempty"`
	IDToken       v21msg.IdTokenType `json:"idToken"`
	RemoteStartID *int32             `json:"remoteStartId,omitempty"`
}

type requestStopTransactionCommand struct {
	commandEnvelope
	TransactionID string `json:"transactionId"`
}

type resetCommand struct {
	commandEnvelope
	Type string `json:"type"`
}

type changeAvailability201Command struct {
	commandEnvelope
	EVSE              *v201msg.EVSEType `json:"evse,omitempty"`
	OperationalStatus string            `json:"operationalStatus"`
}

type triggerMessage201Command struct {
	commandEnvelope
	EVSE             *v201msg.EVSEType `json:"evse,omitempty"`
	RequestedMessage string            `json:"requestedMessage"`
}

type unlockConnectorCommand struct {
	commandEnvelope
	ConnectorID int32 `json:"connectorId"`
	EVSEID      int32 `json:"evseId"`
}

type getVariables201Command struct {
	commandEnvelope
	GetVariableData []v201msg.GetVariableDataType `json:"getVariableData"`
}

type setVariables201Command struct {
	commandEnvelope
	SetVariableData []v201msg.SetVariableDataType `json:"setVariableData"`
}

type getBaseReportCommand struct {
	commandEnvelope
	ReportBase string `json:"reportBase"`
	RequestID  int32  `json:"requestId"`
}

type reserveNow201Command struct {
	commandEnvelope
	EVSEID         *int32              `json:"evseId,omitempty"`
	ExpiryDateTime time.Time           `json:"expiryDateTime"`
	ID             int32               `json:"id"`
	IDToken        v201msg.IdTokenType `json:"idToken"`
}

type usePriorityChargingCommand struct {
	commandEnvelope
	Activate      bool   `json:"activate"`
	TransactionID string `json:"transactionId"`
}
