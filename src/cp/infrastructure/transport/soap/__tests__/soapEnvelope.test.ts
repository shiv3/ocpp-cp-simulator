import { describe, expect, it } from "vitest";

import {
  buildSoapEnvelope,
  OCPP15_SOAP_NAMESPACES,
  parseSoapFaultEnvelope,
  parseSoapEnvelope,
  soapContentTypeForOperation,
  WSA_ANONYMOUS_ADDRESS,
} from "../soapEnvelope";
import { OCPP12_DIALECT, OCPP12_SOAP_NAMESPACES } from "../dialect";

const CHARGE_BOX_IDENTITY = "CP-001";
const CALLBACK_URL =
  "http://127.0.0.1:9700/ocpp/soap/CP-001/ChargePointService";
const CENTRAL_SYSTEM_URL =
  "http://127.0.0.1:8180/steve/services/CentralSystemService";

describe("OCPP 1.5 SOAP envelope builder", () => {
  it("builds the exact BootNotification request envelope", () => {
    const xml = buildSoapEnvelope({
      operation: "BootNotification",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      messageId: "uuid:boot-1",
      from: CALLBACK_URL,
      to: CENTRAL_SYSTEM_URL,
      payload: {
        meterSerialNumber: "Meter-Serial",
        meterType: "AC",
        imsi: "IMSI",
        iccid: "ICCID",
        firmwareVersion: "1.2.3",
        chargeBoxSerialNumber: "Box-Serial",
        chargePointSerialNumber: "Point-Serial",
        chargePointModel: "Model-A",
        chargePointVendor: "Vendor-A",
      },
    });

    expect(xml).toBe(
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:cs="urn://Ocpp/Cs/2012/06/"><s:Header><cs:chargeBoxIdentity>CP-001</cs:chargeBoxIdentity><a:Action s:mustUnderstand="true">/BootNotification</a:Action><a:MessageID s:mustUnderstand="true">uuid:boot-1</a:MessageID><a:From s:mustUnderstand="true"><a:Address>http://127.0.0.1:9700/ocpp/soap/CP-001/ChargePointService</a:Address></a:From><a:ReplyTo s:mustUnderstand="true"><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="true">http://127.0.0.1:8180/steve/services/CentralSystemService</a:To></s:Header><s:Body><cs:bootNotificationRequest><cs:chargePointVendor>Vendor-A</cs:chargePointVendor><cs:chargePointModel>Model-A</cs:chargePointModel><cs:chargePointSerialNumber>Point-Serial</cs:chargePointSerialNumber><cs:chargeBoxSerialNumber>Box-Serial</cs:chargeBoxSerialNumber><cs:firmwareVersion>1.2.3</cs:firmwareVersion><cs:iccid>ICCID</cs:iccid><cs:imsi>IMSI</cs:imsi><cs:meterType>AC</cs:meterType><cs:meterSerialNumber>Meter-Serial</cs:meterSerialNumber></cs:bootNotificationRequest></s:Body></s:Envelope>',
    );
    expect(soapContentTypeForOperation("BootNotification")).toBe(
      'application/soap+xml; charset=utf-8; action="/BootNotification"',
    );
  });

  it("builds the exact Heartbeat request envelope", () => {
    const xml = buildSoapEnvelope({
      operation: "Heartbeat",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      messageId: "uuid:heartbeat-1",
      from: CALLBACK_URL,
      to: CENTRAL_SYSTEM_URL,
    });

    expect(xml).toBe(
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:cs="urn://Ocpp/Cs/2012/06/"><s:Header><cs:chargeBoxIdentity>CP-001</cs:chargeBoxIdentity><a:Action s:mustUnderstand="true">/Heartbeat</a:Action><a:MessageID s:mustUnderstand="true">uuid:heartbeat-1</a:MessageID><a:From s:mustUnderstand="true"><a:Address>http://127.0.0.1:9700/ocpp/soap/CP-001/ChargePointService</a:Address></a:From><a:ReplyTo s:mustUnderstand="true"><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="true">http://127.0.0.1:8180/steve/services/CentralSystemService</a:To></s:Header><s:Body><cs:heartbeatRequest/></s:Body></s:Envelope>',
    );
  });
});

