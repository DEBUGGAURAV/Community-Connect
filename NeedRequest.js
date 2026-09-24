const mongoose = require('mongoose');

const needRequestSchema = new mongoose.Schema({
  requesterName: { type: String, required: true },
  requesterEmail: { type: String, default: '' },
  helpType: { type: String },
  description: { type: String, required: true }, // free-text need description
  category: { type: String },      // filled in by ML step (e.g. "food", "medical")
  urgency: { type: String },       // filled in by ML step (e.g. "high", "medium", "low")
  location: { type: String, required: true },
  status: { type: String, default: 'pending' }, // pending | matched | resolved
  matchedVolunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'Volunteer' },
  completedAt: { type: Date },
  completedLocation: { type: String },
  completionNote: { type: String },
  volunteerResponses: [{
    volunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'Volunteer' },
    decision: { type: String, enum: ['accepted', 'rejected'] },
    reason: { type: String },
    respondedAt: { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('NeedRequest', needRequestSchema);
