import type { Express } from 'express';
import { Router } from 'express';
import morgan from 'morgan';

import { validateTxHash } from './validators/request_validator.js';
import { debugTransaction, debugTransactionPDF } from './controllers/debug_controller.js';

export function setupRoutes(app: Express): void {
  const apiRouter = Router();
  apiRouter.use(morgan('dev'));

  // Debug endpoints
  apiRouter.get('/debug/:txHash', validateTxHash, debugTransaction);
  apiRouter.post('/debug/:txHash', validateTxHash, debugTransaction);
  apiRouter.post('/debug/:txHash/pdf', validateTxHash, debugTransactionPDF);

  // Mount API router
  app.use('/api', apiRouter);
}
