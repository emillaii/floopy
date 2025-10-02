const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, trim: true },
  userId: { type: String, required: true, trim: true },
  title: { type: String, trim: true },
  personaName: { type: String, required: true, trim: true },
  personaPrompt: { type: String, trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed },
  lastActiveAt: { type: Date, default: Date.now },
}, {
  collection: undefined,
  timestamps: true,
});

function normaliseSession(doc) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(plain._id || plain.id || plain.sessionId),
    sessionId: plain.sessionId,
    userId: plain.userId,
    title: plain.title || '',
    personaName: plain.personaName,
    personaPrompt: plain.personaPrompt || '',
    metadata: plain.metadata || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
    lastActiveAt: plain.lastActiveAt || plain.updatedAt || plain.createdAt || null,
  };
}

class SessionStore {
  constructor(options = {}) {
    const {
      uri,
      dbName,
      collectionName = 'chat_sessions',
      logger = console,
    } = options;

    if (!uri) {
      throw new Error('SessionStore requires a MongoDB connection string (MONGO_URI)');
    }

    this.uri = uri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.logger = logger;
    this.connectionPromise = null;
    this.SessionModel = null;
  }

  async connect() {
    if (!this.connectionPromise) {
      const connectOptions = this.dbName ? { dbName: this.dbName } : {};
      this.connectionPromise = mongoose.connect(this.uri, connectOptions)
        .then(() => {
          const modelName = 'ChatSession';
          const existing = mongoose.models[modelName];
          this.SessionModel = existing || mongoose.model(modelName, sessionSchema, this.collectionName);
          return this.SessionModel;
        })
        .catch((err) => {
          this.connectionPromise = null;
          throw err;
        });
    }
    await this.connectionPromise;
    return this.SessionModel;
  }

  async upsertSession(payload) {
    await this.connect();
    const update = {
      userId: payload.userId,
      title: payload.title || '',
      personaName: payload.personaName,
      personaPrompt: payload.personaPrompt || '',
      metadata: payload.metadata || null,
      lastActiveAt: payload.lastActiveAt || new Date(),
    };
    const doc = await this.SessionModel.findOneAndUpdate(
      { sessionId: payload.sessionId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return normaliseSession(doc);
  }

  async list() {
    await this.connect();
    const docs = await this.SessionModel.find().sort({ updatedAt: -1 }).lean();
    return docs.map(normaliseSession);
  }

  async getBySessionId(sessionId) {
    if (!sessionId) return null;
    await this.connect();
    const doc = await this.SessionModel.findOne({ sessionId }).lean();
    return normaliseSession(doc);
  }

  async updateTitle(sessionId, title) {
    if (!sessionId) return null;
    await this.connect();
    const doc = await this.SessionModel.findOneAndUpdate(
      { sessionId },
      { title: title || '' },
      { new: true },
    );
    return normaliseSession(doc);
  }

  async touchSession(sessionId) {
    if (!sessionId) return;
    await this.connect();
    await this.SessionModel.updateOne(
      { sessionId },
      { $set: { lastActiveAt: new Date() } },
    );
  }

  async deleteSession(sessionId) {
    if (!sessionId) return;
    await this.connect();
    await this.SessionModel.deleteOne({ sessionId });
  }
}

module.exports = {
  SessionStore,
  normaliseSession,
};
