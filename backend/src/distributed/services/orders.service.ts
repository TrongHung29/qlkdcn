import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { ShardName, SYSTEM_ACTOR_ID } from '../config';
import { NotFoundError } from '../errors';
import { newId } from '../uuid';
import {
  Allocation,
  consumeReservations,
  inboundStock,
  reserveStockFefo,
} from './inventory.service';

export interface OrderLineInput {
  productId: string;
  batchId: string | null;
  locationId: string;
  qty: number;
}

interface ServiceBase {
  shard: ShardName;
  warehouseId: string;
  createdBy?: string;
  client?: PoolClient;
}

function generateOrderCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${newId().slice(0, 8).toUpperCase()}`;
}

export async function createInboundOrder(
  input: ServiceBase & {
    lines: OrderLineInput[];
    partnerName?: string;
    orderCode?: string;
  }
) {
  if (!input.lines.length) throw new NotFoundError('Phiếu nhập cần ít nhất một dòng hàng');
  if (input.client) return createInboundOrderTx(input.client, input);
  return withTransaction(input.shard, (c) => createInboundOrderTx(c, input));
}

async function createInboundOrderTx(
  client: PoolClient,
  input: ServiceBase & {
    lines: OrderLineInput[];
    partnerName?: string;
    orderCode?: string;
  }
) {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const orderId = newId();
  const code = input.orderCode || generateOrderCode('PN');
  await client.query(
    `INSERT INTO stock_orders
       (id, warehouse_id, order_code, order_type, status, partner_name, created_by, completed_at)
     VALUES ($1,$2,$3,'INBOUND','COMPLETED',$4,$5,NOW())`,
    [orderId, input.warehouseId, code, input.partnerName || null, actor]
  );

  const balances: unknown[] = [];
  for (const line of input.lines) {
    await client.query(
      `INSERT INTO stock_order_items
         (id, warehouse_id, order_id, product_id, batch_id, location_id, expected_qty, actual_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        newId(),
        input.warehouseId,
        orderId,
        line.productId,
        line.batchId,
        line.locationId,
        line.qty,
      ]
    );
    balances.push(
      await inboundStock({
        shard: input.shard,
        warehouseId: input.warehouseId,
        locationId: line.locationId,
        productId: line.productId,
        batchId: line.batchId,
        qty: line.qty,
        referenceType: 'INBOUND_ORDER',
        referenceId: orderId,
        createdBy: actor,
        client,
      })
    );
  }
  return { orderId, orderCode: code, balances };
}

export async function createOutboundOrder(
  input: ServiceBase & {
    lines: Array<{ productId: string; qty: number }>;
    partnerName?: string;
    orderCode?: string;
  }
) {
  if (!input.lines.length) throw new NotFoundError('Phiếu xuất cần ít nhất một dòng hàng');
  if (input.client) return createOutboundOrderTx(input.client, input);
  return withTransaction(input.shard, (c) => createOutboundOrderTx(c, input));
}

async function createOutboundOrderTx(
  client: PoolClient,
  input: ServiceBase & {
    lines: Array<{ productId: string; qty: number }>;
    partnerName?: string;
    orderCode?: string;
  }
) {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const orderId = newId();
  const code = input.orderCode || generateOrderCode('PX');
  await client.query(
    `INSERT INTO stock_orders
       (id, warehouse_id, order_code, order_type, status, partner_name, created_by)
     VALUES ($1,$2,$3,'OUTBOUND','PICKING',$4,$5)`,
    [orderId, input.warehouseId, code, input.partnerName || null, actor]
  );

  const allocations: Array<{ productId: string; allocations: Allocation[] }> = [];
  for (const line of input.lines) {
    await client.query(
      `INSERT INTO stock_order_items
         (id, warehouse_id, order_id, product_id, expected_qty, actual_qty)
       VALUES ($1,$2,$3,$4,$5,0)`,
      [newId(), input.warehouseId, orderId, line.productId, line.qty]
    );
    allocations.push({
      productId: line.productId,
      allocations: await reserveStockFefo({
        shard: input.shard,
        warehouseId: input.warehouseId,
        productId: line.productId,
        qty: line.qty,
        referenceType: 'OUTBOUND_ORDER',
        referenceId: orderId,
        createdBy: actor,
        client,
      }),
    });
  }
  return { orderId, orderCode: code, allocations };
}

