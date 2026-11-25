export interface QueuedRequest {
  id: string;
  method: string;
  url: string;
  data?: unknown;
  headers: Record<string, string>;
  createdAt: string;
}

const QUEUE_KEY = 'wms_offline_queue';
const WAREHOUSE_KEY = 'wms_warehouse_code';

export function getQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedRequest[]) : [];
  } catch {
    return [];
  }
}

export function enqueue(request: QueuedRequest): void {
  const queue = getQueue();
  queue.push(request);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function removeQueued(id: string): void {
  const queue = getQueue().filter((item) => item.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getWarehouseCode(): string {
  return localStorage.getItem(WAREHOUSE_KEY) || '';
}

export function setWarehouseCode(code: string): void {
  if (code) {
    localStorage.setItem(WAREHOUSE_KEY, code);
  } else {
    localStorage.removeItem(WAREHOUSE_KEY);
  }
}

export function newRequestId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return random;
}
