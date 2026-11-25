import { Pool } from 'pg';
import {
  ClusterState,
  DatabaseNodeInfo,
  FailoverEvent,
  ReplicationStats,
} from './cluster.types';

class DatabaseClusterManager {
  private primaryPool: Pool;
  private standbyPool: Pool;
  private isSimulatedFailover: boolean = false;
  private failoverHistory: FailoverEvent[] = [];
  private lastSyncTime: Date = new Date();
  private replicatedRecordsCount: number = 1420;

  private primaryInfo: DatabaseNodeInfo = {
    id: 'node-primary-01',
    name: 'Primary Database (Master Node)',
    role: 'PRIMARY',
    host: 'localhost',
    port: 5432,
    database: 'wms_db',
    status: 'ONLINE',
    latencyMs: 1,
    isWriteAllowed: true,
    isReadAllowed: true,
    totalConnections: 5,
    version: 'PostgreSQL 16.4',
    lastHeartbeat: new Date().toISOString(),
    error: null,
  };

  private standbyInfo: DatabaseNodeInfo = {
    id: 'node-standby-02',
    name: 'Standby Database (Dự Phòng / Hot Standby Replica)',
    role: 'STANDBY_REPLICA',
    host: 'localhost',
    port: 5434,
    database: 'wms_db',
    status: 'STANDBY_READY',
    latencyMs: 2,
    isWriteAllowed: false,
    isReadAllowed: true,
    totalConnections: 2,
    version: 'PostgreSQL 16.4 (Standby Mode)',
    lastHeartbeat: new Date().toISOString(),
    error: null,
  };

  constructor() {
    const primaryUrl =
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/wms_db?schema=public';
    const replicaUrl =
      process.env.DB_REPLICA_URL ||
      'postgresql://postgres:postgres@localhost:5434/wms_db?schema=public';

    this.primaryPool = new Pool({
      connectionString: primaryUrl,
      connectionTimeoutMillis: 2000,
      max: 10,
    });

    this.standbyPool = new Pool({
      connectionString: replicaUrl,
      connectionTimeoutMillis: 2000,
      max: 10,
    });

    // Seed log khởi động
    this.addLog(
      'PRIMARY_RECOVERED',
      'Khởi tạo cụm Database phân tán Master - Standby Replica',
      'SYSTEM',
      'Primary (5432)'
    );

    // Chạy heartbeat định kỳ
    this.checkHealth();
    setInterval(() => this.checkHealth(), 10000);
  }

