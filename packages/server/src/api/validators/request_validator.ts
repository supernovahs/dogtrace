import type { Request, Response, NextFunction } from 'express';

export function validateTxHash(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { txHash } = req.params;
  if (txHash == undefined) {
    throw new Error('txHash not available')
  }
  const isValid = /^0x[a-fA-F0-9]{64}$/.test(txHash);

  if (!isValid) {
    throw new Error(
      'Invalid Ethereum address format. Expected: 0x followed by 40 hex characters'
    );
  }

  next();
}
