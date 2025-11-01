import React, { useState, useEffect, useCallback } from "react";
import { StateHistoryEntry } from "../../cp/application/services/types/StateSnapshot";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

interface StateTransitionTimelineProps {
  history: StateHistoryEntry[];
  onSelectTransition: React.Dispatch<React.SetStateAction<number>>;
  currentIndex: number;
}

const StateTransitionTimeline: React.FC<StateTransitionTimelineProps> = ({
  history,
  onSelectTransition,
  currentIndex,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isLooping, setIsLooping] = useState(false);

  // Auto-play logic
  useEffect(() => {
    if (!isPlaying || history.length === 0) return;

    const interval = setInterval(() => {
      onSelectTransition((prev) => {
        const next = prev + 1;
        if (next >= history.length) {
          if (isLooping) {
            return 0;
          } else {
            setIsPlaying(false);
            return prev;
          }
        }
        return next;
      });
    }, 1000 / playbackSpeed);

    return () => clearInterval(interval);
  }, [isPlaying, playbackSpeed, isLooping, history.length, onSelectTransition]);

  const handlePlayPause = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handlePrevious = useCallback(() => {
    setIsPlaying(false);
    onSelectTransition(Math.max(0, currentIndex - 1));
  }, [currentIndex, onSelectTransition]);

  const handleNext = useCallback(() => {
    setIsPlaying(false);
    onSelectTransition(Math.min(history.length - 1, currentIndex + 1));
  }, [currentIndex, history.length, onSelectTransition]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = x / rect.width;
      const index = Math.floor(percentage * history.length);
      setIsPlaying(false);
      onSelectTransition(Math.max(0, Math.min(history.length - 1, index)));
    },
    [history.length, onSelectTransition],
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case OCPPStatus.Available:
        return "bg-green-400";
      case OCPPStatus.Preparing:
        return "bg-yellow-400";
      case OCPPStatus.Charging:
        return "bg-emerald-500";
      case OCPPStatus.SuspendedEV:
      case OCPPStatus.SuspendedEVSE:
        return "bg-orange-400";
      case OCPPStatus.Finishing:
        return "bg-cyan-400";
      case OCPPStatus.Reserved:
        return "bg-purple-400";
      case OCPPStatus.Unavailable:
        return "bg-gray-500";
      case OCPPStatus.Faulted:
        return "bg-red-500";
      default:
        return "bg-gray-300";
    }
  };

  const getTransitionLabel = (entry: StateHistoryEntry) => {
    return `${entry.fromState} → ${entry.toState}`;
  };

  const formatTimestamp = (date: Date) => {
    return new Date(date).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  if (history.length === 0) {
    return (
      <div className="p-4 text-center text-muted">
        No state transition history yet
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
      {/* Playback Controls */}
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3 mb-2">
          {/* Previous */}
          <button
            onClick={handlePrevious}
            disabled={currentIndex === 0}
            className="btn-secondary text-xs px-2 py-1 disabled:opacity-30"
            title="Previous"
          >
            ⏮️
          </button>

          {/* Play/Pause */}
          <button
            onClick={handlePlayPause}
            className="btn-primary text-xs px-3 py-1"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "⏸️" : "⏯️"}
          </button>

          {/* Next */}
          <button
            onClick={handleNext}
            disabled={currentIndex === history.length - 1}
            className="btn-secondary text-xs px-2 py-1 disabled:opacity-30"
            title="Next"
          >
            ⏭️
          </button>

          {/* Loop */}
          <button
            onClick={() => setIsLooping((prev) => !prev)}
            className={`text-xs px-2 py-1 rounded ${
              isLooping
                ? "bg-blue-500 text-white"
                : "bg-gray-200 dark:bg-gray-700 text-primary"
            }`}
            title="Loop playback"
          >
            🔄
          </button>

          {/* Speed Control */}
          <select
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            className="input-base text-xs py-1 px-2"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>

          {/* Current Position */}
          <span className="text-xs text-muted ml-auto">
            {currentIndex + 1} / {history.length}
          </span>
        </div>

        {/* Progress Bar */}
        <div
          className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full cursor-pointer overflow-hidden"
          onClick={handleProgressClick}
        >
          <div
            className="h-full bg-blue-500 transition-all"
            style={{
              width: `${((currentIndex + 1) / history.length) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* History List */}
      <div className="flex-1 overflow-y-auto p-3">
        <h3 className="text-xs font-semibold text-primary mb-2">
          📋 Transition History
        </h3>
        <div className="space-y-2">
          {history.map((entry, index) => (
            <div
              key={entry.id}
              onClick={() => {
                setIsPlaying(false);
                onSelectTransition(index);
              }}
              className={`p-2 rounded cursor-pointer transition-colors ${
                index === currentIndex
                  ? "bg-blue-100 dark:bg-blue-900 border-2 border-blue-500"
                  : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750"
              }`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted font-mono">
                  {formatTimestamp(entry.timestamp)}
                </span>
                <div className="flex items-center gap-1">
                  <span
                    className={`w-3 h-3 rounded ${getStatusColor(entry.fromState)}`}
                  />
                  <span className="text-primary font-medium">
                    {getTransitionLabel(entry)}
                  </span>
                  <span
                    className={`w-3 h-3 rounded ${getStatusColor(entry.toState)}`}
                  />
                </div>
              </div>
              {entry.context.reason && (
                <div className="text-xs text-muted mt-1 ml-20">
                  {entry.context.reason}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default StateTransitionTimeline;
