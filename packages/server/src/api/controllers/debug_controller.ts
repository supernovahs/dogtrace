import type {Request, Response,NextFunction} from 'express';
import { DebugService } from '../../services/debug_service.js';
import { PDFGenerator } from '../../services/pdf_generator.js';


export async function debugTransaction(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {

     try {
    const { txHash } = req.params;
    // Support both query params (GET) and body params (POST)
    const rpcUrl = (req.query.rpcUrl as string) || req.body?.rpcUrl;
    const contractPath = (req.query.contractPath as string) || req.body?.contractPath;

    if (txHash == undefined){
        throw new Error("txHash undefined")
    }

    // Debug transaction
    const debug_service = new DebugService(rpcUrl);
    const session = await debug_service.debug(txHash, {
      rpcUrl,
      ...(contractPath && { contractPath })
    });

    res.json(session);

  } catch (error) {
    next(error);
  }
}

export async function debugTransactionPDF(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { txHash } = req.params;
    // Support both query params (GET) and body params (POST)
    const rpcUrl = (req.query.rpcUrl as string) || req.body?.rpcUrl;
    const contractPath = (req.query.contractPath as string) || req.body?.contractPath;

    if (txHash == undefined) {
      throw new Error('txHash undefined');
    }

    // Debug transaction
    const debug_service = new DebugService(rpcUrl);
    const session = await debug_service.debug(txHash, {
      rpcUrl,
      ...(contractPath && { contractPath })
    });

    // Generate PDF
    const pdfGenerator = new PDFGenerator();
    const { pdfUrl, pdfPath } = await pdfGenerator.saveTransactionReport(session, txHash);

    res.json({
      success: true,
      url: pdfUrl,
      path: pdfPath,
      message: 'PDF report generated successfully.',
    });
  } catch (error) {
    next(error);
  }
}