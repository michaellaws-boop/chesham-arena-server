import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GameServer } from './GameServer.js';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const gameServer = new GameServer(io);

// Health check endpoint (Railway uses this to know the server is alive)
app.get('/', (req, res) => {
  res.json({ status: 'ok', game: 'Chesham Arena' });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] Chesham Arena running on port ${PORT}`);
});
