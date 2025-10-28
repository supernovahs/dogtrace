import solc from 'solc';
import fs from 'fs';
import path from 'path';

export interface StorageVariable {
  name: string;
  type: string;
  slot: number;
}

export interface SourceMapEntry {
  start: number;
  length: number;
  fileIndex: number;
  jump: string;
}

export interface FunctionContext {
  functionName: string;
  startLine: number;
  endLine: number;
  code: string;
  revertLine: number;
}

export class StorageLayoutParser {
  private sourceCode: string = '';
  private sourceMap: string = '';
  private bytecode: string = '';
  private pcToInstructionIndex: Map<number, number> = new Map();

  /**
   * Parse Solidity source file and extract storage layout
   * @param contractPath - Path to the Solidity source file
   * @param deployedBytecode - Optional deployed bytecode to use for PC mapping (without 0x prefix)
   */
  async parseContract(
    contractPath: string,
    deployedBytecode?: string
  ): Promise<Map<number, StorageVariable>> {
    const storageMap = new Map<number, StorageVariable>();

    try {
      // Read source file
      const source = fs.readFileSync(contractPath, 'utf-8');
      this.sourceCode = source;

      // Use the path relative to the project root or absolute path
      // This ensures file indices match Foundry's compilation
      // If the path contains 'src/', use the portion starting from 'src/'
      let sourceKey = path.basename(contractPath);
      const srcIndex = contractPath.indexOf('src/');
      if (srcIndex !== -1) {
        sourceKey = contractPath.substring(srcIndex);
      }
      console.log(`Using source key: ${sourceKey}`);

      // Prepare compiler input
      const input = {
        language: 'Solidity',
        sources: {
          [sourceKey]: {
            content: source,
          },
        },
        settings: {
          outputSelection: {
            '*': {
              '*': [
                'storageLayout',
                'evm.deployedBytecode.sourceMap',
                'evm.deployedBytecode.object',
              ],
            },
          },
        },
      };

      // Compile
      const output = JSON.parse(solc.compile(JSON.stringify(input)));

      // Check for errors
      if (output.errors) {
        const errors = output.errors.filter((e: any) => e.severity === 'error');
        if (errors.length > 0) {
          console.error('Compilation errors:', errors);
          return storageMap;
        }
      }

      // Extract storage layout from first contract found
      const contracts = output.contracts[sourceKey];
      if (!contracts) {
        console.warn(`No contracts found for source key: ${sourceKey}`);
        console.warn('Available keys:', Object.keys(output.contracts || {}));
        return storageMap;
      }

      const contractNames = Object.keys(contracts);
      if (contractNames.length === 0) {
        console.warn('No contracts found in compiled output');
        return storageMap;
      }

      const contractName = contractNames[0];
      if (!contractName) {
        console.warn('Contract name is undefined');
        return storageMap;
      }

      const contract = contracts[contractName];

      if (!contract.storageLayout || !contract.storageLayout.storage) {
        console.warn('No storage layout found');
        return storageMap;
      }

      // Store source map and bytecode for PC-to-source mapping
      if (contract.evm && contract.evm.deployedBytecode) {
        if (contract.evm.deployedBytecode.sourceMap) {
          this.sourceMap = contract.evm.deployedBytecode.sourceMap;
        }
        if (contract.evm.deployedBytecode.object) {
          const compiledBytecode = contract.evm.deployedBytecode.object;

          // Use deployed bytecode if provided, otherwise use compiled bytecode
          if (deployedBytecode) {
            // Strip 0x prefix if present
            this.bytecode = deployedBytecode.startsWith('0x')
              ? deployedBytecode.slice(2)
              : deployedBytecode;

            // Compare with compiled bytecode (ignore metadata hash at the end)
            // Metadata is appended as: 0xa2 0x64 'i' 'p' 'f' 's' 0x58 0x22 <34 bytes> 0x64 's' 'o' 'l' 'c' 0x43 <3 bytes>
            // We'll compare the first significant portion
            const minLength = Math.min(
              compiledBytecode.length,
              this.bytecode.length
            );
            const compareLength = Math.min(500, minLength); // Compare first 250 bytes

            const compiledPrefix = compiledBytecode.slice(0, compareLength);
            const deployedPrefix = this.bytecode.slice(0, compareLength);

            if (compiledPrefix !== deployedPrefix) {
              console.warn(
                '\n⚠️  WARNING: Deployed bytecode does not match compiled bytecode!'
              );
              console.warn('This may happen if:');
              console.warn('  - Different compiler version was used');
              console.warn('  - Different optimizer settings');
              console.warn('  - Source code does not match deployed contract');
              console.warn(
                `Compiled bytecode (first 100 chars): ${compiledBytecode.slice(0, 100)}...`
              );
              console.warn(
                `Deployed bytecode (first 100 chars): ${this.bytecode.slice(0, 100)}...`
              );
              console.warn('Source mapping may be inaccurate!\n');
            } else {
              console.log(
                '✓ Deployed bytecode matches compiled bytecode (first 250 bytes)'
              );
            }
          } else {
            this.bytecode = compiledBytecode;
            console.log('Using compiled bytecode for PC mapping');
          }

          // Build PC to instruction index map
          this.pcToInstructionIndex = this.buildPCToInstructionMap(
            this.bytecode
          );
          console.log(
            `Built PC map with ${this.pcToInstructionIndex.size} entries from ${deployedBytecode ? 'deployed' : 'compiled'} bytecode`
          );
        }
      }

      // Parse storage layout
      contract.storageLayout.storage.forEach((item: any) => {
        const slot = parseInt(item.slot);
        storageMap.set(slot, {
          name: item.label,
          type: item.type,
          slot: slot,
        });
      });

      console.log(
        `Loaded storage layout for ${contractName}:`,
        Array.from(storageMap.entries())
      );

      return storageMap;
    } catch (error) {
      console.error('Error parsing contract:', error);
      return storageMap;
    }
  }

