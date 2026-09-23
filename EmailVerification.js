const mongoose = require('mongoose');

const emailVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  purpose: { type: String, enum: ['volunteer-registration', 'requester-action', 'volunteer-action'], required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  verifiedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('EmailVerification', emailVerificationSchema);
