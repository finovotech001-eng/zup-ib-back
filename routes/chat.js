import express from 'express';
import { Chat } from '../models/Chat.js';
import { authenticateAdminToken } from './adminAuth.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get all conversations for admin
router.get('/conversations', authenticateAdminToken, async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const adminId = req.admin.id;

    const conversations = await Chat.getConversations(adminId, status, parseInt(limit));

    res.json({
      success: true,
      data: {
        conversations
      }
    });
  } catch (error) {
    console.error('Fetch conversations error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch conversations'
    });
  }
});

// Get conversation by ID
router.get('/conversations/:conversationId', authenticateAdminToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await Chat.getConversationById(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Get messages for this conversation
    const messages = await Chat.getMessages(conversationId);

    res.json({
      success: true,
      data: {
        conversation,
        messages
      }
    });
  } catch (error) {
    console.error('Fetch conversation error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch conversation'
    });
  }
});

// Create new conversation (admin)
router.post('/conversations', authenticateAdminToken, async (req, res) => {
  try {
    const { userData } = req.body;
    const adminId = req.admin.id;

    if (!userData || !userData.user_id || !userData.user_name || !userData.user_email) {
      return res.status(400).json({
        success: false,
        message: 'User data is required (user_id, user_name, user_email)'
      });
    }

    const conversation = await Chat.createConversation(userData, adminId);

    res.status(201).json({
      success: true,
      message: 'Conversation created successfully',
      data: {
        conversation
      }
    });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to create conversation'
    });
  }
});

// Create new conversation (user)
router.post('/user/conversations', authenticateToken, async (req, res) => {
  try {
    const { userData } = req.body;
    const userId = req.user.id;

    if (!userData || !userData.user_name || !userData.user_email) {
      return res.status(400).json({
        success: false,
        message: 'User data is required (user_name, user_email)'
      });
    }

    const conversation = await Chat.createConversation({
      user_id: userId,
      user_name: userData.user_name,
      user_email: userData.user_email
    });

    res.status(201).json({
      success: true,
      message: 'Conversation created successfully',
      data: {
        conversation
      }
    });
  } catch (error) {
    console.error('Create user conversation error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to create conversation'
    });
  }
});

// Update conversation status
router.put('/conversations/:conversationId/status', authenticateAdminToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { status } = req.body;
    const adminId = req.admin.id;

    const validStatuses = ['open', 'closed', 'resolved'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
      });
    }

    const conversation = await Chat.updateConversationStatus(conversationId, status, adminId);

    res.json({
      success: true,
      message: `Conversation ${status} successfully`,
      data: {
        conversation
      }
    });
  } catch (error) {
    console.error('Update conversation status error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to update conversation status'
    });
  }
});

// Send message
router.post('/conversations/:conversationId/messages', authenticateAdminToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, messageType = 'text', metadata = {} } = req.body;
    const adminId = req.admin.id;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }

    // Verify conversation exists
    const conversation = await Chat.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Save message
    const senderData = {
      sender_id: adminId,
      sender_name: req.admin.full_name || 'Admin',
      sender_type: 'admin'
    };

    const messageData = {
      content: content.trim(),
      message_type: messageType,
      metadata
    };

    const message = await Chat.saveMessage(conversationId, senderData, messageData);

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: {
        message
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to send message'
    });
  }
});

// Mark messages as read
router.put('/conversations/:conversationId/read', authenticateAdminToken, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const adminId = req.admin.id;

    await Chat.markMessagesAsRead(conversationId, 'admin');

    res.json({
      success: true,
      message: 'Messages marked as read'
    });
  } catch (error) {
    console.error('Mark messages read error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to mark messages as read'
    });
  }
});

// Get chat statistics
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    const adminId = req.admin.id;
    const stats = await Chat.getChatStats(adminId);

    res.json({
      success: true,
      data: {
        stats
      }
    });
  } catch (error) {
    console.error('Fetch chat stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch chat statistics'
    });
  }
});

// Get recent conversations (for dashboard)
router.get('/recent', authenticateAdminToken, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const conversations = await Chat.getRecentConversations(parseInt(limit));

    res.json({
      success: true,
      data: {
        conversations
      }
    });
  } catch (error) {
    console.error('Fetch recent conversations error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch recent conversations'
    });
  }
});

export default router;