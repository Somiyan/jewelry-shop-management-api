const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  entity: { type: String, required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  field: { type: String, required: true },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: { type: String, default: '' },
  at: { type: Date, default: Date.now },
});

auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
