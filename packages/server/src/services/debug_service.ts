import { TransactionExecutor } from '../core/executor.js';
import { StorageLayoutParser } from './storage_layout.js';
import type { FunctionContext } from './storage_layout.js';
import { randomUUID } from 'crypto';

export interface DebugOptions {
  rpcUrl?: string;
  contractPath?: string;
}

/**
 * Simplified Debug Session (tracing only)
 */
export interface DebugSession {
  id: string;
  createdAt: string;

  // Transaction info
  transaction: {
    hash: string;
    from: string;
    to: string | null;
    value: string;
    blockNumber: number;
    gasLimit: number;
  };

  // Source code (optional - may not be available)
  source: {
    contractName: string;
    code: string;
    sourceMap: string;
  } | null;

  // Storage layout (optional - from source code)
  storageLayout?: Record<
    number,
    {
      name: string;
      type: string;
      slot: number;
    }
  >;

  // Execution traces
  traces: ExecutionTrace[];

  // Result
  result: {
    success: boolean;
    gasUsed: number;
    error?: string;
    revertLocation?: {
      line: number;
      column: number;
      snippet: string;
      functionContext?: FunctionContext;
    };
  };

  // Analysis
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
 * Execution trace
 */
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

  // Source location (if source code available)
  sourceLocation?: {
    file: string;
    line: number;
    column: number;
  };
}

export class DebugService {
  private executors: Map<string, TransactionExecutor> = new Map();

  constructor(private defaultRpcUrl: string) {}

