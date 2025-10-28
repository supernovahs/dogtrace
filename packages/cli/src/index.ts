#!/usr/bin/env node

import { Command } from 'commander';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SERVER_PORT = 8844;
let serverProcess: ChildProcess | null = null;

interface DebugOptions {
  rpc: string;
  contract?: string;
  server?: string;
}

/**
 * Check if server is running
 */
async function isServerRunning(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the DogTrace server
 */
async function startServer(serverUrl: string): Promise<void> {
  const url = new URL(serverUrl);
  const port = url.port || DEFAULT_SERVER_PORT;

  console.log(`🚀 Starting DogTrace server on port ${port}...`);

  // Find server entry point (bundled with CLI)
  const serverPath = path.join(__dirname, 'server/dist/index.js');

  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: port.toString() },
    stdio: 'ignore', // Fully detach - no terminal blocking
    detached: true,
  });

  // Detach from parent process so it keeps running in background
  serverProcess.unref();

  // Wait for server to be ready via health checks
  let attempts = 0;
  while (attempts < 30) {
    if (await isServerRunning(serverUrl)) {
      console.log(`✅ Server started in background`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  throw new Error('Server failed to start within 30 seconds');
}

/**
 * Ensure server is running, start if needed
 */
async function ensureServer(serverUrl: string): Promise<void> {
  if (await isServerRunning(serverUrl)) {
    return;
  }

  await startServer(serverUrl);
}

// Note: Server keeps running in background for faster subsequent requests

/**
 * Stop the DogTrace server
 */
async function stopServerByPort(
  port: number = DEFAULT_SERVER_PORT
): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    // Find process on port
    const { stdout } = await execAsync(`lsof -ti:${port}`);
    const pid = stdout.trim();

    if (!pid) {
      console.log('✅ No server running on port', port);
      return;
    }

    // Kill the process
    await execAsync(`kill ${pid}`);
    console.log(`✅ Server stopped (PID: ${pid})`);
  } catch (error) {
    console.log('✅ No server running on port', port);
  }
}

const program = new Command();

program
  .name('dog')
  .description('🐕 DogTrace - Visual debugger for Solidity')
  .version('0.1.0');

program
  .command('debug <tx-hash>')
  .description('Debug a transaction and generate a PDF report')
  .option('--rpc <url>', 'RPC endpoint', 'http://localhost:8545')
  .option(
    '--contract <path>',
    'Path to Solidity contract source file (optional)'
  )
  .option('--server <url>', 'Debug server URL', 'http://localhost:8844')
  .action(async (txHash: string, options: DebugOptions) => {
    try {
      console.log('🐕 DogTrace - Debugging transaction...');
      console.log(`Transaction: ${txHash}`);
      console.log(`RPC: ${options.rpc}`);
      if (options.contract) {
        console.log(`Contract: ${options.contract}`);
      }
      console.log('');

      // Ensure server is running
      await ensureServer(
        options.server || `http://localhost:${DEFAULT_SERVER_PORT}`
      );

      // Build API URL with query parameters
      const url = new URL(`${options.server}/api/debug/${txHash}`);
      url.searchParams.set('rpcUrl', options.rpc);
      if (options.contract) {
        url.searchParams.set('contractPath', options.contract);
      }

      console.log('📡 Fetching debug session...');
      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }

      const session = await response.json();

      // ANSI color codes
      const colors = {
        reset: '\x1b[0m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        cyan: '\x1b[36m',
        gray: '\x1b[90m',
        bold: '\x1b[1m',
      };

      // Display transaction summary in a box
      const boxWidth = 70;
      const topBorder = `┌${'─'.repeat(boxWidth - 2)}┐`;
      const bottomBorder = `└${'─'.repeat(boxWidth - 2)}┘`;
      const divider = `├${'─'.repeat(boxWidth - 2)}┤`;

      const padLine = (text: string) => {
        const stripped = text.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI codes for length calc
        const padding = Math.max(0, boxWidth - 2 - stripped.length);
        return `│ ${text}${' '.repeat(padding)}│`;
      };

      console.log('\n' + colors.cyan + topBorder + colors.reset);
      console.log(padLine(`${colors.bold}TRANSACTION SUMMARY${colors.reset}`));
      console.log(colors.cyan + divider + colors.reset);

      const statusColor = session.result.success ? colors.green : colors.red;
      const statusText = session.result.success ? 'Success' : 'Failed';
      console.log(
        padLine(`Status:     ${statusColor}${statusText}${colors.reset}`)
      );
      console.log(
        padLine(
          `Gas Used:   ${session.result.gasUsed} (${((session.result.gasUsed / session.transaction.gasLimit) * 100).toFixed(2)}%)`
        )
      );
      console.log(padLine(`Block:      ${session.transaction.blockNumber}`));

      if (session.result.error) {
        console.log(colors.cyan + divider + colors.reset);
        console.log(
          padLine(`${colors.red}Error: ${session.result.error}${colors.reset}`)
        );

        if (session.result.revertLocation) {
          const loc = session.result.revertLocation;
          console.log(colors.cyan + divider + colors.reset);
          console.log(
            padLine(`${colors.yellow}REVERT LOCATION${colors.reset}`)
          );
          if (loc.functionContext) {
            console.log(
              padLine(`Function:   ${loc.functionContext.functionName}()`)
            );
          }
          console.log(padLine(`Line ${loc.line}:     ${loc.snippet}`));
        }
      }

      // Display storage changes
      if (session.analysis?.storageChanges?.length > 0) {
        console.log(colors.cyan + divider + colors.reset);
        console.log(
          padLine(
            `${colors.yellow}STORAGE CHANGES (${session.analysis.storageChanges.length})${colors.reset}`
          )
        );
        session.analysis.storageChanges.slice(0, 5).forEach((change: any) => {
          const varInfo = session.storageLayout?.[change.slotNumber];
          if (varInfo) {
            console.log(
              padLine(
                `${varInfo.name}: ${change.oldValueDecimal} → ${change.newValueDecimal}`
              )
            );
          } else {
            console.log(
              padLine(
                `Slot ${change.slotNumber}: ${change.oldValueDecimal} → ${change.newValueDecimal}`
              )
            );
          }
        });
        if (session.analysis.storageChanges.length > 5) {
          console.log(
            padLine(
              `${colors.gray}... and ${session.analysis.storageChanges.length - 5} more${colors.reset}`
            )
          );
        }
      }

      // Generate PDF report
      const pdfUrl = new URL(`${options.server}/api/debug/${txHash}/pdf`);
      pdfUrl.searchParams.set('rpcUrl', options.rpc);
      if (options.contract) {
        pdfUrl.searchParams.set('contractPath', options.contract);
      }

      const pdfResponse = await fetch(pdfUrl.toString(), { method: 'POST' });

      if (!pdfResponse.ok) {
        throw new Error(`Failed to generate PDF: ${pdfResponse.status}`);
      }

      const pdfResult = await pdfResponse.json();

      console.log(colors.cyan + bottomBorder + colors.reset);

      // PDF Report links (outside box for clickability)
      console.log(`\n${colors.yellow}PDF Report:${colors.reset}`);
      console.log(pdfResult.path);
      console.log(`${options.server}${pdfResult.url}`);
    } catch (error) {
      console.error(
        '\n❌ Error:',
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the DogTrace server')
  .action(async () => {
    try {
      await stopServerByPort(DEFAULT_SERVER_PORT);
    } catch (error) {
      console.error(
        '❌ Error:',
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  });

program.parse();
