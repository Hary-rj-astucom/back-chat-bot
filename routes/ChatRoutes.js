const express = require('express');
const chatController = require('../controllers/ChatController');

const router = express.Router();

// POST /chat/magento  { sessionId, message } -> { reply }
router.post('/magento', chatController.postMagentoMessage);

// POST /chat/prestashop  { sessionId, message } -> { reply }
router.post('/prestashop', chatController.postPrestashopMessage);

// DELETE /chat/:sessionId -> réinitialise l'historique de la session
router.delete('/:sessionId', chatController.resetConversation);

module.exports = router;