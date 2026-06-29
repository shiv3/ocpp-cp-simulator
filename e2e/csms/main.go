package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shiv3/gocpp/csms"
)

type versionConfig struct {
	token       string
	subprotocol string
	register    func(*csms.Server, *Recorder) error
}

func main() {
	os.Exit(run())
}

func run() int {
	var version string
	flag.CommandLine.SetOutput(os.Stderr)
	flag.StringVar(&version, "version", "", "OCPP version: 1.6, 2.0.1, or 2.1")
	flag.Parse()

	cfg, err := configForVersion(version)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		return 2
	}

	stdout := bufio.NewWriter(os.Stdout)
	rec := NewRecorder(stdout)
	reg := newRegistry()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ocppListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Error("bind OCPP listener", "error", err)
		return 1
	}
	defer ocppListener.Close()

	controlListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Error("bind HTTP control listener", "error", err)
		return 1
	}
	defer controlListener.Close()

	srv := csms.NewServer(
		csms.WithSubProtocols(cfg.subprotocol),
		csms.WithOnConnect(reg.add),
		csms.WithOnDisconnect(func(conn *csms.Conn, _ error) {
			reg.del(conn)
		}),
		csms.WithLogger(logger),
		// Serialize inbound handler execution so the recorder's NDJSON `seq`
		// reflects true WIRE/receive order. gocpp dispatches each inbound CALL
		// on its own goroutine (core/dispatcher/conn.go: `go c.runHandler`),
		// so without this, two frames sent back-to-back (e.g. TransactionEvent
		// Started immediately followed by MeterValues from a scenario) can be
		// RECORDED in either order — making seq-based ordering assertions flaky.
		// A global limit of 1 makes the dispatch loop process c.in strictly in
		// FIFO/wire order. Fine for a low-volume single-CP-per-test fixture.
		csms.WithGlobalConcurrencyLimit(1),
	)
	if err := cfg.register(srv, rec); err != nil {
		logger.Error("register CSMS handlers", "version", cfg.token, "error", err)
		return 1
	}

	ocppHTTP := &http.Server{Handler: srv.Handler()}
	controlHTTP := &http.Server{Handler: newControlHandler(cfg.token, reg)}
	errCh := make(chan error, 2)

	go serveHTTP(errCh, "ocpp", ocppHTTP, ocppListener)
	go serveHTTP(errCh, "control", controlHTTP, controlListener)

	if _, err := fmt.Fprintf(stdout, "E2E_CSMS_PORTS {\"ocpp\":%d,\"http\":%d}\n", listenerPort(ocppListener), listenerPort(controlListener)); err != nil {
		logger.Error("write ports sentinel", "error", err)
		return 1
	}
	if err := stdout.Flush(); err != nil {
		logger.Error("flush ports sentinel", "error", err)
		return 1
	}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	exitCode := 0
	select {
	case sig := <-sigCh:
		logger.Info("shutdown requested", "signal", sig.String())
	case err := <-errCh:
		logger.Error("server stopped", "error", err)
		exitCode = 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := controlHTTP.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("shutdown control server", "error", err)
		exitCode = 1
	}
	if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("shutdown CSMS", "error", err)
		exitCode = 1
	}
	if err := ocppHTTP.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("shutdown OCPP server", "error", err)
		exitCode = 1
	}
	if err := rec.Flush(); err != nil {
		logger.Error("flush stdout", "error", err)
		exitCode = 1
	}

	return exitCode
}

func configForVersion(version string) (versionConfig, error) {
	switch version {
	case "1.6":
		return versionConfig{token: version, subprotocol: "ocpp1.6", register: register16}, nil
	case "2.0.1":
		return versionConfig{token: version, subprotocol: "ocpp2.0.1", register: register201}, nil
	case "2.1":
		return versionConfig{token: version, subprotocol: "ocpp2.1", register: register21}, nil
	default:
		return versionConfig{}, fmt.Errorf("unsupported --version %q; expected 1.6, 2.0.1, or 2.1", version)
	}
}

func serveHTTP(errCh chan<- error, name string, server *http.Server, listener net.Listener) {
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		errCh <- fmt.Errorf("%s server: %w", name, err)
	}
}

func listenerPort(listener net.Listener) int {
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0
	}
	return addr.Port
}
