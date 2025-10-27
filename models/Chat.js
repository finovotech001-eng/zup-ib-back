import { query } from '../config/database.js';

export class Chat {
  static async createTables() {
    try {
      // Conversations table (stores chat sessions between admin and users)
      await query(`
        CREATE TABLE IF NOT EXISTS chat_conversations (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          user_name VARCHAR(255) NOT NULL,
          user_email VARCHAR(255) NOT NULL,
          admin_id VARCHAR(255),
          status VARCHAR(20) DEFAULT 'open', -- open, closed, resolved
          priority VARCHAR(20) DEFAULT 'normal', -- low, normal, high, urgent
          subject VARCHAR(500),
          last_message_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          closed_at TIMESTAMP WITH TIME ZONE,
          closed_by VARCHAR(255),
          tags TEXT[] DEFAULT '{}',
          unread_count_admin INTEGER DEFAULT 0,
          unread_count_user INTEGER DEFAULT 0
        )
      `);

      // Messages table (stores individual chat messages)
      await query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
          sender_id VARCHAR(255) NOT NULL,
          sender_name VARCHAR(255) NOT NULL,
          sender_type VARCHAR(20) NOT NULL, -- admin, user, system
          message_type VARCHAR(20) DEFAULT 'text', -- text, image, file, system
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}', -- for file info, image dimensions, etc.
          is_read BOOLEAN DEFAULT false,
          read_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Chat participants table (for group chats if needed in future)
      await query(`
        CREATE TABLE IF NOT EXISTS chat_participants (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
          user_id VARCHAR(255) NOT NULL,
          user_name VARCHAR(255) NOT NULL,
          user_type VARCHAR(20) NOT NULL, -- admin, ib_user, system
          role VARCHAR(20) DEFAULT 'participant', -- admin, participant, observer
          joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          left_at TIMESTAMP WITH TIME ZONE,
          is_active BOOLEAN DEFAULT true,
          UNIQUE(conversation_id, user_id)
        )
      `);

      // Tables ensured
    } catch (error) {
      console.error('Error creating chat tables:', error);
      throw error;
    }
  }

  // Conversation methods
  static async createConversation(userData, adminId = null) {
    try {
      const result = await query(`
        INSERT INTO chat_conversations (
          user_id, user_name, user_email, admin_id, status, priority
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [
        userData.user_id || userData.id,
        userData.user_name || userData.name,
        userData.user_email || userData.email,
        adminId,
        'open',
        'normal'
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
  }

  static async getConversations(adminId = null, status = null, limit = 50) {
    try {
      let whereConditions = [];
      let params = [];
      let paramIndex = 1;

      if (adminId) {
        whereConditions.push(`(admin_id = $${paramIndex} OR admin_id IS NULL)`);
        params.push(adminId);
        paramIndex++;
      }

      if (status) {
        whereConditions.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      const result = await query(`
        SELECT c.*,
               (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.is_read = false AND m.sender_type = 'user') as unread_count
        FROM chat_conversations c
        ${whereClause}
        ORDER BY last_message_at DESC, created_at DESC
        LIMIT $${paramIndex}
      `, [...params, limit]);

      return result.rows;
    } catch (error) {
      console.error('Error fetching conversations:', error);
      throw error;
    }
  }

  static async getConversationById(conversationId) {
    try {
      const result = await query('SELECT * FROM chat_conversations WHERE id = $1', [conversationId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching conversation:', error);
      throw error;
    }
  }

  static async updateConversationStatus(conversationId, status, closedBy = null) {
    try {
      const updateData = {
        status,
        updated_at: new Date(),
        ...(status === 'closed' && { closed_at: new Date(), closed_by: closedBy })
      };

      const result = await query(`
        UPDATE chat_conversations
        SET status = $1, updated_at = $2, closed_at = $3, closed_by = $4
        WHERE id = $5
        RETURNING *
      `, [status, updateData.updated_at, updateData.closed_at, updateData.closed_by, conversationId]);

      return result.rows[0];
    } catch (error) {
      console.error('Error updating conversation status:', error);
      throw error;
    }
  }

  // Message methods
  static async saveMessage(conversationId, senderData, messageData) {
    try {
      const result = await query(`
        INSERT INTO chat_messages (
          conversation_id, sender_id, sender_name, sender_type,
          message_type, content, metadata, is_read
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        conversationId,
        senderData.sender_id,
        senderData.sender_name,
        senderData.sender_type,
        messageData.message_type || 'text',
        messageData.content,
        JSON.stringify(messageData.metadata || {}),
        false
      ]);

      // Update conversation's last message timestamp and unread count
      await query(`
        UPDATE chat_conversations
        SET last_message_at = CURRENT_TIMESTAMP,
            unread_count_${senderData.sender_type === 'admin' ? 'user' : 'admin'} = unread_count_${senderData.sender_type === 'admin' ? 'user' : 'admin'} + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [conversationId]);

      return result.rows[0];
    } catch (error) {
      console.error('Error saving message:', error);
      throw error;
    }
  }

  static async getMessages(conversationId, limit = 100, offset = 0) {
    try {
      const result = await query(`
        SELECT * FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        LIMIT $2 OFFSET $3
      `, [conversationId, limit, offset]);

      return result.rows;
    } catch (error) {
      console.error('Error fetching messages:', error);
      throw error;
    }
  }

  static async markMessagesAsRead(conversationId, readerType) {
    try {
      // Mark messages as read
      await query(`
        UPDATE chat_messages
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE conversation_id = $1 AND sender_type != $2 AND is_read = false
      `, [conversationId, readerType]);

      // Reset unread count for the reader
      await query(`
        UPDATE chat_conversations
        SET unread_count_${readerType === 'admin' ? 'admin' : 'user'} = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [conversationId]);

      return { success: true };
    } catch (error) {
      console.error('Error marking messages as read:', error);
      throw error;
    }
  }

  static async updateConversationLastMessage(conversationId) {
    try {
      await query(`
        UPDATE chat_conversations
        SET last_message_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [conversationId]);
    } catch (error) {
      console.error('Error updating conversation last message:', error);
      throw error;
    }
  }

  // Analytics methods
  static async getChatStats(adminId = null) {
    try {
      let whereClause = '';
      if (adminId) {
        whereClause = `WHERE admin_id = '${adminId}'`;
      }

      const result = await query(`
        SELECT
          COUNT(*) as total_conversations,
          COUNT(CASE WHEN status = 'open' THEN 1 END) as open_conversations,
          COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_conversations,
          COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_conversations,
          AVG(unread_count_admin) as avg_unread_admin,
          AVG(unread_count_user) as avg_unread_user
        FROM chat_conversations
        ${whereClause}
      `);

      return result.rows[0];
    } catch (error) {
      console.error('Error fetching chat stats:', error);
      throw error;
    }
  }

  static async getRecentConversations(limit = 20) {
    try {
      const result = await query(`
        SELECT c.*,
               (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT created_at FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time
        FROM chat_conversations c
        ORDER BY last_message_at DESC
        LIMIT $1
      `, [limit]);

      return result.rows;
    } catch (error) {
      console.error('Error fetching recent conversations:', error);
      throw error;
    }
  }
}
