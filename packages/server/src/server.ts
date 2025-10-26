import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { setupRoutes } from './api/routes.js';

export function createServer(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve PDF reports from temp directory
  const reportsDir = path.join(os.tmpdir(), 'dogtrace-reports');
  app.use('/reports', express.static(reportsDir));

  app.get('/health', (_, res) => {
    res.json({
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Setup API routes
  setupRoutes(app);

  return app;
}
