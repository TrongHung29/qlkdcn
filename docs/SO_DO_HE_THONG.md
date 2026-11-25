# SƠ ĐỒ TOÀN BỘ HỆ THỐNG QUẢN LÝ KHO HÀNG PHÂN TÁN (WMS)
> **Dự án**: Hệ Thống Quản Lý Kho Hàng Phân Tán (WMS - Warehouse Management System) - Nhóm 8  
> **Kiến trúc**: Micro-Cluster & Multi-Source Distributed Database (Primary-Standby & Multi-Regional Sharding)  
> **Ngày cập nhật**: 23/11/2026  

---

## 📑 MỤC LỤC
1. [Sơ Đồ Kiến Trúc Tổng Thể Hệ Thống (High-Level Architecture)](#1-sơ-đồ-kiến-trúc-tổng-thể-hệ-thống-high-level-architecture)
2. [Sơ Đồ Cụm Cơ Sở Dữ Liệu Đa Nguồn (Multi-Source Database Cluster)](#2-sơ-đồ-cụm-cơ-sở-dữ-liệu-đa-nguồn-multi-source-database-cluster)
3. [Sơ Đồ Phân Luồng Đọc / Ghi & Chuyển Mạch Sự Cố (Read/Write Routing & Failover)](#3-sơ-đồ-phân-luồng-đọc--ghi--chuyển-mạch-sự-cố-readwrite-routing--failover)
4. [Sơ Đồ Luồng Nghiệp Vụ Kho Phân Tán (Distributed Business Workflows)](#4-sơ-đồ-luồng-nghiệp-vụ-kho-phân-tán-distributed-business-workflows)
   - [4.1. Luồng Nhập Kho & Khóa Vị Trí (Inbound & Concurrency Locking)](#41-luồng-nhập-kho--khóa-vị-trí-inbound--concurrency-locking)
   - [4.2. Luồng Xuất Kho & Giữ Hàng Tạm Thời (Outbound & Two-Phase Reservation)](#42-luồng-xuất-kho--giữ-hàng-tạm-thời-outbound--two-phase-reservation)
   - [4.3. Luồng Điều Chuyển Liên Kho (Inter-Warehouse Transfer)](#43-luồng-điều-chuyển-liên-kho-inter-warehouse-transfer)
5. [Sơ Đồ Ánh Xạ Thực Thể & Phân Bổ Bảng Dữ Liệu (Distributed Data Mapping)](#5-sơ-đồ-ánh-xạ-thực-thể--phân-bổ-bảng-dữ-liệu-distributed-data-mapping)
6. [Sơ Đồ Cổng Dịch Vụ & Mạng Hạ Tầng Docker (Infrastructure & Network Topology)](#6-sơ-đồ-cổng-dịch-vụ--mạng-hạ-tầng-docker-infrastructure--network-topology)

---

## 1. Sơ Đồ Kiến Trúc Tổng Thể Hệ Thống (High-Level Architecture)

```mermaid
flowchart TD
    subgraph CLIENT_TIER["1. TẦNG GIAO DIỆN NGƯỜI DÙNG (CLIENT LAYER)"]
        UI_ADMIN["Quản Trị Viên (Admin Web UI)"]
        UI_MANAGER["Quản Lý Kho (Warehouse Manager UI)"]
        UI_STAFF["Nhân Viên Kho (Staff Scanner & Form UI)"]
        CLIENT_HTTP["Axios Client (Tự động chèn Idempotency-Key & JWT Bearer)"]
        UI_ADMIN --> CLIENT_HTTP
        UI_MANAGER --> CLIENT_HTTP
        UI_STAFF --> CLIENT_HTTP
    end

    subgraph API_GATEWAY_TIER["2. TẦNG API GATEWAY & BẢO MẬT (BACKEND GATEWAY)"]
        CORS_SEC["CORS & Helmet Security Headers"]
        RATE_LIMIT["Rate Limiter (Chống DoS/Spam)"]
        AUTH_GUARD["JWT Authentication & RBAC Guard"]
        IDEM_MW["Idempotency Middleware (Chống trùng lặp lệnh)"]
        ROUTER["Express Core Router (/api/...)"]
        
        CLIENT_HTTP -->|HTTP / REST JSON| CORS_SEC
        CORS_SEC --> RATE_LIMIT
        RATE_LIMIT --> AUTH_GUARD
        AUTH_GUARD --> IDEM_MW
        IDEM_MW --> ROUTER
    end

    subgraph SERVICE_CORE_TIER["3. TẦNG XỬ LÝ NGHIỆP VỤ (APPLICATION SERVICE LAYER)"]
        PROD_SRV["Product Service (Hàng hóa, Danh mục SKU)"]
        INV_SRV["Inventory Service (Tồn kho, Điều chỉnh an toàn)"]
        REC_SRV["Receipt Service (Nhập kho, Khóa slot FOR UPDATE)"]
        DISP_SRV["Dispatch Service (Xuất kho, Giữ hàng, Quét hết hạn)"]
        TRANS_SRV["Transfer Service (Điều chuyển liên kho 2 pha)"]
        AUDIT_SRV["Audit Trail & Cluster Sync Service"]

        ROUTER --> PROD_SRV
        ROUTER --> INV_SRV
        ROUTER --> REC_SRV
        ROUTER --> DISP_SRV
        ROUTER --> TRANS_SRV
        ROUTER --> AUDIT_SRV
    end

    subgraph DISTRIBUTED_ENGINE["4. TẦNG ĐIỀU PHỐI PHÂN TÁN (DISTRIBUTED ENGINE)"]
        CLUSTER_MGR["Cluster Manager (Giám sát Heartbeat, Tách Đọc/Ghi & Failover)"]
        MULTI_SRC_MGR["Multi-Source Manager (Quản lý 3 Connection Pool & Đối soát bản ghi)"]
        REDIS_CACHE["Redis Cache & Distributed Lock (Port 6379)"]

        PROD_SRV --> MULTI_SRC_MGR
        INV_SRV --> CLUSTER_MGR
        REC_SRV --> MULTI_SRC_MGR
        DISP_SRV --> REDIS_CACHE
        TRANS_SRV --> CLUSTER_MGR
        AUDIT_SRV --> MULTI_SRC_MGR
    end

    subgraph DATA_TIER["5. TẦNG CƠ SỞ DỮ LIỆU ĐA NGUỒN (MULTI-SOURCE DATA TIER)"]
        DB_NORTH["CSDL Nguồn 1: Kho Miền Bắc (Port 5432)\n- Master Data Toàn Cục\n- Tồn kho & Phiếu Nhập/Xuất Bắc"]
        DB_SOUTH["CSDL Nguồn 2: Kho Miền Nam (Port 5433)\n- Master Data Sao Chép\n- Tồn kho & Phiếu Nhập/Xuất Nam"]
        DB_REPLICA["CSDL Nguồn 3: Standby Replica (Port 5434)\n- Gương Phản Chiếu Toàn Bộ (WAL Mirror)\n- Phân Tải Đọc & Sẵn Sàng Thay Thế"]

        MULTI_SRC_MGR -->|Broadcast Master Data| DB_NORTH
        MULTI_SRC_MGR -->|Broadcast Master Data| DB_SOUTH
        MULTI_SRC_MGR -->|Broadcast Mirror| DB_REPLICA

        CLUSTER_MGR -->|Ghi nghiệp vụ Master| DB_NORTH
        CLUSTER_MGR -->|Đọc phân tải Read-Only| DB_REPLICA
        DB_NORTH -.->|WAL Replication Stream| DB_REPLICA
    end
```

---

## 2. Sơ Đồ Cụm Cơ Sở Dữ Liệu Đa Nguồn (Multi-Source Database Cluster)

Hệ thống áp dụng mô hình lai (**Hybrid Distributed Architecture**):
- **Master Data (Dữ liệu chung)**: Ghi phát tán đồng thời (Broadcast Write) sang cả 3 nguồn.
- **Operational Data (Dữ liệu vận hành)**: Phân mảnh theo kho địa lý (Sharding by Warehouse ID) vào Node tương ứng nhằm giảm tải I/O.
- **Hot Standby Mirror (Sao lưu dự phòng)**: Đồng bộ hóa toàn bộ hai miền về Nguồn 3 để đảm bảo khả năng sẵn sàng cao (High Availability).

```mermaid
flowchart LR
    APP["Ứng Dụng Backend\n(Node.js / Express)"]

    subgraph SRC1["CSDL NGUỒN 1 (PORT 5432)"]
        direction TB
        N_TITLE["Node North - Kho Miền Bắc (Hà Nội)"]
        N_ROLE["Vai trò: REGIONAL_SHARD_NORTH"]
        N_TABLES["Lưu trữ:\n• Danh mục Hàng hóa (Master)\n• Loại hàng & Đối tác (Master)\n• Tồn kho Kho Hà Nội\n• Phiếu Nhập/Xuất Kho Hà Nội"]
    end

    subgraph SRC2["CSDL NGUỒN 2 (PORT 5433)"]
        direction TB
        S_TITLE["Node South - Kho Miền Nam (TP.HCM)"]
        S_ROLE["Vai trò: REGIONAL_SHARD_SOUTH"]
        S_TABLES["Lưu trữ:\n• Danh mục Hàng hóa (Replicated)\n• Loại hàng & Đối tác (Replicated)\n• Tồn kho Kho TP.HCM\n• Phiếu Nhập/Xuất Kho TP.HCM"]
    end

    subgraph SRC3["CSDL NGUỒN 3 (PORT 5434)"]
        direction TB
        R_TITLE["Node Standby Replica (Dự Phòng)"]
        R_ROLE["Vai trò: HOT_STANDBY_MIRROR"]
        R_TABLES["Lưu trữ:\n• Sao lưu toàn bộ Hàng hóa\n• Sao lưu toàn bộ Tồn kho (Bắc + Nam)\n• Toàn bộ Phiếu Nhập/Xuất 2 miền\n• Toàn bộ Audit Trail\n• Phục vụ truy vấn Đọc tải nặng"]
    end

    APP -->|"1. Broadcast Ghi Hàng Mới (Concurrent)"| SRC1
    APP -->|"1. Broadcast Ghi Hàng Mới (Concurrent)"| SRC2
    APP -->|"1. Broadcast Ghi Hàng Mới (Concurrent)"| SRC3

    APP -->|"2. Giao Dịch Kho Bắc"| SRC1
    APP -->|"3. Giao Dịch Kho Nam"| SRC2

    SRC1 -.->|"4. WAL Streaming Replication"| SRC3
```

---

## 3. Sơ Đồ Phân Luồng Đọc / Ghi & Chuyển Mạch Sự Cố (Read/Write Routing & Failover)

Cơ chế điều phối truy vấn thông minh của `ClusterManager`:
1. **Lệnh Ghi (Write Queries: `INSERT`, `UPDATE`, `DELETE`)**: Luôn đi vào **Primary Master (Port 5432)** để đảm bảo tính toàn vẹn giao dịch (ACID).
2. **Lệnh Đọc (Read Queries: `SELECT`)**: Các báo cáo tổng hợp, tìm kiếm danh mục được điều hướng sang **Standby Replica (Port 5434)** để giải phóng tải CPU/RAM cho Master.
3. **Chuyển Mạch Sự Cố (Automatic / Simulated Failover)**: Khi Node 5432 gặp sự cố, hệ thống tự động thăng cấp Standby 5434 thành Primary để duy trì hoạt động không gián đoạn.

```mermaid
sequenceDiagram
    autonumber
    actor User as Nhân Viên / Quản Lý
    participant FE as Frontend (React UI)
    participant GW as Cluster Manager / Routing
    participant Master as Node Primary (:5432)
    participant Standby as Node Standby (:5434)

    Note over User,Standby: GIAI ĐOẠN 1: HOẠT ĐỘNG BÌNH THƯỜNG (NORMAL MODE)
    User->>FE: Tạo phiếu Nhập kho mới (Thao tác Ghi)
    FE->>GW: POST /api/receipts (Idempotency-Key)
    GW->>Master: INSERT INTO phieu_nhap_kho (Định tuyến Primary)
    Master-->>GW: 200 OK (Đã ghi thành công)
    Master--)Standby: Sao chép đồng bộ nhật ký WAL
    GW-->>FE: Trả kết quả thành công

    User->>FE: Tra cứu báo cáo Dashboard (Thao tác Đọc)
    FE->>GW: GET /api/dashboard/stats
    GW->>Standby: SELECT * FROM ton_kho (Định tuyến Read-Replica)
    Standby-->>GW: Dữ liệu tồn kho chi tiết
    GW-->>FE: Hiển thị biểu đồ phân tích

    Note over User,Standby: GIAI ĐOẠN 2: SỰ CỐ & CHUYỂN MẠCH (FAILOVER MODE)
    Master-xGW: Mất kết nối / Node chính ngừng hoạt động
    GW->>GW: Heartbeat phát hiện Timeout (Down Node 5432)
    GW->>Standby: Thăng cấp Standby: Cho phép Ghi (Failover Active)
    User->>FE: Thực hiện Xuất kho
    FE->>GW: POST /api/dispatches
    GW->>Standby: Chuyển hướng Ghi sang Standby (:5434)
    Standby-->>GW: 200 OK (Hoàn tất không bị gián đoạn)
    GW-->>FE: Thông báo: Hệ thống đang chạy trên Node Dự Phòng
```

---

## 4. Sơ Đồ Luồng Nghiệp Vụ Kho Phân Tán (Distributed Business Workflows)

### 4.1. Luồng Nhập Kho & Khóa Vị Trí (Inbound & Concurrency Locking)
Bảo đảm hai phiếu nhập đồng thời vào cùng một kệ không vượt quá dung tích chứa tối đa (`sucChuaToiDa`).

```mermaid
sequenceDiagram
    autonumber
    actor NV as Nhân Viên Nhập Kho
    participant Srv as Receipt Service
    participant DB as Database Engine

    NV->>Srv: Nhập hàng vào Vị trí A-01-01
    Srv->>DB: BEGIN TRANSACTION
    Srv->>DB: SELECT * FROM vi_tri_kho WHERE id = 'A-01-01' FOR UPDATE
    Note over Srv,DB: Khóa bi quan (Row-level Lock): Chặn giao dịch khác sửa vị trí này
    Srv->>DB: Tính tổng thể tích hàng mới + hàng hiện có
    alt Vượt quá sức chứa kệ
        Srv-->>NV: ROLLBACK TRANSACTION (Báo lỗi: Quá tải dung tích vị trí)
    else Hợp lệ
        Srv->>DB: INSERT INTO phieu_nhap_kho
        Srv->>DB: UPDATE ton_kho (soLuongTon += X, soLuongKhaDung += X)
        Srv->>DB: Ghi sổ lịch sử thao tác (Audit Log)
        Srv->>DB: COMMIT TRANSACTION (Giải phóng khóa)
        Srv-->>NV: Hoàn tất nhập kho thành công
    end
```

---

### 4.2. Luồng Xuất Kho & Giữ Hàng Tạm Thời (Outbound & Two-Phase Reservation)
Giải quyết bài toán tương tranh (Race Condition): Hàng không bị bán âm và tự động giải phóng nếu nhân viên không thực xuất trước thời hạn.

```mermaid
flowchart TD
    START(["Bắt đầu tạo đơn xuất kho"]) --> CHECK_STOCK{"Kiểm tra tồn khả dụng:\nsoLuongKhaDung >= soLuongXuat?"}
    
    CHECK_STOCK -- "Không đủ" --> REJECT["Từ chối xuất kho (Báo lỗi thiếu hàng)"]
    
    CHECK_STOCK -- "Đủ hàng" --> PHASE1["BƯỚC 1: ĐẶT GIỮ HÀNG NGUYÊN TỬ (ATOMIC RESERVATION)\n• soLuongTamGiu += soLuongXuat\n• soLuongKhaDung -= soLuongXuat\n• Thời hạn giữ hàng: 30 phút"]
    
    PHASE1 --> WAIT_PICK["Nhân viên đi nhặt hàng trong kho (Picking)"]
    
    WAIT_PICK --> EXPIRE_CHECK{"Đã hết hạn 30 phút mà chưa xác nhận?"}
    
    EXPIRE_CHECK -- "Hết hạn" --> AUTO_SWEEP["BACKGROUND SWEEPER KÍCH HOẠT:\n• soLuongTamGiu -= soLuongXuat\n• soLuongKhaDung += soLuongXuat\n• Chuyển trạng thái phiếu: DA_HUY (Hết hạn)"]
    
    EXPIRE_CHECK -- "Xác nhận xuất đúng hạn" --> PHASE2["BƯỚC 2: XÁC NHẬN XUẤT THỰC TẾ (CONFIRM DISPATCH)\n• soLuongTon -= soLuongXuat\n• soLuongTamGiu -= soLuongXuat\n• Ghi nhận xuất kho thành công"]
    
    PHASE2 --> END_SUCCESS(["Kết thúc: Hàng rời kho thành công"])
    AUTO_SWEEP --> END_CANCEL(["Kết thúc: Hàng hoàn trả khả dụng"])
```

---

### 4.3. Luồng Điều Chuyển Liên Kho (Inter-Warehouse Transfer)
Quy trình điều phối hàng hóa giữa Kho Miền Bắc (5432) và Kho Miền Nam (5433).

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Điều Phối Viên
    participant TSrv as Transfer Service
    actor WH_Src as Kho Gửi (Miền Bắc)
    actor WH_Dst as Kho Nhận (Miền Nam)

    Admin->>TSrv: Tạo lệnh chuyển kho: Hà Nội -> TP.HCM (Số lượng: 50)
    TSrv->>TSrv: Khóa giữ tồn kho tại Kho Hà Nội (soLuongTamGiu += 50)
    TSrv-->>Admin: Trạng thái: CHO_XAC_NHAN

    WH_Src->>TSrv: Xuất hàng lên xe vận chuyển
    TSrv->>TSrv: Giảm tồn vật lý kho Hà Nội, Trạng thái: DANG_CHUYEN
    TSrv-->>WH_Dst: Thông báo hàng đang trên đường giao

    alt Trường hợp 1: Kho Đích kiểm nhận đủ hàng
        WH_Dst->>TSrv: Xác nhận đã nhận đủ hàng vào kho
        TSrv->>TSrv: Tăng tồn kho tại TP.HCM (soLuongTon += 50, soLuongKhaDung += 50)
        TSrv-->>Admin: Trạng thái: HOAN_THANH
    else Trường hợp 2: Hàng hóa hư hại / Sai lệch (Từ chối)
        WH_Dst->>TSrv: Từ chối nhận hàng (rejectTransfer)
        TSrv->>TSrv: Hoàn trả lại tồn kho khả dụng cho Kho Hà Nội
        TSrv-->>Admin: Trạng thái: DA_HUY (Đã bồi hoàn tồn kho gốc)
    end
```

---

## 5. Sơ Đồ Ánh Xạ Thực Thể & Phân Bổ Bảng Dữ Liệu (Distributed Data Mapping)

```mermaid
classDiagram
    direction TB
    
    class MASTER_DATA {
        <<Replicated Full Across 3 Nodes>>
        hang_hoa (Hàng hóa & Mã SKU)
        loai_hang (Nhóm ngành hàng)
        nha_cung_cap (Đối tác cung ứng)
        kho (Danh bạ kho hàng)
    }

    class SHARDED_DATA {
        <<Sharded by Warehouse Location>>
        ton_kho (Sổ số dư tồn kho chi tiết)
        vi_tri_kho (Tọa độ kệ / slot hàng)
        phieu_nhap_kho (Giao dịch nhập nội vùng)
        chi_tiet_nhap (Chi tiết mặt hàng nhập)
        phieu_xuat_kho (Giao dịch xuất nội vùng)
        chi_tiet_xuat (Chi tiết mặt hàng xuất)
    }

    class GLOBAL_COORDINATION {
        <<Synchronized Cluster-wide>>
        phieu_chuyen_kho (Giao dịch liên chi nhánh)
        chi_tiet_chuyen (Chi tiết hàng điều chuyển)
        nguoi_dung (Tài khoản & Phân quyền RBAC)
        lich_su_thao_tac (Audit Ledger toàn hệ thống)
    }

    MASTER_DATA --o SHARDED_DATA : "Tham chiếu danh mục"
    SHARDED_DATA --o GLOBAL_COORDINATION : "Đối soát & Báo cáo"
```

---

## 6. Sơ Đồ Cổng Dịch Vụ & Mạng Hạ Tầng Docker (Infrastructure & Network Topology)

```mermaid
graph TD
    subgraph DOCKER_COMPOSE["CỤM HẠ TẦNG DOCKER (DOCKER VIRTUAL NETWORK: 172.28.0.0/16)"]
        subgraph APPS["CONTAINERS DỊCH VỤ ỨNG DỤNG"]
            FE_CONTAINER["frontend-ui\n(Vite + React)\nHost Port: 5173\nInternal: 5173"]
            BE_CONTAINER["backend-api\n(Express + Node)\nHost Port: 5000\nInternal: 5000"]
            REDIS_CONTAINER["redis-cluster\n(Distributed Cache)\nHost Port: 6379\nInternal: 6379"]
        end

        subgraph DBS["CONTAINERS CƠ SỞ DỮ LIỆU ĐA NGUỒN"]
            DB_NORTH_C["postgres (Node North)\nPostgreSQL 15 Alpine\nHost Port: 5432\nVolume: pgdata_north"]
            DB_SOUTH_C["postgres-south (Node South)\nPostgreSQL 15 Alpine\nHost Port: 5433\nVolume: pgdata_south"]
            DB_REPLICA_C["postgres-replica (Standby Mirror)\nPostgreSQL 15 Alpine\nHost Port: 5434\nVolume: pgdata_replica"]
        end

        FE_CONTAINER -->|API Calls (Proxy)| BE_CONTAINER
        BE_CONTAINER -->|Lock & Session| REDIS_CONTAINER
        BE_CONTAINER -->|Primary / North Shard Connection| DB_NORTH_C
        BE_CONTAINER -->|South Shard Connection| DB_SOUTH_C
        BE_CONTAINER -->|Read-Replica & Mirror Connection| DB_REPLICA_C
        DB_NORTH_C -.->|Async Replication Stream| DB_REPLICA_C
    end

    CLIENT_BROWSER["Trình duyệt Client\n(http://localhost:5173)"] --> FE_CONTAINER
    API_CONSUMER["Client API / Postman\n(http://localhost:5000/api)"] --> BE_CONTAINER
```

---

## 7. Tổng Hợp Các Điểm Nhấn Kiến Trúc Thuyết Trình
1. **Tính Toàn Vẹn & Không Bị Ghi Đè (ACID + Idempotency)**:
   - Client tự động sinh mã `Idempotency-Key` (UUIDv4) gắn vào header mọi request POST/PUT/DELETE.
   - Khi mạng lag hoặc nhân viên bấm nút nhiều lần, server chỉ xử lý đúng 1 lần duy nhất.
2. **Khóa Hàng Tránh Bán Âm (Two-Phase Inventory Lock)**:
   - Sử dụng công thức bất biến: `soLuongKhaDung = Math.max(0, soLuongTon - soLuongTamGiu)`.
   - Có tiến trình `sweep-expired` dọn dẹp phiếu quá hạn mỗi 5 phút.
3. **Phân Luồng Đọc/Ghi & Chống Nghẽn Cổ Chai (Read/Write Splitting)**:
   - Thao tác thay đổi số dư -> Master (5432).
   - Thao tác xuất biểu đồ/báo cáo -> Replica (5434).
4. **Lưu Trữ Đa Nguồn & Phân Mảnh Dữ Liệu (Multi-Source Sharding)**:
   - Các kho độc lập xử lý giao dịch cục bộ không ảnh hưởng đến nhau.
   - Master data đồng bộ toàn hệ thống.
5. **Chuyển Mạch Tự Động Khi Sự Cố (High Availability & Failover)**:
   - Standby Replica sẵn sàng thăng cấp thành Master khi phát hiện Node chính ngừng hoạt động.
