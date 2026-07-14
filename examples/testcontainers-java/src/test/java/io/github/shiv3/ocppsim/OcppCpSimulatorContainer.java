package io.github.shiv3.ocppsim;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

import java.time.Duration;

/**
 * Testcontainers wrapper around the ocpp-cp-simulator daemon image.
 *
 * <p>The image entrypoint starts the daemon with
 * {@code --http-host 0.0.0.0 --unsafe-remote --web-console 9700}, so the
 * Socket.IO control plane and the health endpoint are reachable over the mapped
 * port with no authentication. See {@code docs/server.md} and {@code Dockerfile}.
 *
 * <p>Build the image first from the repository root:
 * <pre>{@code docker build -t ocpp-cp-simulator:local .}</pre>
 * or point {@code OCPP_SIM_IMAGE} at a published tag.
 */
public class OcppCpSimulatorContainer extends GenericContainer<OcppCpSimulatorContainer> {

  /** Daemon port inside the container (Dockerfile: EXPOSE 9700). */
  public static final int DAEMON_PORT = 9700;

  /** Default health path; overridable at image build time via HEALTH_PATH. */
  private static final String HEALTH_PATH = "/v1/healthz";

  /** Overridable so CI can pin a published tag instead of a locally built image. */
  private static final String DEFAULT_IMAGE = "ocpp-cp-simulator:local";

  public OcppCpSimulatorContainer() {
    this(resolveImage());
  }

  public OcppCpSimulatorContainer(String image) {
    super(DockerImageName.parse(image));
    withExposedPorts(DAEMON_PORT);
    // The daemon answers { "ok": true } on the health path once it is ready to
    // accept Socket.IO connections.
    waitingFor(
        Wait.forHttp(HEALTH_PATH)
            .forPort(DAEMON_PORT)
            .forStatusCode(200)
            .withStartupTimeout(Duration.ofSeconds(60)));
  }

  private static String resolveImage() {
    String fromEnv = System.getenv("OCPP_SIM_IMAGE");
    return (fromEnv != null && !fromEnv.isBlank()) ? fromEnv : DEFAULT_IMAGE;
  }

  /** Base HTTP origin for the Socket.IO client, e.g. {@code http://localhost:32768}. */
  public String baseUrl() {
    return "http://" + getHost() + ":" + getMappedPort(DAEMON_PORT);
  }
}
