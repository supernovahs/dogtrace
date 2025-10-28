
<img width="600" height="260" alt="DogTrace" src="https://github.com/user-attachments/assets/15284c6a-1624-42bf-a789-6035b055adb0" />
[![npm 
  version](https://badge.fury.io/js/dogtrace.svg)](https://badge.fury.io/js/dogtrace)
   [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opens
  ource.org/licenses/MIT)
 Single-page PDF reports with automatic error detection, source mapping to exact revert lines, storage change decoding, and zero configuration.

## Installation

```bash
npm install -g dogtrace
```

## Usage

```bash
dog debug <tx-hash> --rpc http://localhost:8545 --contract ./src/Counter.sol
```

The server starts automatically on port `8844` (chosen to avoid conflicts with typical frontend dev servers on port 3000).

**PDF report opens in your browser with:**
- Transaction metadata (hash, from, to, block, gas)
- Error details with panic codes
- Function code with highlighted revert line
- Storage changes with decoded values

## Requirements

**Local development node only.** DogTrace requires `debug_traceTransaction` RPC support.

**Supported:**
- Anvil (Foundry) - Enable with `anvil --steps-tracing`
- Hardhat Network

## Important Notes

This is **experimental software** designed for local development workflows. Key considerations:

- **Local nodes only** - Does not work with public RPC endpoints or archive nodes
- **Source code required** - Best results when providing contract source for accurate revert locations
- **No production use** - Reports are generated in the OS temp directory and are not suitable for production debugging

## Project Structure

```
dogtrace/
├── packages/
│   ├── cli/          # Command-line interface
│   ├── server/       # Express server & PDF generator
│   └── web/          # Future web UI (placeholder)
```

## Development

```bash
# Install dependencies
npm install

# Build and link CLI (includes server)
cd packages/cli
npm run build
npm link

# Use CLI (server auto-starts on port 8844)
dog debug <tx-hash> --rpc http://localhost:8545
```

## Contributing

Contributions welcome! This project serves developers debugging smart contracts on local networks. Focus areas:

- Additional storage type decoding (arrays, mappings, structs)
- Enhanced source mapping accuracy
- Support for more EVM-equivalent chains

## License

MIT
