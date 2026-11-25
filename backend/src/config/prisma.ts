import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

/**
 * Tầng ứng dụng sinh UUIDv7 cho MỌI bản ghi Prisma (kể cả API v1).
 * DB vẫn giữ @default(uuid()) làm fallback, nhưng giá trị thực tế luôn do app sinh,
 * đảm bảo thứ tự thời gian và tránh collision giữa các shard.
 */
prisma.$use(async (params, next) => {
  if (params.action === 'create' && params.args?.data && !('id' in params.args.data)) {
    params.args.data.id = uuidv7();
  }
  if (params.action === 'createMany' && Array.isArray(params.args?.data)) {
    params.args.data = params.args.data.map((item: Record<string, unknown>) =>
      item && !('id' in item) ? { ...item, id: uuidv7() } : item
    );
  }
  return next(params);
});

export default prisma;

