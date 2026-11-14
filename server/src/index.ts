// Entry point used by `gtd start` and `npm run dev`: settings come from env vars.
// Hosts that run the server in their own process call startServer() from ./server instead.
import { SHUTDOWN_TIMEOUT_MS, startServer } from './server';

const port = parseInt(process.env['PORT'] || '3001', 10);

startServer({ port, uiPath: process.env['ESB_UI_PATH'] })
  .then((running) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      console.log('\nShutting down server...');

      // Force exit if graceful shutdown takes too long
      setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();

      running.close().then(
        () => {
          console.log('Server stopped.');
          process.exit(0);
        },
        (err) => {
          console.error('Error during server shutdown:', err);
          process.exit(1);
        },
      );
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('Failed to start server:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