  /**
   * Build mapping from PC (bytecode offset) to instruction index
   * PUSH1-PUSH32 are 1+N bytes, all other opcodes are 1 byte
   */
  private buildPCToInstructionMap(bytecode: string): Map<number, number> {
    const map = new Map<number, number>();

    // Remove 0x prefix if present
    const code = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;

    let pc = 0;
    let instructionIndex = 0;

    while (pc < code.length / 2) {
      // Map current PC to instruction index
      map.set(pc, instructionIndex);

      // Read opcode
      const opcode = parseInt(code.slice(pc * 2, pc * 2 + 2), 16);

      // Check if it's a PUSH instruction (0x60-0x7f)
      if (opcode >= 0x60 && opcode <= 0x7f) {
        // PUSH1 = 0x60 (1 byte data), PUSH32 = 0x7f (32 bytes data)
        const pushDataLength = opcode - 0x5f;
        pc += 1 + pushDataLength; // opcode + data
      } else {
        pc += 1; // Just the opcode
      }

      instructionIndex++;
    }

    return map;
  }

  /**
   * Parse source map and build instruction index -> source location mapping
   * Source map format: s:l:f:j;s:l:f:j;...
   * s = start byte offset in source
   * l = length in bytes
   * f = file index
   * j = jump type (i=into, o=out of, -=regular)
   * Empty fields use previous value (compression)
   */
  private buildSourceMapCache(): Map<
    number,
    { start: number; length: number; fileIndex: number }
  > {
    const cache = new Map<
      number,
      { start: number; length: number; fileIndex: number }
    >();

    if (!this.sourceMap) return cache;

    try {
      const entries = this.sourceMap.split(';');

      let lastStart = 0;
      let lastLength = 0;
      let lastFileIndex = 0;
      let lastJump = '-';

      entries.forEach((entry, pc) => {
        if (!entry) {
          // Empty entry - use all previous values
          cache.set(pc, {
            start: lastStart,
            length: lastLength,
            fileIndex: lastFileIndex,
          });
          return;
        }

        const parts = entry.split(':');

        // Parse each field, using previous value if empty
        if (parts[0] !== undefined && parts[0] !== '') {
          lastStart = parseInt(parts[0]);
        }
        if (parts[1] !== undefined && parts[1] !== '') {
          lastLength = parseInt(parts[1]);
        }
        if (parts[2] !== undefined && parts[2] !== '') {
          lastFileIndex = parseInt(parts[2]);
        }
        if (parts[3] !== undefined && parts[3] !== '') {
          lastJump = parts[3];
        }

        cache.set(pc, {
          start: lastStart,
          length: lastLength,
          fileIndex: lastFileIndex,
        });
      });

      return cache;
    } catch (error) {
      console.error('Error building source map cache:', error);
      return cache;
    }
  }

