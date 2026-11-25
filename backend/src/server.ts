import { createApp } from './app';
import prisma from './config/prisma';
import { closeAllPools } from './distributed/db';
import { closeReadPool } from './distributed/infra/read-db';
import { closeRedlock } from './distributed/infra/redlock';

const PORT = process.env.PORT || 5000;
const app = createApp();

async function startServer() {
  try {
    // Kiểm tra kết nối Database
    await prisma.$connect();
    console.log('✅ Đã kết nối thành công đến cơ sở dữ liệu PostgreSQL!');

    const server = app.listen(PORT, () => {
      console.log(`🚀 WMS Backend Server đang chạy tại: http://localhost:${PORT}`);
      console.log(`📡 Healthcheck API: http://localhost:${PORT}/api/health`);
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`🛑 Nhận ${signal}: đang đóng server gracefully...`);

      // Ngừng nhận request mới, chờ request hiện tại hoàn tất.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      await prisma.$disconnect();
      await closeRedlock();
      await closeReadPool();
      await closeAllPools();
      console.log('✅ Đã đóng toàn bộ kết nối an toàn');
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Không thể khởi động server hoặc kết nối Database:', error);
    process.exit(1);
  }
}

startServer();
