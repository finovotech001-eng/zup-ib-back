import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';

// Import database and models
import pool from './config/database.js';
import { IBRequest } from './models/IBRequest.js';
import { IBAdmin } from './models/IBAdmin.js';
import { Symbols } from './models/Symbols.js';
import { Chat } from './models/Chat.js';
import { MT5Groups } from './models/MT5Groups.js';
import { GroupCommissionStructures } from './models/GroupCommissionStructures.js';
import { IBGroupAssignment } from './models/IBGroupAssignment.js';
import { IBTradeHistory } from './models/IBTradeHistory.js';

// Import routes
import authRoutes from './routes/auth.js';
import adminAuthRoutes from './routes/adminAuth.js';
import ibRequestRoutes from './routes/ibRequest.js';
import adminIBRequestRoutes from './routes/adminIBRequests.js';
import adminSymbolsRoutes from './routes/adminSymbols.js';
import chatRoutes from './routes/chat.js';
import mt5TradesRoutes from './routes/mt5Trades.js';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: '*',
  credentials: false
}));

// Cookie parser middleware
app.use(cookieParser());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Initialize database tables
async function initializeDatabase() {
  try {
    await IBRequest.createTable();
    await IBAdmin.createTable();
    await Symbols.createTable();
    await Chat.createTables();
    await MT5Groups.createTable();
    await GroupCommissionStructures.createTable();
    await IBGroupAssignment.createTable();
    await IBTradeHistory.createTable();
    await IBAdmin.seedDefaultAdmin();
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminAuthRoutes);
app.use('/api/ib-requests', ibRequestRoutes);
app.use('/api/admin/ib-requests', adminIBRequestRoutes);
app.use('/api/admin/symbols', adminSymbolsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin/mt5-trades', mt5TradesRoutes);


// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'IB Portal Server is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found'
  });
});

// Create HTTP server and Socket.IO
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join admin room for admin users
  socket.on('join-admin', (adminData) => {
    socket.join('admin-room');
    socket.adminData = adminData;
    console.log('Admin joined:', adminData);
  });

  // Join user room for IB users
  socket.on('join-user', (userData) => {
    socket.join(`user-${userData.userId}`);
    socket.userData = userData;
    console.log('User joined:', userData);
  });

  // Handle chat messages
  socket.on('send-message', async (messageData) => {
    try {
      const { conversationId, content, messageType, metadata } = messageData;
      const senderData = socket.adminData || socket.userData;

      if (!senderData || !conversationId || !content) {
        socket.emit('message-error', { message: 'Invalid message data' });
        return;
      }

      // Save message to database
      const message = await Chat.saveMessage(conversationId, {
        sender_id: senderData.id || senderData.userId,
        sender_name: senderData.full_name || senderData.name,
        sender_type: socket.adminData ? 'admin' : 'user'
      }, {
        content,
        message_type: messageType || 'text',
        metadata: metadata || {}
      });

      // Broadcast message to conversation participants
      socket.emit('message-sent', { message });
      socket.to(`conversation-${conversationId}`).emit('new-message', { message });

      // Update conversation timestamp
      await Chat.updateConversationLastMessage(conversationId);

    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('message-error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    socket.to(`conversation-${data.conversationId}`).emit('user-typing', {
      userName: socket.adminData?.full_name || socket.userData?.name,
      isTyping: data.isTyping
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Background job to auto-sync trades every 15 minutes
async function autoSyncTrades() {
  try {
    console.log('[Auto-Sync] Starting trade sync for all approved IB users...');
    const { query } = await import('./config/database.js');

    const result = await query("SELECT id, email, usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE LOWER(TRIM(status)) = 'approved'");
    const ibUsers = result.rows;

    for (const ib of ibUsers) {
      try {
        const userResult = await query('SELECT id FROM "User" WHERE email = $1', [ib.email]);
        if (userResult.rows.length === 0) continue;

        const userId = userResult.rows[0].id;

        const assignmentsRes = await query(
          'SELECT group_id, structure_name, usd_per_lot, spread_share_percentage FROM ib_group_assignments WHERE ib_request_id = $1',
          [ib.id]
        );
        const commissionMap = assignmentsRes.rows.reduce((map, row) => {
          if (!row.group_id) return map;
          map[row.group_id.toLowerCase()] = {
            usdPerLot: Number(row.usd_per_lot || 0),
            spreadPercentage: Number(row.spread_share_percentage || 0)
          };
          return map;
        }, {});

        if (!Object.keys(commissionMap).length) {
          commissionMap['*'] = {
            usdPerLot: Number(ib.usd_per_lot || 0),
            spreadPercentage: Number(ib.spread_percentage_per_lot || 0)
          };
        }

        const accountsResult = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);

        for (const account of accountsResult.rows) {
          const accountId = account.accountId;
          const to = new Date().toISOString();
          const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

          try {
            const apiUrl = `http://18.130.5.209:5003/api/client/ClientTradeHistory/trades?accountId=${accountId}&page=1&pageSize=1000&fromDate=${from}&toDate=${to}`;
            const response = await fetch(apiUrl, { headers: { accept: '*/*' } });

            if (response.ok) {
              const data = await response.json();
              const trades = data.Items || [];
              await IBTradeHistory.saveTrades(trades, accountId, userId, ib.id);
              await IBTradeHistory.calculateIBCommissions(accountId, ib.id);
            }
          } catch (error) {
            console.error(`[Auto-Sync] Error syncing account ${accountId}:`, error.message);
          }
        }
      } catch (error) {
        console.error(`[Auto-Sync] Error processing IB ${ib.id}:`, error.message);
      }
    }

    console.log('[Auto-Sync] Trade sync completed');
  } catch (error) {
    console.error('[Auto-Sync] Error in auto-sync job:', error);
  }
}

// Bootstrapping to ensure DB is ready before accepting requests
async function start() {
  try {
    // Initialize database tables BEFORE starting the server to avoid race conditions
    await initializeDatabase();

    server.listen(PORT, () => {
      console.log(`IB Portal Server is running on port ${PORT}`);
      console.log(`Socket.IO server is ready`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
      
      // Start auto-sync job (every 15 minutes)
      console.log('[Auto-Sync] Scheduling auto-sync job every 15 minutes');
      setInterval(autoSyncTrades, 15 * 60 * 1000); // 15 minutes
      
      // Run initial sync after 1 minute
      setTimeout(autoSyncTrades, 60 * 1000);
    });
  } catch (err) {
    console.error('Failed to initialize server:', err);
    process.exit(1);
  }
}

// Start application
start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await pool.end();
    console.log('Process terminated');
  });
});

export default app;
