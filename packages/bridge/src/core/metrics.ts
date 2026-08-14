/**
 * Per-cycle observation metrics for the Phase 0 run. These are logged as
 * structured lines each poll so the week-long activity report can be built from
 * stdout alone (plus DB state snapshots).
 */
export interface PollCycleMetrics {
  directoryOk: boolean;
  schemaVersion: string;
  liveInDirectory: number;
  hlsLive: number;
  hlsEnded: number;
  hlsError: number;
  newInstances: number;
  published30311: number;
  publishedProfiles: number;
  endedThisCycle: number;
  /** Instances seen but skipped because discovery_enabled=false (opt-outs). */
  disabledSkipped: number;
  relayWriteFailures: number;
  /** True when this cycle wrote an hourly observation snapshot. */
  snapshotTaken: boolean;
  durationMs: number;
}

export function newCycleMetrics(): PollCycleMetrics {
  return {
    directoryOk: false,
    schemaVersion: 'unknown',
    liveInDirectory: 0,
    hlsLive: 0,
    hlsEnded: 0,
    hlsError: 0,
    newInstances: 0,
    published30311: 0,
    publishedProfiles: 0,
    endedThisCycle: 0,
    disabledSkipped: 0,
    relayWriteFailures: 0,
    snapshotTaken: false,
    durationMs: 0,
  };
}

/** True when at least one relay reported success. */
export function anyRelayAccepted(result: Record<string, boolean>): boolean {
  return Object.values(result).some(Boolean);
}