  async debug(
    txHash: string,
    options: DebugOptions = {}
  ): Promise<DebugSession> {
    try {
      // 1. Get executor
      const rpcUrl = options.rpcUrl || this.defaultRpcUrl;
      const executor = this.getExecutor(rpcUrl);

      // 2. Execute transaction with tracing
      //   logger.info(`Executing transaction ${txHash}...`);
      const executionResult = await executor.executeWithTrace(txHash);

      //   logger.info(`Execution complete: ${executionResult.traces.length} steps`, {
      //     gasUsed: executionResult.result.gasUsed.toString(),
      //     success: executionResult.result.success,
      //   });

      // 3. Try to load storage layout from source code (optional)
      let storageLayout: Record<number, any> | undefined = undefined;
      let parser: StorageLayoutParser | undefined = undefined;

      if (options.contractPath) {
        console.log(`📄 Loading contract source: ${options.contractPath}`);
        try {
          // Fetch deployed bytecode if we have a contract address
          let deployedBytecode: string | undefined = undefined;
          if (executionResult.tx.to) {
            const provider = executor.getProvider();
            const blockNumber = executionResult.tx.blockNumber! - 1;
            deployedBytecode = await provider.getCode(
              executionResult.tx.to,
              blockNumber
            );
            console.log(
              `Fetched deployed bytecode: ${deployedBytecode.slice(0, 100)}... (length: ${deployedBytecode.length})`
            );
          }

          parser = new StorageLayoutParser();
          const layoutMap = await parser.parseContract(
            options.contractPath,
            deployedBytecode
          );
          console.log(
            `✅ Loaded storage layout with ${layoutMap.size} variables`
          );

          // Convert Map to plain object for JSON serialization
          if (layoutMap.size > 0) {
            storageLayout = {};
            layoutMap.forEach((value, key) => {
              storageLayout![key] = value;
            });
          }
        } catch (error) {
          console.warn(`Could not load storage layout: ${error}`);
        }
      } else {
        console.log(`ℹ️  No contract source provided - features disabled:`);
        console.log(`   - Variable names in storage changes`);
        console.log(
          `   - Precise revert location (will use heuristic fallback)`
        );
      }

      // 4. Find revert location if transaction failed
      // Use proper source mapping like production debuggers
      let revertLocation = undefined;
      if (!executionResult.result.success && parser) {
        // Find the REVERT or INVALID opcode in the trace
        const revertIndex = executionResult.traces.findIndex(
          (t) => t.opcode === 'REVERT' || t.opcode === 'INVALID'
        );

        if (revertIndex !== -1) {
          const revertTrace = executionResult.traces[revertIndex];

          if (revertTrace) {
            console.log(
              `\nRevert detected at step ${revertIndex}, PC ${revertTrace.pc}`
            );

            // Show the last 30 opcodes before the revert to understand what caused it
            console.log('\nOpcodes leading to revert (last 30):');
            for (let i = Math.max(0, revertIndex - 30); i <= revertIndex; i++) {
              const t = executionResult.traces[i];
              if (t) {
                console.log(`  Step ${t.step}: ${t.opcode} (PC ${t.pc})`);
              }
            }

            // The revert is in compiler-generated code (file index 1)
            // We need to find where we were in the user's source code (file index 0) before entering it
            let triggerPC = revertTrace.pc;

            // Search backwards through the entire trace to find the last instruction in file index 0
            console.log(
              '\nSearching for last instruction in user source code (file index 0)...'
            );
            for (let i = revertIndex - 1; i >= 0; i--) {
              const trace = executionResult.traces[i];
              if (!trace) continue;

              // Use the parser to check what file index this PC maps to
              const tempLoc = parser.getSourceLocation(trace.pc);
              if (tempLoc && tempLoc.line > 0) {
                // Found a valid source location in file index 0
                console.log(
                  `Found last source instruction at step ${i}, PC ${trace.pc}: ${trace.opcode}`
                );
                console.log(
                  `  Maps to line ${tempLoc.line}: ${tempLoc.snippet}`
                );
                triggerPC = trace.pc;
                break;
              }
            }

            if (triggerPC === revertTrace.pc) {
              console.log('Could not find any instruction in user source code');
            }

            // Map the trigger PC to source location using source maps
            const loc = parser.getSourceLocation(triggerPC);

            if (loc && loc.line > 1) {
              // Get full function context
              const functionContext = parser.getFunctionContext(loc.line);

              revertLocation = {
                line: loc.line,
                column: loc.column,
                snippet: loc.snippet,
                ...(functionContext && { functionContext }),
              };

              console.log(`\nReverted at Line ${loc.line}: ${loc.snippet}`);
              if (functionContext) {
                console.log(`Function: ${functionContext.functionName}()`);
              }
            } else {
              // Fallback: source map failed, try finding require statements
              console.warn(
                'Source map parsing failed, falling back to require detection'
              );
              const requires = parser.findAllRequires();
              if (requires.length > 0 && requires[0]) {
                const req = requires[0];
                const functionContext = parser.getFunctionContext(req.line);

                revertLocation = {
                  line: req.line,
                  column: 1,
                  snippet: req.snippet,
                  ...(functionContext && { functionContext }),
                };
              }
            }
          }
        }
      }

      // 5. Source mapping (disabled for now)
      // TODO: Implement source mapping when local source loading is added
      const mappedTraces = executionResult.traces;
      let source = null;

      // 5. Build debug session
      const session: DebugSession = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),

        transaction: {
          hash: txHash,
          from: executionResult.tx.from,
          to: executionResult.tx.to || null,
          value: executionResult.tx.value.toString(),
          blockNumber: executionResult.tx.blockNumber!,
          gasLimit: Number(executionResult.tx.gasLimit),
        },

        source,

        ...(storageLayout && { storageLayout }),

        traces: mappedTraces,

        result: {
          success: executionResult.result.success,
          gasUsed: Number(executionResult.result.gasUsed),
          ...(executionResult.result.error && {
            error: executionResult.result.error,
          }),
          ...(revertLocation && {
            revertLocation,
          }),
        },

        ...(executionResult.analysis && {
          analysis: executionResult.analysis,
        }),
      };

      return session;
    } catch (error) {
      console.error(`Failed to debug ${txHash}:`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to debug transaction: ${error.message}`);
      }
      throw new Error('Failed to debug transaction');
    }
  }

  /**
   * Get or create executor for RPC URL
   */
  private getExecutor(rpcUrl: string): TransactionExecutor {
    if (!this.executors.has(rpcUrl)) {
      this.executors.set(rpcUrl, new TransactionExecutor(rpcUrl));
    }

    return this.executors.get(rpcUrl)!;
  }
}
