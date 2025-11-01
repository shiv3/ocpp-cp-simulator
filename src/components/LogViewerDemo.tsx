import { useState, useEffect } from 'react';
import { LogViewer } from '@/components/ui/log-viewer';
import { Logger, LogLevel, LogType, LogEntry } from '@/cp/shared/Logger';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function LogViewerDemo() {
  const [logger] = useState(() => new Logger(LogLevel.DEBUG));
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    // Subscribe to all log events
    const unsubscribe = logger.on('log', (entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    return unsubscribe;
  }, [logger]);

  const addSampleLogs = () => {
    logger.debug('WebSocket connection established', LogType.WEBSOCKET);
    logger.info('OCPP handshake completed', LogType.OCPP);
    logger.info('BootNotification sent', LogType.OCPP);
    logger.debug('Heartbeat sent', LogType.HEARTBEAT);
    logger.info('Transaction started with ID: 12345', LogType.TRANSACTION);
    logger.debug('Meter value: 1234.5 kWh', LogType.METER_VALUE);
    logger.warn('Low battery warning', LogType.STATUS);
    logger.error('Failed to send StatusNotification', LogType.STATUS);
    logger.info('Configuration updated: HeartbeatInterval = 60', LogType.CONFIGURATION);
    logger.debug('Diagnostics data collected', LogType.DIAGNOSTICS);
    logger.info('Scenario step completed: Connect to CSMS', LogType.SCENARIO);
  };

  const handleClear = () => {
    logger.clearLogs();
    setLogs([]);
  };

  return (
    <div className="container mx-auto p-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Log Viewer Demo</CardTitle>
          <CardDescription>
            A structured log viewer component with filtering capabilities for OCPP charge point simulator
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={addSampleLogs}>Add Sample Logs</Button>
            <Button variant="outline" onClick={handleClear}>
              Clear All
            </Button>
          </div>

          <LogViewer logs={logs} onClear={handleClear} maxHeight="600px" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Features</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
            <li>Filter logs by text search</li>
            <li>Filter by log level (DEBUG, INFO, WARN, ERROR)</li>
            <li>Filter by log type (WEBSOCKET, OCPP, TRANSACTION, etc.)</li>
            <li>Auto-scroll to latest logs (toggleable)</li>
            <li>Color-coded badges for easy identification</li>
            <li>Real-time log updates via EventEmitter2</li>
            <li>Responsive design with sticky headers</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
