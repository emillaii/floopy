const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const credentialSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
}, {
  collection: undefined,
  timestamps: true,
});

class AuthStore {
  constructor(options = {}) {
    const {
      uri,
      dbName,
      collectionName = 'user_credentials',
      logger = console,
      saltRounds = 10,
    } = options;

    this.logger = logger;
    this.saltRounds = saltRounds;

    if (!uri) {
      this.mode = 'memory';
      this.memory = new Map();
      return;
    }

    this.mode = 'mongo';
    this.uri = uri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.connectionPromise = null;
    this.CredentialModel = null;
  }

  async connect() {
    if (this.mode !== 'mongo') return null;
    if (!this.connectionPromise) {
      const connectOptions = this.dbName ? { dbName: this.dbName } : {};
      this.connectionPromise = mongoose.connect(this.uri, connectOptions)
        .then(() => {
          const modelName = 'UserCredential';
          const existing = mongoose.models[modelName];
          this.CredentialModel = existing || mongoose.model(modelName, credentialSchema, this.collectionName);
          return this.CredentialModel;
        })
        .catch((err) => {
          this.connectionPromise = null;
          throw err;
        });
    }
    await this.connectionPromise;
    return this.CredentialModel;
  }

  async hashPassword(password) {
    if (!password || typeof password !== 'string') {
      throw new Error('Password is required');
    }
    return bcrypt.hash(password, this.saltRounds);
  }

  async setCredential(userId, password) {
    if (!userId || !password) {
      throw new Error('userId and password are required');
    }
    const passwordHash = await this.hashPassword(password);

    if (this.mode === 'memory') {
      this.memory.set(userId, passwordHash);
      return { userId, passwordHash };
    }

    await this.connect();
    const result = await this.CredentialModel.findOneAndUpdate(
      { userId },
      { passwordHash },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return result;
  }

  async hasCredential(userId) {
    if (!userId) return false;
    if (this.mode === 'memory') {
      return this.memory.has(userId);
    }
    await this.connect();
    const doc = await this.CredentialModel.findOne({ userId }).lean();
    return Boolean(doc);
  }

  async verifyCredential(userId, password) {
    if (!userId || !password) return false;

    if (this.mode === 'memory') {
      const hash = this.memory.get(userId);
      if (!hash) return false;
      return bcrypt.compare(password, hash);
    }

    await this.connect();
    const doc = await this.CredentialModel.findOne({ userId }).lean();
    if (!doc?.passwordHash) return false;
    return bcrypt.compare(password, doc.passwordHash);
  }

  async deleteCredential(userId) {
    if (!userId) return;
    if (this.mode === 'memory') {
      this.memory.delete(userId);
      return;
    }
    await this.connect();
    await this.CredentialModel.findOneAndDelete({ userId });
  }
}

module.exports = {
  AuthStore,
};
