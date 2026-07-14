package io.github.shiv3.ocppsim;

import io.socket.client.Ack;
import io.socket.client.IO;
import io.socket.client.Socket;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Thin blocking wrapper over the daemon's Socket.IO control plane
 * (docs/server.md). Every request/response call goes through the {@code "rpc"}
 * event: emit {@code { cpId?, method, params }} and receive an ack of
 * {@code { ok: true, result }} or {@code { ok: false, error: { code, message } }}.
 * Server-to-client pushes arrive on the {@code "event"} event.
 */
public class SimulatorControlClient implements AutoCloseable {

  private static final long ACK_TIMEOUT_SECONDS = 30;

  private final Socket socket;

  private SimulatorControlClient(Socket socket) {
    this.socket = socket;
  }

  /** Connect to {@code baseUrl} and block until the socket is established. */
  public static SimulatorControlClient connect(String baseUrl)
      throws URISyntaxException, InterruptedException, TimeoutException {
    Socket socket = IO.socket(baseUrl);
    CountDownLatch connected = new CountDownLatch(1);
    AtomicReference<Object> connectError = new AtomicReference<>();

    socket.on(Socket.EVENT_CONNECT, args -> connected.countDown());
    socket.on(
        Socket.EVENT_CONNECT_ERROR,
        args -> {
          connectError.set(args.length > 0 ? args[0] : "unknown connect error");
          connected.countDown();
        });

    socket.connect();
    if (!connected.await(ACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      socket.close();
      throw new TimeoutException("timed out connecting to " + baseUrl);
    }
    if (connectError.get() != null) {
      socket.close();
      throw new IllegalStateException("connect_error: " + connectError.get());
    }
    return new SimulatorControlClient(socket);
  }

  /**
   * Invoke a daemon-level method (no cpId), e.g. {@code cp.create},
   * {@code events.subscribe}. Returns the {@code result} field (a
   * {@link JSONObject}, a {@link String}, or {@code null}); throws on
   * {@code ok: false}.
   */
  public Object rpc(String method, JSONObject params) {
    return rpc(null, method, params);
  }

  /**
   * Invoke a per-CP command method (e.g. {@code load_scenario},
   * {@code run_scenario}, {@code scenario_report}). Returns the {@code result}
   * field; throws on {@code ok: false}.
   */
  public Object rpc(String cpId, String method, JSONObject params) {
    JSONObject request = new JSONObject();
    if (cpId != null) {
      request.put("cpId", cpId);
    }
    request.put("method", method);
    request.put("params", params != null ? params : new JSONObject());

    CompletableFuture<JSONObject> ackFuture = new CompletableFuture<>();
    Ack ack =
        ackArgs -> {
          if (ackArgs.length == 0 || !(ackArgs[0] instanceof JSONObject)) {
            ackFuture.completeExceptionally(
                new IllegalStateException("malformed ack for " + method));
            return;
          }
          ackFuture.complete((JSONObject) ackArgs[0]);
        };
    socket.emit("rpc", request, ack);

    JSONObject ackBody;
    try {
      ackBody = ackFuture.get(ACK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    } catch (Exception e) {
      throw new RuntimeException("rpc " + method + " failed", e);
    }
    if (!ackBody.optBoolean("ok", false)) {
      JSONObject error = ackBody.optJSONObject("error");
      throw new IllegalStateException(
          "rpc " + method + " returned error: " + (error != null ? error : ackBody));
    }
    // JSONObject.NULL is normalized to a real null for the caller's convenience.
    Object result = ackBody.opt("result");
    return JSONObject.NULL.equals(result) ? null : result;
  }

  /** Register a listener for server-to-client {@code "event"} pushes. */
  public void onEvent(Consumer<JSONObject> handler) {
    socket.on(
        "event",
        args -> {
          if (args.length > 0 && args[0] instanceof JSONObject) {
            handler.accept((JSONObject) args[0]);
          }
        });
  }

  @Override
  public void close() {
    socket.disconnect();
    socket.close();
  }
}
