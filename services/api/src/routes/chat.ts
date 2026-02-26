import { Hono } from 'hono';
import { processChat } from '../pipeline.js';

const chatRouter = new Hono();

chatRouter.post('/', async (c) => {
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Message is required' }, 400);
  }

  try {
    const response = await processChat(body.message);
    return c.json({ response });
  } catch (error) {
    console.error('Chat error:', error);
    const msg =
      error instanceof Error ? error.message : 'Failed to process message';
    return c.json({ error: msg }, 500);
  }
});

export default chatRouter;
