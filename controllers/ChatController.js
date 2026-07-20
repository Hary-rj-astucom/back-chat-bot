const OpenAiService = require('../services/OpenAiApiService');

const openAiService = new OpenAiService();

// sessionId -> historique de conversation (format OpenAI messages)
const conversations = new Map();

// Nombre max de messages conservés par session (évite de dépasser
// la fenêtre de contexte sur une conversation longue)
const MAX_HISTORY_LENGTH = 20;

async function postMagentoMessage(req, res) {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId est requis (string).' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message est requis (string non vide).' });
    }

    const history = conversations.get(sessionId) || [];

    const { reply, history: updatedHistory } = await openAiService.magentochat(history, message.trim());

    conversations.set(sessionId, updatedHistory.slice(-MAX_HISTORY_LENGTH));

    return res.json({ reply });
  } catch (error) {
    console.error('Erreur chatController.postMessage:', error);
    return res.status(500).json({ error: "Une erreur est survenue, réessayez plus tard." });
  }
}

// Permet au client de réinitialiser une conversation (ex: bouton "nouvelle conversation")
function resetConversation(req, res) {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId est requis.' });
  }

  conversations.delete(sessionId);
  return res.json({ success: true });
}

module.exports = {
  postMagentoMessage,
  resetConversation
};