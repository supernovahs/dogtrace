import { createServer } from './server.js';

const PORT = process.env.PORT || 3000;

const app = createServer();

app.listen(PORT, () => {
  console.log(`=€ Server running on http://localhost:${PORT}`);
  console.log(`=Ê Health check: http://localhost:${PORT}/health`);
  console.log(`= Debug API: http://localhost:${PORT}/api/debug/:txHash`);
});
