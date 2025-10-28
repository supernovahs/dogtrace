import { createServer } from './server.js';

const PORT = process.env.PORT || 8844;

const app = createServer();

app.listen(PORT, () => {
  console.log(`=� Server running on http://localhost:${PORT}`);
  console.log(`=� Health check: http://localhost:${PORT}/health`);
  console.log(`= Debug API: http://localhost:${PORT}/api/debug/:txHash`);
});
