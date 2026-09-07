const express = require('express');
const { getHealth, getLiveness, getReadiness } = require('../controllers/healthController');

const router = express.Router();

// Public by design: monitors and orchestrators probe these without credentials.
router.get('/', getHealth);
router.get('/live', getLiveness);
router.get('/ready', getReadiness);

module.exports = router;
