import axios, { AxiosResponse } from 'axios';
import {
  enqueue,
  getQueue,
  getWarehouseCode,
  newRequestId,
  removeQueued,
} from './offline-queue';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const pendingKeys = new Map<string, string>();
let isFlushing = false;

function signature(config: any): string {
  return `${config.method?.toUpperCase()} ${config.url} ${JSON.stringify(config.data ?? '')}`;
}

function newIdempotencyKey(): string {
  return `idemp-${Date.now()}-${newRequestId().slice(0, 12)}`;
}

// Interceptor: JWT + Idempotency-Key ổn định + Correlation-Id + kho active + offline queue
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('wms_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const warehouseCode = getWarehouseCode();
  if (warehouseCode) {
    config.headers['x-warehouse-code'] = warehouseCode;
  }

  const method = config.method?.toUpperCase();
  if (method && MUTATING.has(method)) {
    const sig = signature(config);
    (config as any).__idemSig = sig;

    // Giữ key cho đến khi nhận response thành công. Nếu mạng rớt, lần bấm lại
    // dùng CHÍNH key đó -> server idempotency chặn duplicate.
    let key = pendingKeys.get(sig);
    if (!key) {
      key = newIdempotencyKey();
      pendingKeys.set(sig, key);
    }
    config.headers['Idempotency-Key'] = key;

    if (!config.headers['X-Correlation-Id']) {
      config.headers['X-Correlation-Id'] = newRequestId();
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      enqueue({
        id: newRequestId(),
        method,
        url: config.url || '',
        data: config.data,
        headers: {
          'Idempotency-Key': key,
          'X-Correlation-Id': String(config.headers['X-Correlation-Id']),
          ...(warehouseCode ? { 'x-warehouse-code': warehouseCode } : {}),
        },
        createdAt: new Date().toISOString(),
      });

      config.adapter = async () =>
        ({
          data: {
            success: true,
            message: 'Đã lưu thao tác vào hàng đợi offline, sẽ gửi lại khi có mạng',
            data: null,
          },
          status: 202,
          statusText: 'OFFLINE_QUEUED',
          headers: {},
          config,
        }) as AxiosResponse;
    }
  }

  return config;
});

api.interceptors.response.use(
  (response) => {
    const sig = (response.config as any).__idemSig as string | undefined;
    if (sig) pendingKeys.delete(sig);
    return response;
  },
  (error) => {
    // Không xóa key khi lỗi: retry (hoặc flush offline) sẽ dùng lại key cũ.
    return Promise.reject(error);
  }
);

/** Gửi lại các request đã lưu khi mạng trở lại. */
export async function flushOfflineQueue(): Promise<void> {
  if (isFlushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  isFlushing = true;
  try {
    for (const item of getQueue()) {
      try {
        await api.request({
          method: item.method as any,
          url: item.url,
          data: item.data,
          headers: item.headers,
        });
        removeQueued(item.id);
      } catch {
        // Giữ lại trong hàng đợi, thử ở lần online tiếp theo.
      }
    }
  } finally {
    isFlushing = false;
  }
}

export default api;
