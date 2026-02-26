import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import chatRouter from './routes/chat.js';

const app = new Hono();

app.use('/*', cors());

app.get('/health', (c) => c.json({ status: 'ok' }, 200));

app.get('/', serveStatic({ path: './src/public/index.html' }));

app.route('/chat', chatRouter);

export default app;
