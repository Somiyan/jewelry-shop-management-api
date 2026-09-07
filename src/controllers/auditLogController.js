const asyncHandler = require('express-async-handler');
const AuditLog = require('../models/AuditLog');

const listAuditLogs = asyncHandler(async (req, res) => {
  const { entity, entityId } = req.query;
  const filter = {};
  if (entity) filter.entity = entity;
  if (entityId) filter.entityId = entityId;
  const logs = await AuditLog.find(filter).sort({ at: -1 }).populate('userId', 'username email role');
  res.json(logs);
});

module.exports = { listAuditLogs };
