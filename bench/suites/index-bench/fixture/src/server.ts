import { authenticate } from './auth.js';
import { loadConfig } from './config.js';

export function startServer(): void {
  const config = loadConfig('./config.json');
  void config;
}

export function handleRequest(userId: string): string {
  if (!authenticate(userId)) return 'denied';
  return 'ok';
}
