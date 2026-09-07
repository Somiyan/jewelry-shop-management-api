const express = require('express');
const { protect } = require('../middleware/auth');
const { listAuditLogs } = require('../controllers/auditLogController');

const router = express.Router();

// Read-only history — any authenticated user can view it.
router.get('/', protect, listAuditLogs);

module.exports = router;
