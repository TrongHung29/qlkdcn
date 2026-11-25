import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes';
import distributedRoutes from './distributed/routes/distributed.routes';
import { errorHandler } from './middlewares/error.middleware';
import { correlationMiddleware } from './middlewares/correlation.middleware';

dotenv.config();

export const createApp = (): Application => {
  const app = express();

  // Middlewares
  app.use(
    cors({
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(correlationMiddleware);

  // Healthcheck endpoint
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'Warehouse Management System (WMS) API',
      version: '1.0.0',
    });
  });

  // RESTful API Routes (legacy - giao diện tiếng Việt hiện tại)
  app.use('/api', apiRoutes);

  // Distributed Warehouse API (UUIDv7 + FEFO + Saga/Outbox/Inbox)
  app.use('/api/v2', distributedRoutes);

  // Global Error Handler
  app.use(errorHandler);

  return app;
};
