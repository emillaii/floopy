const mongoose = require('mongoose');
const { DEFAULT_USERS } = require('./default_users');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, trim: true },
  displayName: { type: String, trim: true },
  avatar: { type: String, trim: true },
}, {
  collection: undefined,
  timestamps: true,
});

function normaliseUser(doc) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(plain._id || plain.id || plain.userId),
    userId: plain.userId,
    displayName: plain.displayName || plain.userId,
    avatar: plain.avatar || '',
  };
}

class UserStore {
  constructor(options = {}) {
    const {
      uri,
      dbName,
      collectionName = 'users',
      logger = console,
    } = options;

    if (!uri) {
      throw new Error('UserStore requires a MongoDB connection string (MONGO_URI)');
    }

    this.uri = uri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.logger = logger;
    this.connectionPromise = null;
    this.UserModel = null;
  }

  async connect() {
    if (!this.connectionPromise) {
      const connectOptions = this.dbName ? { dbName: this.dbName } : {};
      this.connectionPromise = mongoose.connect(this.uri, connectOptions)
        .then(() => {
          const modelName = 'UserProfile';
          const existing = mongoose.models[modelName];
          this.UserModel = existing || mongoose.model(modelName, userSchema, this.collectionName);
          return this.UserModel;
        })
        .catch((err) => {
          this.connectionPromise = null;
          throw err;
        });
    }
    await this.connectionPromise;
    return this.UserModel;
  }

  async ensureDefaults(defaultUsers = DEFAULT_USERS) {
    await this.connect();
    const count = await this.UserModel.estimatedDocumentCount();
    if (count > 0) return;

    if (!Array.isArray(defaultUsers) || !defaultUsers.length) return;

    try {
      await this.UserModel.insertMany(defaultUsers, { ordered: false });
    } catch (err) {
      this.logger.warn('Failed to seed default users (continuing):', err?.message || err);
    }
  }

  async list() {
    await this.connect();
    const docs = await this.UserModel.find().sort({ createdAt: 1 }).lean();
    return docs.map(normaliseUser);
  }

  async createUser(payload = {}) {
    await this.connect();
    const document = new this.UserModel({
      userId: payload.userId,
      displayName: payload.displayName,
      avatar: payload.avatar,
    });
    const saved = await document.save();
    return normaliseUser(saved);
  }

  async updateUser(id, payload = {}) {
    if (!id) {
      throw new Error('User id is required for update');
    }
    await this.connect();
    const update = {};
    if (payload.userId != null) update.userId = payload.userId;
    if (payload.displayName !== undefined) update.displayName = payload.displayName;
    if (payload.avatar !== undefined) update.avatar = payload.avatar;
    const doc = await this.UserModel.findByIdAndUpdate(id, update, { new: true });
    return normaliseUser(doc);
  }

  async deleteUser(id) {
    if (!id) {
      throw new Error('User id is required for delete');
    }
    await this.connect();
    await this.UserModel.findByIdAndDelete(id);
  }
}

module.exports = {
  UserStore,
  normaliseUser,
};