  /**
   * Get source location from PC value using proper source map parsing
   */
  getSourceLocation(
    pc: number
  ): { line: number; column: number; snippet: string } | null {
    if (!this.sourceMap || !this.sourceCode) {
      return null;
    }

    try {
      // Convert PC (bytecode offset) to instruction index
      const instructionIndex = this.pcToInstructionIndex.get(pc);
      if (instructionIndex === undefined) {
        console.warn(`No instruction index for PC ${pc}`);
        return null;
      }

      console.log(`PC ${pc} -> Instruction index ${instructionIndex}`);
      console.log(`Source file size: ${this.sourceCode.length} characters`);

      // Build source map cache (maps instruction index -> source position)
      const sourceMapCache = this.buildSourceMapCache();
      console.log(
        `Source map has ${sourceMapCache.size} entries, looking for instruction ${instructionIndex}`
      );

      // Debug: show some entries around the target
      for (let i = instructionIndex - 5; i <= instructionIndex + 5; i++) {
        const entry = sourceMapCache.get(i);
        if (entry) {
          console.log(
            `  Instruction ${i}: start=${entry.start}, length=${entry.length}, fileIndex=${entry.fileIndex}`
          );
        }
      }

      // Get source position for this instruction index
      const position = sourceMapCache.get(instructionIndex);
      console.log(`Position for instruction ${instructionIndex}:`, position);

      // Handle compiler-generated code (file index != 0)
      if (position && position.fileIndex !== 0) {
        console.warn(
          `⚠️  Revert is in file index ${position.fileIndex} (compiler-generated code)`
        );
        console.warn(
          `This is usually internal runtime checks (overflow, division by zero, etc.)`
        );
        console.warn(
          `Searching backwards for the source line that triggered it...`
        );

        // Search backwards up to 20 instructions for source file code
        const searchLimit = 20;
        for (let offset = 1; offset <= searchLimit; offset++) {
          const prevIndex = instructionIndex - offset;
          if (prevIndex < 0) break;

          const prevPosition = sourceMapCache.get(prevIndex);
          if (prevPosition && prevPosition.fileIndex === 0) {
            console.log(
              `Found triggering instruction ${prevIndex} (offset -${offset}) in source file:`,
              prevPosition
            );
            const start = prevPosition.start;
            const lines = this.sourceCode.split('\n');
            let currentOffset = 0;
            let lineNumber = 1;
            let columnNumber = 1;

            for (let j = 0; j < lines.length; j++) {
              const line = lines[j];
              if (line === undefined) continue;
              const lineLength = line.length + 1;
              if (currentOffset + lineLength > start) {
                lineNumber = j + 1;
                columnNumber = start - currentOffset + 1;
                break;
              }
              currentOffset += lineLength;
            }

            const snippet = lines[lineNumber - 1]?.trim() || '';
            console.log(`Mapped to source line ${lineNumber}: ${snippet}`);

            return {
              line: lineNumber,
              column: columnNumber,
              snippet,
            };
          }
        }

        console.warn(
          `Could not find source line within ${searchLimit} instructions - all are in compiler-generated code`
        );
        return null;
      }

      if (!position) {
        console.warn(
          `No source map entry for instruction ${instructionIndex} (map size: ${sourceMapCache.size})`
        );

        // Try nearby instructions (source maps can be off by a few)
        for (let offset = -5; offset <= 5; offset++) {
          const nearbyPos = sourceMapCache.get(instructionIndex + offset);
          if (nearbyPos) {
            console.log(
              `Found nearby instruction ${instructionIndex + offset} instead`
            );
            // Use nearby position
            const start = nearbyPos.start;
            const lines = this.sourceCode.split('\n');
            let currentOffset = 0;
            let lineNumber = 1;

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line === undefined) continue;
              const lineLength = line.length + 1;
              if (currentOffset + lineLength > start) {
                lineNumber = i + 1;
                break;
              }
              currentOffset += lineLength;
            }

            const snippet = lines[lineNumber - 1]?.trim() || '';
            return { line: lineNumber, column: 1, snippet };
          }
        }

        return null;
      }

