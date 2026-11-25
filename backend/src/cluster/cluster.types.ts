export type NodeRole = 'PRIMARY' | 'STANDBY_REPLICA';
export type NodeStatus = 'ONLINE' | 'STANDBY_READY' | 'DEGRADED' | 'OFFLINE';
export type ClusterMode = 'NORMAL' | 'SIMULATED_FAILOVER' | 'FAILOVER_ACTIVE';

export interface DatabaseNodeInfo {
  id: string;
  name: string;
  role: NodeRole;
  host: string;
  port: number;
  database: string;
  status: NodeStatus;
  latencyMs: number;
  isWriteAllowed: boolean;
  isReadAllowed: boolean;
  totalConnections: number;
  version?: string;
  lastHeartbeat: string;
  error?: string | null;
}

export interface ReplicationStats {
  status: 'SYNCHRONIZED' | 'SYNCING' | 'BEHIND' | 'DISCONNECTED';
  replicationLagMs: number;
  lastSyncTime: string;
  syncMethod: string;
  monitoredTables: string[];
  replicatedRecordsCount: number;
}

export interface FailoverEvent {
  id: string;
  timestamp: string;
  type: 'SIMULATION_STARTED' | 'SIMULATION_STOPPED' | 'FAILOVER_TRIGGERED' | 'PRIMARY_RECOVERED' | 'MANUAL_SYNC';
  description: string;
  fromNode: string;
  toNode: string;
}

export interface ClusterState {
  mode: ClusterMode;
  activeNodeForWrite: string;
  activeNodeForRead: string;
  /** Đích ghi THỰC TẾ của tiến trình backend hiện tại (không đổi khi simulate). */
  actualWriteTarget?: string;
  /** Giải thích giới hạn của chế độ mô phỏng để UI không báo sai cho admin. */
  failoverNote?: string;
  readWriteSplittingEnabled: boolean;
  primary: DatabaseNodeInfo;
  standby: DatabaseNodeInfo;
  replication: ReplicationStats;
  failoverHistory: FailoverEvent[];
}
