const mongoose = require('mongoose');

// Ein Eintrag der Slideshow – Bild oder Video, die Datei selbst liegt in GridFS (Bucket "umkleide")
const UmkleideItemSchema = new mongoose.Schema({
  kind: { type: String, enum: ['image', 'video'], required: true },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  posterId: { type: mongoose.Schema.Types.ObjectId },
  mimeType: String,
  size: Number,
  duration: Number,
  originalName: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const UmkleideSettingSchema = new mongoose.Schema({
  items: [UmkleideItemSchema],
  interval: { type: Number, default: 10 }
});

UmkleideSettingSchema.statics.getSettings = async function() {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({ items: [], interval: 10 });
  }
  return settings;
};

module.exports = mongoose.model('UmkleideSetting', UmkleideSettingSchema);