describe("OCPP 1.5 SOAP envelope parser", () => {
  it("parses a BootNotification response with heartbeatInterval", () => {
    const parsed = parseSoapEnvelope(
      `<s:Envelope xmlns:s="${OCPP15_SOAP_NAMESPACES.SOAP12}" xmlns:a="${OCPP15_SOAP_NAMESPACES.WSA}" xmlns:cs="${OCPP15_SOAP_NAMESPACES.CS}"><s:Header><cs:chargeBoxIdentity>CP-001</cs:chargeBoxIdentity><a:Action s:mustUnderstand="true">/BootNotificationResponse</a:Action><a:MessageID s:mustUnderstand="true">uuid:boot-conf-1</a:MessageID><a:From s:mustUnderstand="true"><a:Address>${CENTRAL_SYSTEM_URL}</a:Address></a:From><a:ReplyTo s:mustUnderstand="true"><a:Address>${WSA_ANONYMOUS_ADDRESS}</a:Address></a:ReplyTo><a:To s:mustUnderstand="true">${CALLBACK_URL}</a:To><a:RelatesTo s:mustUnderstand="true">uuid:boot-1</a:RelatesTo></s:Header><s:Body><cs:bootNotificationResponse><cs:status>Accepted</cs:status><cs:currentTime>2026-06-30T00:00:00Z</cs:currentTime><cs:heartbeatInterval>300</cs:heartbeatInterval></cs:bootNotificationResponse></s:Body></s:Envelope>`,
    );

    expect(parsed).toMatchObject({
      operation: "BootNotification",
      kind: "response",
      action: "/BootNotificationResponse",
      messageId: "uuid:boot-conf-1",
      relatesTo: "uuid:boot-1",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      namespace: OCPP15_SOAP_NAMESPACES.CS,
      wrapper: "bootNotificationResponse",
      payload: {
        status: "Accepted",
        currentTime: "2026-06-30T00:00:00Z",
        heartbeatInterval: "300",
      },
    });
    expect(parsed.payload).not.toHaveProperty("interval");
  });

  it("parses a CSMS-to-CP RemoteStartTransaction request", () => {
    const parsed = parseSoapEnvelope(
      `<s:Envelope xmlns:s="${OCPP15_SOAP_NAMESPACES.SOAP12}" xmlns:a="${OCPP15_SOAP_NAMESPACES.WSA}" xmlns:cp="${OCPP15_SOAP_NAMESPACES.CP}"><s:Header><cp:chargeBoxIdentity>CP-001</cp:chargeBoxIdentity><a:Action s:mustUnderstand="true">/RemoteStartTransaction</a:Action><a:MessageID s:mustUnderstand="true">uuid:remote-start-1</a:MessageID><a:From s:mustUnderstand="true"><a:Address>${CENTRAL_SYSTEM_URL}</a:Address></a:From><a:ReplyTo s:mustUnderstand="true"><a:Address>${WSA_ANONYMOUS_ADDRESS}</a:Address></a:ReplyTo><a:To s:mustUnderstand="true">${CALLBACK_URL}</a:To></s:Header><s:Body><cp:remoteStartTransactionRequest><cp:idTag>TAG-DEMO</cp:idTag><cp:connectorId>1</cp:connectorId></cp:remoteStartTransactionRequest></s:Body></s:Envelope>`,
    );

    expect(parsed).toMatchObject({
      operation: "RemoteStartTransaction",
      kind: "request",
      action: "/RemoteStartTransaction",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      namespace: OCPP15_SOAP_NAMESPACES.CP,
      wrapper: "remoteStartTransactionRequest",
      payload: {
        idTag: "TAG-DEMO",
        connectorId: "1",
      },
    });
  });

  it("rejects DOCTYPE and entity-bearing XML before parsing", () => {
    expect(() =>
      parseSoapEnvelope(
        `<!DOCTYPE s:Envelope [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><s:Envelope xmlns:s="${OCPP15_SOAP_NAMESPACES.SOAP12}" xmlns:a="${OCPP15_SOAP_NAMESPACES.WSA}" xmlns:cs="${OCPP15_SOAP_NAMESPACES.CS}"><s:Header><cs:chargeBoxIdentity>&xxe;</cs:chargeBoxIdentity></s:Header><s:Body><cs:heartbeatRequest/></s:Body></s:Envelope>`,
      ),
    ).toThrow(/DOCTYPE or ENTITY/);
  });

  it("parses a SOAP 1.2 Fault with detail", () => {
    const parsed = parseSoapFaultEnvelope(
      `<s:Envelope xmlns:s="${OCPP15_SOAP_NAMESPACES.SOAP12}"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">Rejected by CSMS</s:Text></s:Reason><s:Detail><m:error xmlns:m="urn:test"><m:code>E42</m:code></m:error></s:Detail></s:Fault></s:Body></s:Envelope>`,
    );

    expect(parsed).toEqual({
      code: "s:Sender",
      reason: "Rejected by CSMS",
      detail: {
        error: {
          code: "E42",
        },
      },
    });
  });
});

