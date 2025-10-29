import React, { useState, useEffect } from "react";
import { Modal } from "flowbite-react";
import { Node } from "@xyflow/react";
import {
  ScenarioNodeType,
  StatusChangeNodeData,
  TransactionNodeData,
  MeterValueNodeData,
  DelayNodeData,
  NotificationNodeData,
  ConnectorPlugNodeData,
} from "../../cp/types/ScenarioTypes";
import { OCPPStatus } from "../../cp/OcppTypes";

interface NodeConfigPanelProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (nodeId: string, newData: any) => void;
}

const NodeConfigPanel: React.FC<NodeConfigPanelProps> = ({
  node,
  isOpen,
  onClose,
  onSave,
}) => {
  const [formData, setFormData] = useState<any>({});

  useEffect(() => {
    if (node) {
      setFormData({ ...node.data });
    }
  }, [node]);

  if (!node) return null;

  const handleSave = () => {
    onSave(node.id, formData);
    onClose();
  };

  const renderConfigForm = () => {
    switch (node.type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Status
              </label>
              <select
                className="input-base w-full"
                value={formData.status || OCPPStatus.Available}
                onChange={(e) =>
                  setFormData({ ...formData, status: e.target.value })
                }
              >
                {Object.values(OCPPStatus).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.TRANSACTION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Action
              </label>
              <select
                className="input-base w-full"
                value={formData.action || "start"}
                onChange={(e) =>
                  setFormData({ ...formData, action: e.target.value })
                }
              >
                <option value="start">Start Transaction</option>
                <option value="stop">Stop Transaction</option>
              </select>
            </div>
            {formData.action === "start" && (
              <div>
                <label className="block text-sm font-semibold text-primary mb-1">
                  Tag ID
                </label>
                <input
                  type="text"
                  className="input-base w-full"
                  value={formData.tagId || ""}
                  onChange={(e) =>
                    setFormData({ ...formData, tagId: e.target.value })
                  }
                  placeholder="RFID123456"
                />
              </div>
            )}
          </div>
        );

      case ScenarioNodeType.METER_VALUE:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Value (Wh)
              </label>
              <input
                type="number"
                className="input-base w-full"
                value={formData.value || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    value: parseInt(e.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendMessage"
                checked={formData.sendMessage || false}
                onChange={(e) =>
                  setFormData({ ...formData, sendMessage: e.target.checked })
                }
                className="w-4 h-4"
              />
              <label
                htmlFor="sendMessage"
                className="text-sm font-semibold text-primary"
              >
                Send MeterValue Message
              </label>
            </div>
          </div>
        );

      case ScenarioNodeType.DELAY:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Delay (seconds)
              </label>
              <input
                type="number"
                className="input-base w-full"
                value={formData.delaySeconds || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    delaySeconds: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.NOTIFICATION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Message Type
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.messageType || ""}
                onChange={(e) =>
                  setFormData({ ...formData, messageType: e.target.value })
                }
                placeholder="e.g., Heartbeat, DataTransfer"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Payload (JSON)
              </label>
              <textarea
                className="input-base w-full font-mono text-xs"
                rows={6}
                value={
                  typeof formData.payload === "string"
                    ? formData.payload
                    : JSON.stringify(formData.payload || {}, null, 2)
                }
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    setFormData({ ...formData, payload: parsed });
                  } catch {
                    setFormData({ ...formData, payload: e.target.value });
                  }
                }}
                placeholder='{"key": "value"}'
              />
            </div>
          </div>
        );

      case ScenarioNodeType.CONNECTOR_PLUG:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Action
              </label>
              <select
                className="input-base w-full"
                value={formData.action || "plugin"}
                onChange={(e) =>
                  setFormData({ ...formData, action: e.target.value })
                }
              >
                <option value="plugin">Plugin (接続)</option>
                <option value="plugout">Plugout (切断)</option>
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-primary mb-1">
                Timeout (seconds)
              </label>
              <input
                type="number"
                className="input-base w-full"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted mt-1">
                0 = No timeout (wait indefinitely for RemoteStartTransaction)
              </p>
            </div>
          </div>
        );

      default:
        return (
          <div className="text-sm text-muted">
            This node type does not have configurable properties.
          </div>
        );
    }
  };

  const getNodeTypeName = (type: string) => {
    switch (type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return "Status Change";
      case ScenarioNodeType.TRANSACTION:
        return "Transaction";
      case ScenarioNodeType.METER_VALUE:
        return "Meter Value";
      case ScenarioNodeType.DELAY:
        return "Delay";
      case ScenarioNodeType.NOTIFICATION:
        return "Notification";
      case ScenarioNodeType.CONNECTOR_PLUG:
        return "Connector Plug";
      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return "Remote Start Trigger";
      default:
        return "Node";
    }
  };

  return (
    <Modal show={isOpen} onClose={onClose} size="md">
      <Modal.Header>
        <span className="text-primary font-bold">
          Configure {getNodeTypeName(node.type || "")}
        </span>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">{renderConfigForm()}</div>
      </Modal.Body>
      <Modal.Footer>
        <div className="flex gap-2 justify-end w-full">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={handleSave} className="btn-primary">
            Save
          </button>
        </div>
      </Modal.Footer>
    </Modal>
  );
};

export default NodeConfigPanel;
