import { createClient, RedisClientType } from 'redis';

/**
 * Redlock tối giản: SET key token NX PX trên đa số instance Redis, giải phóng
 * bằng Lua so sánh token. Mặc định dùng 1 instance từ compose; có thể cấu hình
 * REDLOCK_URLS để chạy quorum thật (3 instance).
 *
 * Nếu Redis không reachable, hệ thống FALL BACK về advisory lock của Postgres
 * (đã có trong idempotency.ts) và ghi cảnh báo, trừ khi REDLOCK_REQUIRED=true.
 */
const DEFAULT_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const URLS = (process.env.REDLOCK_URLS || DEFAULT_URL)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const QUORUM = Math.floor(URLS.length / 2) + 1;
const clients = new Map<string, RedisClientType>();

interface Lock {
  key: string;
  token: string;
  acquired: RedisClientType[];
}

async function getClient(url: string): Promise<RedisClientType | null> {
  const cached = clients.get(url);
  if (cached?.isOpen) return cached;
  try {
    const client = createClient({
      url,
      socket: {
        connectTimeout: Number(process.env.REDLOCK_CONNECT_TIMEOUT_MS || 400),
        reconnectStrategy: false,
      },
    }) as RedisClientType;
    client.on('error', () => {
      // Lỗi được xử lý tại acquire(); không để event handler làm crash process.
    });
    await client.connect();
    clients.set(url, client);
    return client;
  } catch {
    return null;
  }
}

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

async function release(lock: Lock): Promise<void> {
  await Promise.all(
    lock.acquired.map(async (client) => {
      try {
        await client.eval(RELEASE_SCRIPT, {
          keys: [lock.key],
          arguments: [lock.token],
        });
      } catch {
        // Best effort: TTL sẽ tự hết hạn nếu không release được.
      }
    })
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireRedlock(
  key: string,
  ttlMs = Number(process.env.REDLOCK_TTL_MS || 10000)
): Promise<Lock | null> {
  const token = randomToken();
  const retries = Number(process.env.REDLOCK_RETRIES || 3);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const acquired: RedisClientType[] = [];
    const results = await Promise.all(
      URLS.map(async (url) => {
        const client = await getClient(url);
        if (!client) return null;
        try {
          const ok = await client.set(key, token, { NX: true, PX: ttlMs });
          return ok === 'OK' ? client : null;
        } catch {
          return null;
        }
      })
    );

    for (const client of results) {
      if (client) acquired.push(client);
    }

    if (acquired.length >= QUORUM) {
      return { key, token, acquired };
    }

    await release({ key, token, acquired });
    if (attempt < retries) {
      await sleep(Math.floor(Math.random() * 30) + 10);
    }
  }
  return null;
}

/** Chạy handler dưới khóa phân tán; fail-open có kiểm soát khi Redis chết. */
export async function withRedlock<T>(
  key: string,
  handler: () => Promise<T>
): Promise<T> {
  if (process.env.REDLOCK_ENABLED === 'false') return handler();

  const lock = await acquireRedlock(`redlock:${key}`);
  if (!lock) {
    if (process.env.REDLOCK_REQUIRED === 'true') {
      throw new Error('Không thể lấy khóa phân tán (Redlock) cho yêu cầu này');
    }
    console.warn(
      `[Redlock] Không đạt quorum cho "${key}" - fallback về khóa Postgres trong transaction`
    );
    return handler();
  }

  try {
    return await handler();
  } finally {
    await release(lock);
  }
}

export async function closeRedlock(): Promise<void> {
  await Promise.all(
    [...clients.values()].map(async (client) => {
      try {
        if (client.isOpen) await client.quit();
      } catch {
        // ignore
      }
    })
  );
  clients.clear();
}
