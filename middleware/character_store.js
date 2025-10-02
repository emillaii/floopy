const mongoose = require('mongoose');
const { DEFAULT_CHARACTER_CARDS } = require('./default_characters');

const characterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  prompt: { type: String, required: true, trim: true },
  image: { type: String, default: '', trim: true },
  voiceId: { type: String, default: '', trim: true },
}, {
  collection: undefined,
  timestamps: true,
});

function normaliseCharacter(doc) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(plain._id || plain.id || plain.name),
    name: plain.name,
    prompt: plain.prompt,
    image: plain.image || '',
    voiceId: plain.voiceId || '',
  };
}

class CharacterStore {
  constructor(options = {}) {
    const {
      uri,
      dbName,
      collectionName = 'characters',
      logger = console,
    } = options;

    if (!uri) {
      throw new Error('CharacterStore requires a MongoDB connection string (MONGO_URI)');
    }

    this.uri = uri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.logger = logger;
    this.connectionPromise = null;
    this.CharacterModel = null;
  }

  async connect() {
    if (!this.connectionPromise) {
      const connectOptions = this.dbName ? { dbName: this.dbName } : {};
      this.connectionPromise = mongoose.connect(this.uri, connectOptions)
        .then(() => {
          const modelName = 'Character';
          const existing = mongoose.models[modelName];
          this.CharacterModel = existing || mongoose.model(modelName, characterSchema, this.collectionName);
          return this.CharacterModel;
        })
        .catch((err) => {
          this.connectionPromise = null;
          throw err;
        });
    }
    await this.connectionPromise;
    return this.CharacterModel;
  }

  async ensureDefaults(defaultCharacters = DEFAULT_CHARACTER_CARDS) {
    await this.connect();
    const count = await this.CharacterModel.estimatedDocumentCount();
    if (count > 0) return;

    if (!Array.isArray(defaultCharacters) || !defaultCharacters.length) return;

    try {
      await this.CharacterModel.insertMany(defaultCharacters, { ordered: false });
    } catch (err) {
      this.logger.warn('Failed to seed default characters (continuing):', err?.message || err);
    }
  }

  async list() {
    await this.connect();
    const docs = await this.CharacterModel.find().sort({ createdAt: 1 }).lean();
    return docs.map(normaliseCharacter);
  }

  async findByName(name) {
    if (!name) return null;
    await this.connect();
    const doc = await this.CharacterModel.findOne({ name }).lean();
    return normaliseCharacter(doc);
  }

  async getById(id) {
    if (!id) return null;
    await this.connect();
    const doc = await this.CharacterModel.findById(id).lean();
    return normaliseCharacter(doc);
  }

  async createCharacter(payload = {}) {
    await this.connect();
    const document = new this.CharacterModel({
      name: payload.name,
      prompt: payload.prompt,
      image: payload.image ?? '',
      voiceId: payload.voiceId ?? payload.voice_id ?? '',
    });
    const saved = await document.save();
    return normaliseCharacter(saved);
  }

  async updateCharacter(id, payload = {}) {
    if (!id) {
      throw new Error('Character id is required for update');
    }
    await this.connect();
    const update = {};
    if (payload.name != null) update.name = payload.name;
    if (payload.prompt != null) update.prompt = payload.prompt;
    if (payload.image !== undefined) update.image = payload.image;
    if (payload.voiceId !== undefined || payload.voice_id !== undefined) {
      update.voiceId = payload.voiceId ?? payload.voice_id;
    }
    const doc = await this.CharacterModel.findByIdAndUpdate(id, update, { new: true });
    return normaliseCharacter(doc);
  }

  async deleteCharacter(id) {
    if (!id) {
      throw new Error('Character id is required for delete');
    }
    await this.connect();
    await this.CharacterModel.findByIdAndDelete(id);
  }
}

module.exports = {
  CharacterStore,
  normaliseCharacter,
};