export async function fulfillOutboundOrder(
  input: ServiceBase & { orderId: string }
): Promise<Allocation[]> {
  if (input.client) return fulfillOutboundOrderTx(input.client, input);
  return withTransaction(input.shard, (c) => fulfillOutboundOrderTx(c, input));
}

async function fulfillOutboundOrderTx(
  client: PoolClient,
  input: ServiceBase & { orderId: string }
): Promise<Allocation[]> {
  const order = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM stock_orders
      WHERE id = $1 AND warehouse_id = $2 AND order_type = 'OUTBOUND'`,
    [input.orderId, input.warehouseId]
  );
  if (!order.rowCount) throw new NotFoundError('Không tìm thấy phiếu xuất kho');
  if (order.rows[0].status === 'COMPLETED') return [];

  return consumeReservations({
    shard: input.shard,
    warehouseId: input.warehouseId,
    referenceType: 'OUTBOUND_ORDER',
    referenceId: input.orderId,
    movementType: 'OUTBOUND',
    orderId: input.orderId,
    createdBy: input.createdBy,
    client,
  });
}

/** Xuất nhanh: FEFO + tiêu thụ trong cùng transaction (dùng cho test đồng thời). */
export async function quickOutbound(
  input: ServiceBase & { productId: string; qty: number }
): Promise<{ orderId: string; allocations: Allocation[] }> {
  if (input.client) return quickOutboundTx(input.client, input);
  return withTransaction(input.shard, (c) => quickOutboundTx(c, input));
}

async function quickOutboundTx(
  client: PoolClient,
  input: ServiceBase & { productId: string; qty: number }
): Promise<{ orderId: string; allocations: Allocation[] }> {
  const actor = input.createdBy || SYSTEM_ACTOR_ID;
  const orderId = newId();
  await client.query(
    `INSERT INTO stock_orders
       (id, warehouse_id, order_code, order_type, status, created_by)
     VALUES ($1,$2,$3,'OUTBOUND','PICKING',$4)`,
    [orderId, input.warehouseId, generateOrderCode('PX'), actor]
  );
  await client.query(
    `INSERT INTO stock_order_items
       (id, warehouse_id, order_id, product_id, expected_qty, actual_qty)
     VALUES ($1,$2,$3,$4,$5,$5)`,
    [newId(), input.warehouseId, orderId, input.productId, input.qty]
  );
  await reserveStockFefo({
    shard: input.shard,
    warehouseId: input.warehouseId,
    productId: input.productId,
    qty: input.qty,
    referenceType: 'OUTBOUND_ORDER',
    referenceId: orderId,
    createdBy: actor,
    client,
  });
  const allocations = await consumeReservations({
    shard: input.shard,
    warehouseId: input.warehouseId,
    referenceType: 'OUTBOUND_ORDER',
    referenceId: orderId,
    movementType: 'OUTBOUND',
    orderId,
    createdBy: actor,
    client,
  });
  return { orderId, allocations };
}

export async function getOrder(
  shard: ShardName,
  warehouseId: string,
  orderId: string
) {
  const result = await query(
    shard,
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'id', i.id, 'productId', i.product_id, 'batchId', i.batch_id,
              'locationId', i.location_id, 'expectedQty', i.expected_qty,
              'actualQty', i.actual_qty
            )) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
       FROM stock_orders o
       LEFT JOIN stock_order_items i ON i.order_id = o.id
      WHERE o.id = $1 AND o.warehouse_id = $2
      GROUP BY o.id`,
    [orderId, warehouseId]
  );
  if (!result.rowCount) throw new NotFoundError('Không tìm thấy phiếu kho');
  return result.rows[0];
}