describe("OCPP 1.2 SOAP envelope builder", () => {
  it("builds a BootNotification request with 1.2 namespace", () => {
    const xml = buildSoapEnvelope({
      operation: "BootNotification",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      messageId: "uuid:boot-12-1",
      from: CALLBACK_URL,
      to: CENTRAL_SYSTEM_URL,
      payload: {
        chargePointVendor: "Vendor-A",
        chargePointModel: "Model-A",
        chargePointSerialNumber: "Point-Serial",
        chargeBoxSerialNumber: "Box-Serial",
        firmwareVersion: "1.2.3",
      },
      dialect: OCPP12_DIALECT,
    });

    // Assert 1.2 CS namespace in output
    expect(xml).toContain(`xmlns:cs="${OCPP12_SOAP_NAMESPACES.CS}"`);
    expect(xml).not.toContain(OCPP15_SOAP_NAMESPACES.CS);
    expect(xml).toContain("<cs:bootNotificationRequest>");
  });

  it("throws when trying to build DataTransfer with 1.2 dialect", () => {
    expect(() =>
      buildSoapEnvelope({
        operation: "DataTransfer",
        chargeBoxIdentity: CHARGE_BOX_IDENTITY,
        messageId: "uuid:dt-1",
        from: CALLBACK_URL,
        to: CENTRAL_SYSTEM_URL,
        payload: { vendorId: "test" },
        dialect: OCPP12_DIALECT,
      }),
    ).toThrow(
      /not available.*DataTransfer|operation.*not.*available|OCPP-1.2/i,
    );
  });
});

describe("OCPP 1.2 SOAP envelope parser", () => {
  it("parses a 1.2 Reset request with 1.2 CP namespace", () => {
    const parsed = parseSoapEnvelope(
      `<s:Envelope xmlns:s="${OCPP12_SOAP_NAMESPACES.SOAP12}" xmlns:a="${OCPP12_SOAP_NAMESPACES.WSA}" xmlns:cp="${OCPP12_SOAP_NAMESPACES.CP}"><s:Header><cp:chargeBoxIdentity>CP-001</cp:chargeBoxIdentity><a:Action s:mustUnderstand="true">/Reset</a:Action><a:MessageID s:mustUnderstand="true">uuid:reset-1</a:MessageID><a:From s:mustUnderstand="true"><a:Address>${CENTRAL_SYSTEM_URL}</a:Address></a:From><a:ReplyTo s:mustUnderstand="true"><a:Address>${WSA_ANONYMOUS_ADDRESS}</a:Address></a:ReplyTo><a:To s:mustUnderstand="true">${CALLBACK_URL}</a:To></s:Header><s:Body><cp:resetRequest><cp:type>Hard</cp:type></cp:resetRequest></s:Body></s:Envelope>`,
      OCPP12_DIALECT,
    );

    expect(parsed).toMatchObject({
      operation: "Reset",
      kind: "request",
      action: "/Reset",
      chargeBoxIdentity: CHARGE_BOX_IDENTITY,
      namespace: OCPP12_SOAP_NAMESPACES.CP,
      wrapper: "resetRequest",
      payload: {
        type: "Hard",
      },
    });
  });
});
