---
title: Web console tour
type: entity
summary: A recorded walkthrough of the web console in Remote mode against SteVe — one inline video and screenshots per feature (settings, fleet and labels, charging, remote start, labels, network faults, Expert, session analysis, scenarios, history and logs).
sources:
  - docs/images/tour/
  - "issue #494"
related:
  - web-console.md
  - ../concepts/operational-timeline.md
  - ../concepts/network-simulation.md
  - ../concepts/scenario-format.md
  - ../concepts/charging-sessions.md
updated: 2026-10-30
---

# Web console tour

A feature-by-feature walkthrough of the [web console](web-console.md), recorded
in Remote mode against a daemon whose charge points `WEBCP001` and `WEBCP002`
(OCPP 1.6J) are connected to [SteVe](https://github.com/steve-community/steve)
3.14.1. Each recording plays inline on GitHub (click to play); the screenshots
under it show its key states. The recordings are MP4 attachments embedded as
bare `user-attachments` URLs, so they play on github.com only.

## Settings: TagIDs and network simulation

The TagIDs the connector card offers for **Start charging** (here the ones SteVe knows), and the global network-simulation layer.

https://github.com/user-attachments/assets/b79b0bb3-5172-4cfe-a376-9bd89232930b

<details>
<summary>Screenshots</summary>

![Settings — RFID TagIDs](../images/tour/01-settings-1-tag-ids.png)

</details>

## Fleet: charge points, connectors and labels

Every charge point the daemon runs, as a hierarchy, a charge point list or a connector list, filtered by status, OCPP version or label (`site=tokyo-01`).

https://github.com/user-attachments/assets/bae86d0e-40f5-41a7-a8fc-102b38b26296

<details>
<summary>Screenshots</summary>

![Fleet — hierarchy](../images/tour/02-fleet-1-hierarchy.png)

![Fleet — filtered by label](../images/tour/02-fleet-3-label-filter.png)

</details>

## A charging session from the connector card

**Plug in → Start charging → Stop charging**: the connector card drives a real OCPP 1.6J transaction against SteVe, with the auto meter feeding power, energy and SoC; the **Transactions** tab keeps the session.

https://github.com/user-attachments/assets/ddc2b067-2c41-4a48-ab4d-12adf82e0df6

<details>
<summary>Screenshots</summary>

![Connector charging](../images/tour/03-charging-1-charging.png)

![Transactions tab](../images/tour/03-charging-2-transactions.png)

</details>

## Remote start from the CSMS

SteVe sends **RemoteStartTransaction**; the charge point's _Essential CP Behavior_ scenario plugs in, starts the transaction and meters it, and the operational timeline records each step.

https://github.com/user-attachments/assets/8c75baf7-67d1-415d-8c4e-a9c6c1419afd

<details>
<summary>Screenshots</summary>

![SteVe — RemoteStartTransaction](../images/tour/04-remote-start-1-steve-remote-start.png)

![The charge point charging after the remote start](../images/tour/04-remote-start-3-console-charging.png)

</details>

## Labels, edited in place

Relabel a charge point from its header (`cp.labels.set`): no reconnect, the chips update at once.

https://github.com/user-attachments/assets/24f75863-1b95-4ceb-b0f9-15d004d11828

<details>
<summary>Screenshots</summary>

![Labels saved](../images/tour/05-labels-2-saved.png)

</details>

## Network faults and recovery

Per-charge-point rules (here a 300 ms latency and a manual disconnect); the **Operational events** tab ties the injected fault, the reconnect, the boot and `recovery_completed` into one incident.

https://github.com/user-attachments/assets/dd905829-4e6c-4448-a955-36c48dcf8ea9

<details>
<summary>Screenshots</summary>

![Network simulation rules](../images/tour/06-network-fault-1-rules.png)

![Incident and recovery on the operational timeline](../images/tour/06-network-fault-2-incident-and-recovery.png)

</details>

## Expert: any station-initiated call

Send any OCPP call the station can send (here a DataTransfer) through the live connection and see the CSMS's answer.

https://github.com/user-attachments/assets/e503d6dd-bc22-45eb-b1d2-abe1a84f900e

<details>
<summary>Screenshots</summary>

![Expert tab — DataTransfer answered](../images/tour/07-expert-1-result.png)

</details>

## Session analysis

OCPP DebugKit's failure-pattern analysis over the charge point's stored logs, in the browser.

https://github.com/user-attachments/assets/25bbd716-5ccc-4790-9f75-d2afc0810f77

<details>
<summary>Screenshots</summary>

![Session analysis result](../images/tour/08-session-analysis-1-result.png)

</details>

## Scenarios

Running scenarios per connector and their steps, the template library (54 templates), and the scenario editor's steps and graph views.

https://github.com/user-attachments/assets/f4711591-40b3-489e-8014-b2ddb3940ad7

<details>
<summary>Screenshots</summary>

![Active scenario runs](../images/tour/09-scenarios-1-active-runs.png)

![A running scenario's steps](../images/tour/09-scenarios-2-run-panel.png)

![Scenario editor — graph view](../images/tour/09-scenarios-8-template-graph.png)

![Template browser](../images/tour/09-scenarios-4-templates.png)

</details>

## Run history and message log

Past scenario runs with their verdicts, and every OCPP frame across charge points, filterable by charge point, level, type and connector.

https://github.com/user-attachments/assets/9d074d50-8583-4ccd-ace1-e3c77be45f64

<details>
<summary>Screenshots</summary>

![Run history](../images/tour/10-history-and-logs-1-run-history.png)

![Message log](../images/tour/10-history-and-logs-2-message-log.png)

</details>
