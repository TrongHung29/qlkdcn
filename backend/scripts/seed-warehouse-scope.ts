/**
 * Gán phạm vi kho cho người dùng v1. Chạy SAU `npm run db:migrate:distributed`.
 * Demo: mọi tài khoản active được gán vào 2 chi nhánh; Admin vẫn có toàn quyền.
 * Khi triển khai thực tế, chỉnh sửa bảng `user_warehouses` để thu hẹp quyền.
 */
import { Prisma, UserStatus } from '@prisma/client';
import prisma from '../src/config/prisma';

const WAREHOUSES = [
  {
    maKho: 'WH-NORTH-01',
    tenKho: 'Kho Miền Bắc (Hà Nội)',
    diaChi: 'Hà Nội',
  },
  {
    maKho: 'WH-SOUTH-01',
    tenKho: 'Kho Miền Nam (TP. HCM)',
    diaChi: 'TP. HCM',
  },
];

async function main(): Promise<void> {
  const warehouses = [];
  for (const item of WAREHOUSES) {
    const warehouse = await prisma.kho.upsert({
      where: { maKho: item.maKho },
      create: { ...item, trangThai: true },
      update: { tenKho: item.tenKho, diaChi: item.diaChi, trangThai: true },
      select: { id: true, maKho: true },
    });
    warehouses.push(warehouse);
  }

  const users = await prisma.user.findMany({
    where: { trangThai: UserStatus.ACTIVE },
    select: { id: true, username: true },
  });

  for (const user of users) {
    for (const warehouse of warehouses) {
      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO user_warehouses (user_id, warehouse_id)
                   VALUES (${user.id}, ${warehouse.id})
                   ON CONFLICT DO NOTHING`
      );
    }
  }

  console.log(
    `[RBAC] ✅ Đã gán ${users.length} người dùng vào ${warehouses.length} kho: ${warehouses
      .map((item) => item.maKho)
      .join(', ')}`
  );
}

main()
  .catch((error) => {
    console.error('[RBAC] ❌', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
