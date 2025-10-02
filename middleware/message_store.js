const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  role: { type: String, required: true, trim: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: undefined,
  timestamps: false,
});

function normaliseMessage(doc) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(plain._id || plain.id || ''),
    sessionId: plain.sessionId,
    role: plain.role,
    content: plain.content,
    createdAt: plain.createdAt ? new Date(plain.createdAt) : null,
  };
}

class MessageStore {
  constructor(options = {}) {
    const {
      uri,
      dbName,
      collectionName = 'chat_messages',
      logger = console,
    } = options;

    if (!uri) {
      throw new Error('MessageStore requires a MongoDB connection string (MONGO_URI)');
    }

    this.uri = uri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.logger = logger;
    this.connectionPromise = null;
    this.MessageModel = null;
  }

  async connect() {
    if (!this.connectionPromise) {
      const connectOptions = this.dbName ? { dbName: this.dbName } : {};
      this.connectionPromise = mongoose.connect(this.uri, connectOptions)
        .then(() => {
          const modelName = 'ChatMessage';
          const existing = mongoose.models[modelName];
          this.MessageModel = existing || mongoose.model(modelName, messageSchema, this.collectionName);
          return this.MessageModel;
        })
        .catch((err) => {
          this.connectionPromise = null;
          throw err;
        });
    }
    await this.connectionPromise;
    return this.MessageModel;
  }

  async appendMessages(sessionId, entries = []) {
    if (!sessionId || !entries.length) return;
    await this.connect();
    const docs = entries.map((entry) => ({
      sessionId,
      role: entry.role,
      content: entry.content,
      createdAt: entry.createdAt || new Date(),
    }));
    await this.MessageModel.insertMany(docs);
  }

  async list(sessionId, limit = null) {
    if (!sessionId) return [];
    await this.connect();
    const query = this.MessageModel.find({ sessionId }).sort({ createdAt: 1 });
    if (limit && Number.isFinite(limit)) {
      query.limit(limit);
    }
    const docs = await query.lean();
    return docs.map(normaliseMessage);
  }

  async deleteBySession(sessionId) {
    if (!sessionId) return;
    await this.connect();
    await this.MessageModel.deleteMany({ sessionId });
  }
}

module.exports = {
  MessageStore,
  normaliseMessage,
};
