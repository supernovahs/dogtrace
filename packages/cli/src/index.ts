#!/usr/bin/env node

import { Command } from 'commander';

interface DebugOptions {
  rpc: string;
  contract?: string;
  server?: string;
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
  .option('--contract <path>', 'Path to Solidity contract source file (optional)')
  .option('--server <url>', 'Debug server URL', 'http://localhost:3000')
  .action(async (txHash: string, options: DebugOptions) => {
    try {
      console.log('🐕 DogTrace - Debugging transaction...');
      console.log(`Transaction: ${txHash}`);
      console.log(`RPC: ${options.rpc}`);
      if (options.contract) {
        console.log(`Contract: ${options.contract}`);
      }
      console.log(`Server: ${options.server}`);
      console.log('');

      // Build API URL with query parameters
      const url = new URL(`${options.server}/api/debug/${txHash}`);
      url.searchParams.set('rpcUrl', options.rpc);
      if (options.contract) {
        url.searchParams.set('contractPath', options.contract);
      }

      console.log('📡 Fetching debug session...');
      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }

      const session = await response.json();

      // Display transaction summary
      console.log('\n📊 Transaction Summary');
      console.log('━'.repeat(50));
      console.log(`Status: ${session.result.success ? '✅ Success' : '❌ Failed'}`);
      console.log(`Gas Used: ${session.result.gasUsed} (${((session.result.gasUsed / session.transaction.gasLimit) * 100).toFixed(2)}%)`);
      console.log(`Block: ${session.transaction.blockNumber}`);

      if (session.result.error) {
        console.log(`\n❌ Error: ${session.result.error}`);

        if (session.result.revertLocation) {
          const loc = session.result.revertLocation;
          console.log(`\n📍 Revert Location:`);
          if (loc.functionContext) {
            console.log(`   Function: ${loc.functionContext.functionName}()`);
          }
          console.log(`   Line ${loc.line}: ${loc.snippet}`);
        }
      }

      // Display storage changes
      if (session.analysis?.storageChanges?.length > 0) {
        console.log(`\n💾 Storage Changes (${session.analysis.storageChanges.length})`);
        console.log('━'.repeat(50));
        session.analysis.storageChanges.slice(0, 5).forEach((change: any) => {
          const varInfo = session.storageLayout?.[change.slotNumber];
          if (varInfo) {
            console.log(`   ${varInfo.name}: ${change.oldValueDecimal} → ${change.newValueDecimal}`);
          } else {
            console.log(`   Slot ${change.slotNumber}: ${change.oldValueDecimal} → ${change.newValueDecimal}`);
          }
        });
        if (session.analysis.storageChanges.length > 5) {
          console.log(`   ... and ${session.analysis.storageChanges.length - 5} more`);
        }
      }

      // Generate PDF report
      console.log('\n📄 Generating PDF report...');
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

      console.log(`\n✅ Report generated successfully!`);
      console.log(`📎 ${options.server}${pdfResult.url}`);
      console.log(`💾 ${pdfResult.path}`);

    } catch (error) {
      console.error('\n❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
