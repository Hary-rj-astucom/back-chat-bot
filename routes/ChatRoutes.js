const express = require('express');
const chatController = require('../controllers/chatController');

const router = express.Router();

// POST /api/chat  { sessionId, message } -> { reply }
router.post('/magento', chatController.postMagentoMessage);

// DELETE /api/chat/:sessionId -> réinitialise l'historique de la session
router.delete('/:sessionId', chatController.resetConversation);

module.exports = router;