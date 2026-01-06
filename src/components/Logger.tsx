import React, { useEffect, useRef, useState, useMemo } from "react";
import { LogEntry, LogLevel, LogType } from "../cp/shared/Logger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface LoggerProps {
  logs: LogEntry[];
  onClear?: () => void;
}

const Logger: React.FC<LoggerProps> = ({ logs, onClear }) => {
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | "ALL">("ALL");
  const [selectedTypes, setSelectedTypes] = useState<Set<LogType>>(
    new Set(Object.values(LogType)),
  );
  const [searchText, setSearchText] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // Filter logs based on level, types, and search text
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Filter by level
      if (selectedLevel !== "ALL" && log.level < selectedLevel) {
        return false;
      }
      // Filter by type
      if (!selectedTypes.has(log.type)) {
        return false;
      }
      // Filter by search text
      if (
        searchText &&
        !log.message.toLowerCase().includes(searchText.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [logs, selectedLevel, selectedTypes, searchText]);

  // Calculate statistics
  const stats = useMemo(() => {
    const byLevel: Record<string, number> = {};
    const byType: Record<string, number> = {};
    logs.forEach((log) => {
      const levelName = LogLevel[log.level];
      const typeName = log.type;
      byLevel[levelName] = (byLevel[levelName] || 0) + 1;
      byType[typeName] = (byType[typeName] || 0) + 1;
    });
    return { total: logs.length, byLevel, byType };
  }, [logs]);

  const toggleType = (type: LogType) => {
    setSelectedTypes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        newSet.delete(type);
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  };

  const selectAllTypes = () => {
    setSelectedTypes(new Set(Object.values(LogType)));
  };

  const deselectAllTypes = () => {
    setSelectedTypes(new Set());
  };

  return (
    <div className="logger-container">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-xl font-semibold">Logs</h3>
        <div className="flex gap-2 items-center">
          <Badge>
            Total: {stats.total} | Filtered: {filteredLogs.length}
          </Badge>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={autoScroll}
              onCheckedChange={(checked) => setAutoScroll(checked as boolean)}
            />
            Auto-scroll
          </label>
          {onClear && (
            <Button size="sm" variant="secondary" onClick={onClear}>
              Clear Logs
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        {/* Level Filter */}
        <div className="space-y-2">
          <Label htmlFor="level-filter">Log Level</Label>
          <Select
            value={selectedLevel.toString()}
            onValueChange={(value) =>
              setSelectedLevel(
                value === "ALL" ? "ALL" : (Number(value) as LogLevel),
              )
            }
          >
            <SelectTrigger id="level-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Levels</SelectItem>
              <SelectItem value={LogLevel.DEBUG.toString()}>DEBUG and above</SelectItem>
              <SelectItem value={LogLevel.INFO.toString()}>INFO and above</SelectItem>
              <SelectItem value={LogLevel.WARN.toString()}>WARN and above</SelectItem>
              <SelectItem value={LogLevel.ERROR.toString()}>ERROR only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Search Filter */}
        <div className="space-y-2">
          <Label htmlFor="search-filter">Search</Label>
          <Input
            id="search-filter"
            type="text"
            placeholder="Search logs..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>

        {/* Type Statistics */}
        <div className="space-y-2">
          <Label>Statistics</Label>
          <div className="flex flex-wrap gap-1">
            {Object.entries(stats.byType).map(([type, count]) => (
              <Badge key={type} variant="secondary" className="text-xs">
                {type}: {count}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Type Filters */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-2">
          <Label>Log Types</Label>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={selectAllTypes}>
              All
            </Button>
            <Button size="sm" variant="secondary" onClick={deselectAllTypes}>
              None
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.values(LogType).map((type) => (
            <Badge
              key={type}
              variant={selectedTypes.has(type) ? "default" : "secondary"}
              className="cursor-pointer"
              onClick={() => toggleType(type)}
            >
              {type} ({stats.byType[type] || 0})
            </Badge>
          ))}
        </div>
      </div>

      {/* Log Display */}
      <AutoScrollingLogDisplay
        logs={filteredLogs}
        autoScroll={autoScroll}
      />
    </div>
  );
};

export default Logger;

interface AutoScrollingLogDisplayProps {
  logs: LogEntry[];
  autoScroll: boolean;
}

const AutoScrollingLogDisplay: React.FC<AutoScrollingLogDisplayProps> = ({
  logs,
  autoScroll,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [logs, autoScroll]);

  const getLogLevelColor = (level: LogLevel): string => {
    switch (level) {
      case LogLevel.DEBUG:
        return "log-level-debug";
      case LogLevel.INFO:
        return "log-level-info";
      case LogLevel.WARN:
        return "log-level-warn";
      case LogLevel.ERROR:
        return "log-level-error";
      default:
        return "text-primary";
    }
  };

  const getLogTypeColor = (type: LogType): string => {
    switch (type) {
      case LogType.WEBSOCKET:
        return "log-websocket";
      case LogType.OCPP:
        return "log-ocpp";
      case LogType.TRANSACTION:
        return "log-transaction";
      case LogType.HEARTBEAT:
        return "log-heartbeat";
      case LogType.METER_VALUE:
        return "log-meter-value";
      case LogType.STATUS:
        return "log-status";
      case LogType.CONFIGURATION:
        return "log-configuration";
      case LogType.DIAGNOSTICS:
        return "log-diagnostics";
      default:
        return "log-general";
    }
  };

  return (
    <div ref={containerRef} className="logger-display">
      {logs.length === 0 ? (
        <div className="text-muted text-center py-8">No logs to display</div>
      ) : (
        logs.map((log, index) => (
          <div key={index} className="logger-log-line">
            <span className="text-muted">
              {log.timestamp.toISOString().substring(11, 23)}
            </span>{" "}
            <span className={`font-semibold ${getLogLevelColor(log.level)}`}>
              [{LogLevel[log.level]}]
            </span>{" "}
            <span className={`px-1 py-0.5 rounded text-xs ${getLogTypeColor(log.type)}`}>
              {log.type}
            </span>{" "}
            <span className="text-primary">{log.message}</span>
          </div>
        ))
      )}
    </div>
  );
};
