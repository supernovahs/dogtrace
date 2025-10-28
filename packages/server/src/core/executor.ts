import { ethers } from 'ethers';

export interface ExecutionTrace {
  step: number;
  pc: number;
  opcode: string;
  gas: number;
  gasCost?: number;
  stack: string[];
  memory?: string;
  storage?: {
    key: string;
    value: string;
  };
  depth: number;
}

/**
 * Transaction execution result
 */
export interface ExecutionResult {
  tx: ethers.TransactionResponse;
  block: ethers.Block;
  traces: ExecutionTrace[];
  result: {
    success: boolean;
    gasUsed: bigint;
    returnData?: string;
    error?: string;
  };
  analysis?: {
    functionSelector?: string;
    storageChanges: Array<{
      slot: string;
      slotNumber: number;
      oldValue: string;
      newValue: string;
      oldValueDecimal: string;
      newValueDecimal: string;
      step: number;
    }>;
  };
}

/**
 * Transaction executor for local development nodes
 * Requires debug_traceTransaction RPC support (Anvil, Hardhat, Ganache)
 */
export class TransactionExecutor {
  private provider: ethers.JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Get the provider instance
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  /**
   * Execute transaction and capture full execution trace
   */
  async executeWithTrace(txHash: string): Promise<ExecutionResult> {
    try {
      console.log(`\n🔍 Analyzing transaction: ${txHash}`);

      // 1. Fetch transaction
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) {
        throw new Error('Transaction not found');
      }

      // 2. Fetch receipt
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      // 3. Fetch block
      if (!tx.blockNumber) {
        throw new Error('Transaction not yet mined');
      }

      const block = await this.provider.getBlock(tx.blockNumber);
      if (!block) {
        throw new Error('Block not found');
      }

      console.log(`📦 Block: ${block.number}`);
      console.log(
        `⛽ Gas Used: ${receipt.gasUsed.toString()} / ${tx.gasLimit.toString()}`
      );
      console.log(`✅ Status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);

      // 4. Get execution trace via debug_traceTransaction
      console.log(`\n🔎 Fetching execution trace...`);

      // Try default tracer first (works better with Anvil)
      let traceResult = await this.provider.send('debug_traceTransaction', [
        txHash,
      ]);

      // If that didn't work, try with explicit options
      if (!traceResult.structLogs || traceResult.structLogs.length === 0) {
        console.log(
          `⚠️  Default tracer returned empty logs, trying with options...`
        );
        traceResult = await this.provider.send('debug_traceTransaction', [
          txHash,
          {
            enableMemory: true,
            enableReturnData: true,
            disableStorage: false,
            disableStack: false,
          },
        ]);
      }

      console.log(
        `✅ Trace received: ${traceResult.structLogs?.length || 0} steps`
      );

      // Debug: log the actual trace result structure
      if (!traceResult.structLogs || traceResult.structLogs.length === 0) {
        console.log(
          `⚠️  Empty trace! Full result:`,
          JSON.stringify(traceResult, null, 2).slice(0, 500)
        );
      }

      // 5. Parse trace into our format
      const traces = this.parseTrace(traceResult);

      // 6. Extract storage changes
      const storageChanges = this.extractStorageChanges(traces);

      console.log(`💾 Storage changes: ${storageChanges.length}`);

      // 7. Extract function selector
      const functionSelector =
        tx.data.length >= 10 ? tx.data.slice(0, 10) : undefined;

      // Decode panic/revert reason from returnValue
      let errorMessage = traceResult.revertReason || 'Transaction reverted';
      if (receipt.status === 0 && traceResult.returnValue) {
        const returnData = traceResult.returnValue;
        // Check if it's a Panic error: 0x4e487b71 (selector) + uint256 (code)
        if (returnData.startsWith('4e487b71')) {
          const panicCode = parseInt(returnData.slice(8), 16);
          const panicReasons: Record<number, string> = {
            0x01: 'Assertion failed',
            0x11: 'Arithmetic overflow/underflow (unchecked)',
            0x12: 'Division or modulo by zero',
            0x21: 'Invalid enum value',
            0x22: 'Invalid storage byte array',
            0x31: 'Pop on empty array',
            0x32: 'Array index out of bounds',
            0x41: 'Out of memory',
            0x51: 'Invalid internal function',
          };
          errorMessage = `Panic(${panicCode}): ${panicReasons[panicCode] || 'Unknown panic'}`;
        }
        // Check if it's a Error(string): 0x08c379a0
        else if (returnData.startsWith('08c379a0')) {
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ['string'],
              '0x' + returnData.slice(8)
            );
            errorMessage = `Error: ${decoded[0]}`;
          } catch (e) {}
        }
      }

      return {
        tx,
        block,
        traces,
        result: {
          success: receipt.status === 1,
          gasUsed: receipt.gasUsed,
          ...(traceResult.returnValue && {
            returnData: '0x' + traceResult.returnValue,
          }),
          ...(receipt.status === 0 && {
            error: errorMessage,
          }),
        },
        analysis: {
          ...(functionSelector && { functionSelector }),
          storageChanges,
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        // Check if it's a "method not found" error
        if (error.message.includes('debug_traceTransaction')) {
          throw new Error(
            'debug_traceTransaction not available. ' +
              'Make sure you are connected to a LOCAL node (Anvil/Hardhat), ' +
              'not a public RPC endpoint.'
          );
        }
        throw error;
      }
      throw new Error('Execution failed');
    }
  }

  /**
   * Parse debug_traceTransaction result into our ExecutionTrace format
   */
  private parseTrace(traceResult: any): ExecutionTrace[] {
    const structLogs = traceResult.structLogs || [];
    const traces: ExecutionTrace[] = [];

    let lastGas = 0;

    for (let i = 0; i < structLogs.length; i++) {
      const log = structLogs[i];

      const trace: ExecutionTrace = {
        step: i,
        pc: log.pc,
        opcode: log.op,
        gas: log.gas,
        gasCost: lastGas > 0 ? lastGas - log.gas : log.gasCost || 0,
        stack: log.stack || [],
        memory: log.memory ? '0x' + log.memory.join('') : '0x',
        depth: log.depth || 0,
      };

      // Capture storage changes for SSTORE operations
      if (log.op === 'SSTORE' && log.stack && log.stack.length >= 2) {
        const key = log.stack[log.stack.length - 1];
        const value = log.stack[log.stack.length - 2];

        trace.storage = {
          key: this.padHex(key, 64),
          value: this.padHex(value, 64),
        };
      }

      lastGas = log.gas;
      traces.push(trace);
    }

    return traces;
  }

  /**
   * Extract storage changes from traces
   */
  private extractStorageChanges(traces: ExecutionTrace[]) {
    // Track SLOAD operations to get old values
    const storageReads = new Map<string, string>();

    traces.forEach((t, index) => {
      if (t.opcode === 'SLOAD' && t.stack.length >= 1) {
        const slotValue = t.stack[t.stack.length - 1];
        if (!slotValue) return;

        const slot = this.padHex(slotValue, 64);

        // The loaded value appears on stack in NEXT step
        const nextTrace = traces[index + 1];
        if (nextTrace && nextTrace.stack.length > 0) {
          const loadedValue = nextTrace.stack[nextTrace.stack.length - 1];
          if (loadedValue) {
            storageReads.set(slot, loadedValue);
          }
        }
      }
    });

    // Extract SSTORE operations with old/new values
    const storageChanges = traces
      .filter((t) => t.storage)
      .map((t) => {
        const slot = t.storage!.key;
        const newValue = t.storage!.value;
        const oldValue = storageReads.get(slot) || '0x' + '0'.repeat(64);

        // Parse slot number
        const slotNumber = parseInt(slot, 16);

        // Convert to decimal
        const oldValueBigInt = BigInt(oldValue);
        const newValueBigInt = BigInt(newValue);

        return {
          slot,
          slotNumber,
          oldValue,
          newValue,
          oldValueDecimal: oldValueBigInt.toString(),
          newValueDecimal: newValueBigInt.toString(),
          step: t.step,
        };
      });

    return storageChanges;
  }

  /**
   * Pad hex string to specified length
   */
  private padHex(hex: string, length: number): string {
    // Remove 0x prefix if present
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    return '0x' + clean.padStart(length, '0');
  }
}