      const start = position.start;
      // const length = position.length; // Not used for now, but available for future use

      // Convert byte offset to line and column
      const lines = this.sourceCode.split('\n');
      let currentOffset = 0;
      let lineNumber = 1;
      let columnNumber = 1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;

        const lineLength = line.length + 1; // +1 for newline

        if (currentOffset + lineLength > start) {
          lineNumber = i + 1;
          columnNumber = start - currentOffset + 1;
          break;
        }

        currentOffset += lineLength;
      }

      // Extract snippet - the actual line of code
      const snippet = lines[lineNumber - 1]?.trim() || '';

      console.log(`Mapped to line ${lineNumber}: ${snippet}`);

      return {
        line: lineNumber,
        column: columnNumber,
        snippet,
      };
    } catch (error) {
      console.error('Error mapping PC to source:', error);
      return null;
    }
  }

  /**
   * Find all potential revert locations in source code
   * Looks for: require(), revert(), assert(), and division operations
   */
  findAllPotentialReverts(): Array<{
    line: number;
    snippet: string;
    functionName: string;
    type: string;
  }> {
    if (!this.sourceCode) return [];

    const results: Array<{
      line: number;
      snippet: string;
      functionName: string;
      type: string;
    }> = [];
    const lines = this.sourceCode.split('\n');
    let currentFunction = 'unknown';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const trimmed = line.trim();

      // Track current function
      if (trimmed.includes('function ')) {
        const match = trimmed.match(/function\s+(\w+)/);
        if (match && match[1]) {
          currentFunction = match[1];
        }
      }

      // Find require statements
      if (trimmed.includes('require(')) {
        results.push({
          line: i + 1,
          snippet: trimmed,
          functionName: currentFunction,
          type: 'require',
        });
      }

      // Find explicit reverts
      if (trimmed.includes('revert(') || trimmed.includes('revert ')) {
        results.push({
          line: i + 1,
          snippet: trimmed,
          functionName: currentFunction,
          type: 'revert',
        });
      }

      // Find assert statements
      if (trimmed.includes('assert(')) {
        results.push({
          line: i + 1,
          snippet: trimmed,
          functionName: currentFunction,
          type: 'assert',
        });
      }

      // Find division operations (potential division by zero)
      if (trimmed.includes(' / ') && !trimmed.startsWith('//')) {
        results.push({
          line: i + 1,
          snippet: trimmed,
          functionName: currentFunction,
          type: 'division',
        });
      }

      // Find array access (potential out of bounds)
      if (trimmed.match(/\[\s*\w+\s*\]/) && !trimmed.startsWith('//')) {
        results.push({
          line: i + 1,
          snippet: trimmed,
          functionName: currentFunction,
          type: 'array_access',
        });
      }
    }

    return results;
  }

  /**
   * Find all require statements in the source code (for backwards compatibility)
   */
  findAllRequires(): Array<{
    line: number;
    snippet: string;
    functionName: string;
  }> {
    return this.findAllPotentialReverts()
      .filter((r) => r.type === 'require')
      .map(({ line, snippet, functionName }) => ({
        line,
        snippet,
        functionName,
      }));
  }

  /**
   * Get the full function containing a specific line
   */
  getFunctionContext(lineNumber: number): FunctionContext | null {
    if (!this.sourceCode) {
      return null;
    }

    try {
      const lines = this.sourceCode.split('\n');

      // Find the function containing this line
      let functionStartLine = -1;
      let functionEndLine = -1;
      let functionName = 'unknown';
      let braceDepth = 0;
      let inFunction = false;

      // Scan backwards to find function start
      for (let i = lineNumber - 1; i >= 0; i--) {
        const line = lines[i]?.trim() || '';

        // Check if this is a function declaration
        if (line.includes('function ')) {
          const match = line.match(/function\s+(\w+)/);
          if (match && match[1]) {
            functionName = match[1];
            functionStartLine = i + 1;
            break;
          }
        }
      }

      if (functionStartLine === -1) {
        return null;
      }

      // Scan forward to find function end (matching braces)
      for (let i = functionStartLine - 1; i < lines.length; i++) {
        const line = lines[i] || '';

        for (const char of line) {
          if (char === '{') braceDepth++;
          if (char === '}') braceDepth--;

          if (braceDepth === 0 && inFunction) {
            functionEndLine = i + 1;
            break;
          }
        }

        if (braceDepth > 0) inFunction = true;
        if (functionEndLine !== -1) break;
      }

      if (functionEndLine === -1) {
        functionEndLine = lines.length;
      }

      // Extract function code
      const functionLines = lines.slice(functionStartLine - 1, functionEndLine);
      const code = functionLines.join('\n');

      return {
        functionName,
        startLine: functionStartLine,
        endLine: functionEndLine,
        code,
        revertLine: lineNumber,
      };
    } catch (error) {
      console.error('Error extracting function context:', error);
      return null;
    }
  }

  /**
   * Clean up Solidity internal type names
   */
  cleanTypeName(type: string): string {
    // Remove t_ prefix and _storage suffix from Solidity internal types
    return type
      .replace(/^t_/, '')
      .replace(/_storage$/, '')
      .replace(/_memory$/, '')
      .replace(/_calldata$/, '');
  }

  /**
   * Decode storage value based on type
   */
  decodeValue(hexValue: string, type: string): string {
    try {
      const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;

      // String (short string < 32 bytes)
      if (type.includes('string')) {
        // Check if empty (all zeros)
        if (hex === '0'.repeat(64)) {
          return '""';
        }

        const lastByte = parseInt(hex.slice(62, 64), 16);
        if (lastByte % 2 === 0) {
          const length = lastByte / 2;
          if (length > 0 && length <= 31) {
            const stringHex = hex.slice(0, length * 2);
            let str = '';
            for (let i = 0; i < stringHex.length; i += 2) {
              str += String.fromCharCode(
                parseInt(stringHex.slice(i, i + 2), 16)
              );
            }
            return `"${str}"`;
          }
        }
        // Long string would be in separate slots
        return 'string (long)';
      }

      // Address
      if (type.includes('address')) {
        return '0x' + hex.slice(24, 64);
      }

      // Bool
      if (type.includes('bool')) {
        return hex === '0'.repeat(64) ? 'false' : 'true';
      }

      // Uint/Int - return decimal
      if (type.includes('uint') || type.includes('int')) {
        return BigInt('0x' + hex).toString();
      }

      // Bytes
      if (type.includes('bytes')) {
        return '0x' + hex;
      }

      // Default: return decimal
      return BigInt('0x' + hex).toString();
    } catch (error) {
      return hexValue;
    }
  }
}