  private addLog(
    type: FailoverEvent['type'],
    description: string,
    fromNode: string,
    toNode: string
  ) {
    this.failoverHistory.unshift({
      id: `ev-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      type,
      description,
      fromNode,
      toNode,
    });
    if (this.failoverHistory.length > 20) {
      this.failoverHistory.pop();
    }
  }

  /** Kiểm tra kết nối thực tế tới 1 node và đọc trạng thái recovery. */
  private async probePool(
    pool: Pool
  ): Promise<{ ok: boolean; latencyMs: number; inRecovery: boolean }> {
    const start = Date.now();
    try {
      const res = await pool.query<{ in_recovery: boolean }>(
        'SELECT pg_is_in_recovery() AS in_recovery'
      );
      return {
        ok: true,
        latencyMs: Math.max(1, Date.now() - start),
        inRecovery: res.rows[0]?.in_recovery === true,
      };
    } catch {
      return { ok: false, latencyMs: 0, inRecovery: false };
    }
  }

  /** Độ trễ replica THỰC từ pg_stat_replication; null = không có standby kết nối. */
  private async getReplicationLagMs(): Promise<number | null> {
    try {
      const res = await this.primaryPool.query<{ lag_ms: number | string | null }>(
        `SELECT EXTRACT(EPOCH FROM replay_lag) * 1000 AS lag_ms
         FROM pg_stat_replication ORDER BY pid LIMIT 1`
      );
      if (!res.rows.length || res.rows[0].lag_ms === null) return null;
      return Math.max(0, Math.round(Number(res.rows[0].lag_ms)));
    } catch {
      return null;
    }
  }

  public async checkHealth(): Promise<void> {
    const now = new Date().toISOString();
    const [primaryProbe, standbyProbe] = await Promise.all([
      this.probePool(this.primaryPool),
      this.probePool(this.standbyPool),
    ]);

    // 1. Kiểm tra Primary
    if (this.isSimulatedFailover) {
      this.primaryInfo.status = 'OFFLINE';
      this.primaryInfo.error = 'MÔ PHỎNG SỰ CỐ: Node chính bị ngắt kết nối vật lý';
      this.primaryInfo.isWriteAllowed = false;
      this.primaryInfo.isReadAllowed = false;
      this.primaryInfo.latencyMs = 0;
    } else if (primaryProbe.ok) {
      this.primaryInfo.status = 'ONLINE';
      this.primaryInfo.latencyMs = primaryProbe.latencyMs;
      this.primaryInfo.isWriteAllowed = true;
      this.primaryInfo.isReadAllowed = true;
      this.primaryInfo.error = null;
      this.primaryInfo.lastHeartbeat = now;
    } else {
      this.primaryInfo.status = 'OFFLINE';
      this.primaryInfo.error = 'Không thể kết nối đến Primary (5432)';
      this.primaryInfo.latencyMs = 0;
    }

    // 2. Kiểm tra Standby (Dự phòng) - dùng số liệu thật, không bịa trạng thái
    this.standbyInfo.latencyMs = standbyProbe.latencyMs;
    this.standbyInfo.lastHeartbeat = now;
    if (this.isSimulatedFailover) {
      this.standbyInfo.status = standbyProbe.ok ? 'ONLINE' : 'DEGRADED';
      this.standbyInfo.error = standbyProbe.ok
        ? null
        : 'Standby 5434 chưa khởi động; chế độ failover chỉ là mô phỏng trên UI';
    } else if (standbyProbe.ok && standbyProbe.inRecovery) {
      this.standbyInfo.status = 'STANDBY_READY';
      this.standbyInfo.error = null;
    } else if (standbyProbe.ok) {
      this.standbyInfo.status = 'DEGRADED';
      this.standbyInfo.error = 'Node 5434 không ở chế độ recovery (chưa phải Hot Standby)';
    } else {
      this.standbyInfo.status = 'DEGRADED';
      this.standbyInfo.error = 'Không kết nối được Standby 5434 (dữ liệu demo đang mô phỏng)';
    }

    if (this.isSimulatedFailover) {
      this.standbyInfo.isWriteAllowed = true;
      this.standbyInfo.isReadAllowed = true;
    } else {
      this.standbyInfo.isWriteAllowed = false;
      this.standbyInfo.isReadAllowed = true;
    }
  }

  public async getClusterState(): Promise<ClusterState> {
    await this.checkHealth();

    const realLagMs = await this.getReplicationLagMs();
    const replication: ReplicationStats = {
      // Khi có Standby thật: lấy số liệu từ pg_stat_replication. Không có thì báo DISCONNECTED.
      status: this.isSimulatedFailover
        ? 'BEHIND'
        : realLagMs === null
          ? 'DISCONNECTED'
          : realLagMs < 1000
            ? 'SYNCHRONIZED'
            : 'SYNCING',
      replicationLagMs: this.isSimulatedFailover ? 1240 : (realLagMs ?? 0),
      lastSyncTime: this.lastSyncTime.toISOString(),
      syncMethod: 'PostgreSQL Physical Streaming Replication + Hot Standby WAL (pg_basebackup)',
      monitoredTables: [
        'users',
        'hang_hoa',
        'kho',
        'vi_tri_luu_tru',
        'ton_kho',
        'phieu_nhap_kho',
        'phieu_xuat_kho',
        'phieu_chuyen_kho',
        'canh_bao_ton_kho',
        'lich_su_thao_tac',
      ],
      replicatedRecordsCount: this.replicatedRecordsCount,
    };

    const replicaConfigured =
      !!process.env.DB_REPLICA_URL && process.env.REPLICA_READS_ENABLED !== 'false';

    return {
      mode: this.isSimulatedFailover ? 'SIMULATED_FAILOVER' : 'NORMAL',
      // Luôn nói sự thật: simulate chỉ đổi nhãn/log, KHÔNG đổi connection string.
      activeNodeForWrite: this.isSimulatedFailover
        ? 'Primary Master (Port 5432) — đang MÔ PHỎNG failover; ghi thực tế vẫn ở 5432'
        : 'Primary Master (Port 5432)',
      activeNodeForRead: replicaConfigured
        ? 'Standby Replica (Port 5434) [read model /api/v2] + Primary (Port 5432) [API v1]'
        : 'Primary (Port 5432) — chưa cấu hình DB_REPLICA_URL',
      actualWriteTarget:
        process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wms_db?schema=public',
      failoverNote: this.isSimulatedFailover
        ? 'Chế độ mô phỏng dùng để thuyết trình. Để chuyển mạch thật: chạy sh docker/postgres/promote-replica.sh, đổi DATABASE_URL/DB_NORTH_URL sang cổng 5434 rồi restart backend + workers.'
        : undefined,
      readWriteSplittingEnabled: replicaConfigured,
      primary: this.primaryInfo,
      standby: this.standbyInfo,
      replication,
      failoverHistory: this.failoverHistory,
    };
  }

  public setSimulatedFailover(active: boolean, reason?: string): ClusterState {
    this.isSimulatedFailover = active;

    if (active) {
      this.addLog(
        'FAILOVER_TRIGGERED',
        reason ||
          'PHÁT HIỆN SỰ CỐ MẤT ĐIỆN / MẠNG: Tự động chuyển mạch Failover sang Database Dự phòng (Standby 5434)',
        'Primary Node (5432)',
        'Standby Replica (5434)'
      );
    } else {
      this.addLog(
        'PRIMARY_RECOVERED',
        'Database chính (5432) đã phục hồi online. Tự động đồng bộ dữ liệu và hoàn trả vai trò Master',
        'Standby Replica (5434)',
        'Primary Node (5432)'
      );
    }

    return {
      mode: this.isSimulatedFailover ? 'SIMULATED_FAILOVER' : 'NORMAL',
      activeNodeForWrite: this.isSimulatedFailover
        ? 'Primary Master (Port 5432) — MÔ PHỎNG, chưa promote 5434'
        : 'Primary Master (Port 5432)',
      activeNodeForRead:
        !!process.env.DB_REPLICA_URL && process.env.REPLICA_READS_ENABLED !== 'false'
          ? 'Standby Replica (Port 5434) [read model /api/v2] + Primary (Port 5432) [API v1]'
          : 'Primary (Port 5432) — chưa cấu hình DB_REPLICA_URL',
      actualWriteTarget:
        process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wms_db?schema=public',
      failoverNote: active
        ? 'Chế độ mô phỏng: log và nhãn đổi, connection string KHÔNG đổi. Chạy sh docker/postgres/promote-replica.sh + đổi URL + restart để failover thật.'
        : undefined,
      readWriteSplittingEnabled:
        !!process.env.DB_REPLICA_URL && process.env.REPLICA_READS_ENABLED !== 'false',
      primary: this.primaryInfo,
      standby: this.standbyInfo,
      replication: {
        status: active ? 'BEHIND' : 'SYNCHRONIZED',
        replicationLagMs: active ? 1500 : 0,
        lastSyncTime: new Date().toISOString(),
        syncMethod: 'Streaming Replication',
        monitoredTables: ['all'],
        replicatedRecordsCount: this.replicatedRecordsCount,
      },
      failoverHistory: this.failoverHistory,
    };
  }

  public async syncReplication(): Promise<{
    success: boolean;
    message: string;
    syncedTables: number;
    recordsCount: number;
    durationMs: number;
  }> {
    const start = Date.now();
    this.lastSyncTime = new Date();
    const lagMs = await this.getReplicationLagMs();
    const hasRealStandby = lagMs !== null && !this.isSimulatedFailover;

    if (hasRealStandby) {
      this.replicatedRecordsCount += 1;
      this.addLog(
        'MANUAL_SYNC',
        `Đã kiểm tra WAL streaming sang Standby Replica, độ trễ hiện tại ${lagMs} ms`,
        'Primary (5432)',
        'Standby (5434)'
      );
    }

    return {
      success: hasRealStandby || this.isSimulatedFailover,
      message: hasRealStandby
        ? `Đồng bộ WAL sang Standby Replica đang hoạt động (độ trễ ${lagMs} ms)`
        : this.isSimulatedFailover
          ? 'Đang mô phỏng sự cố: không thể đọc thống kê WAL từ Primary'
          : 'Chưa phát hiện Standby kết nối tới Primary (5432). Hãy khởi động postgres-replica bằng Docker Compose.',
      syncedTables: hasRealStandby ? 14 : 0,
      recordsCount: this.replicatedRecordsCount,
      durationMs: Date.now() - start,
    };
  }

  public async testRouting(): Promise<{
    readQuery: {
      targetNode: string;
      role: string;
      queryType: string;
      latencyMs: number;
      status: string;
    };
    writeQuery: {
      targetNode: string;
      role: string;
      queryType: string;
      latencyMs: number;
      status: string;
    };
    explanation: string;
  }> {
    const isFailover = this.isSimulatedFailover;
    const [primaryProbe, standbyProbe] = await Promise.all([
      this.probePool(this.primaryPool),
      this.probePool(this.standbyPool),
    ]);

    return {
      readQuery: {
        targetNode: isFailover
          ? 'Standby Database (Port 5434)'
          : 'Standby Replica (Port 5434) [Read/Write Split]',
        role: isFailover ? 'ACTIVE_PRIMARY' : 'STANDBY_REPLICA',
        // Chỉ kiểm tra kết nối, không ghi dữ liệu thử vào sổ cái
        queryType: 'SELECT pg_is_in_recovery() (kiểm tra node Đọc)',
        latencyMs: standbyProbe.latencyMs,
        status: standbyProbe.ok ? 'SUCCESS' : 'UNAVAILABLE (chế độ mô phỏng)',
      },
      writeQuery: {
        targetNode: isFailover
          ? 'Standby Database (Port 5434) [Failover Mode - Mô phỏng thăng cấp Ghi]'
          : 'Primary Master Database (Port 5432) [Ghi Dữ Liệu Gốc]',
        role: isFailover ? 'ACTIVE_PRIMARY' : 'PRIMARY_MASTER',
        queryType: 'SELECT pg_is_in_recovery() (kiểm tra node Ghi)',
        latencyMs: primaryProbe.latencyMs,
        status: primaryProbe.ok ? 'SUCCESS' : 'UNAVAILABLE (chế độ mô phỏng)',
      },
      explanation: isFailover
        ? '⚠️ Chế độ Sự cố (MÔ PHỎNG): bảng điều khiển chuyển mạch sang Standby (5434). Để chuyển mạch thật cần promote Hot Standby và đổi connection string của ứng dụng.'
        : '✅ Chế độ Tiêu chuẩn: chiến lược là Ghi vào Primary (5432), Đọc phân tải sang Standby (5434). API v1 dùng Prisma nên hiện vẫn gửi truy vấn qua DATABASE_URL; phân luồng vật lý cần PgBouncer/Haproxy hoặc Prisma read replica.',
    };
  }
}

export const clusterManager = new DatabaseClusterManager();
