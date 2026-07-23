const OpenAiService = require('../services/OpenAiApiService');
const ConversationChat = require('../models/ConversationChat.js');
const MessageChat = require('../models/MessageChat.js');

const openAiService = new OpenAiService();

// sessionId -> historique de conversation (format OpenAI messages)
const conversations = new Map();

// Nombre max de messages conservés par session (évite de dépasser
// la fenêtre de contexte sur une conversation longue)
const MAX_HISTORY_LENGTH = 20;

// Valide grossièrement un email fourni par le widget (client déjà
// connecté sur le site), pour éviter d'injecter n'importe quoi dans
// le contexte envoyé au modèle.
function extractCustomerContext(body) {
  const { customerEmail } = body || {};
  const isValidEmail = typeof customerEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);
  return isValidEmail ? { customerEmail: customerEmail.trim(), conversation_session_id: body.sessionId } : {};
}

async function postMagentoMessage(req, res) {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId est requis (string).' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message est requis (string non vide).' });
    }

    const context = extractCustomerContext(req.body);

    // -- verification de la base de donnees et stockage de la conversation --
    let conversation = await ConversationChat.findOne({ where: { session_id: sessionId } });
    if(!conversation){
      conversation = await ConversationChat.create({ session_id: sessionId, project_id: 2 });
    }

    // -- sauvegarde du message du client --
    await MessageChat.create({ conversation_chat_id: conversation.id, acteur: "client", message: message });

    const history = conversations.get(sessionId) || [];

    const { reply, history: updatedHistory } = await openAiService.magentochat(history, message.trim(), context);

    // -- sauvegarde du message de l'ia --
    await MessageChat.create({ conversation_chat_id: conversation.id,  acteur: "agent IA", message: reply });

    conversations.set(sessionId, updatedHistory.slice(-MAX_HISTORY_LENGTH));

    return res.json({ reply });
  } catch (error) {
    console.error('Erreur chatController.postMagentoMessage:', error);
    return res.status(500).json({ error: "Une erreur est survenue, réessayez plus tard." });
  }
}

async function postPrestashopMessage(req, res) {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId est requis (string).' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message est requis (string non vide).' });
    }

    const context = extractCustomerContext(req.body);

    // -- verification de la base de donnees et stockage de la conversation --
    let conversation = await ConversationChat.findOne({ where: { session_id: sessionId } });
    if(!conversation){
      conversation = await ConversationChat.create({ session_id: sessionId, project_id: 2 });
    }

    // -- sauvegarde du message du client --
    await MessageChat.create({ conversation_chat_id: conversation.id, acteur: "client", message: message });

    const history = conversations.get(sessionId) || [];

    const { reply, history: updatedHistory } = await openAiService.prestashopchat(history, message.trim(), context);

    // -- sauvegarde du message de l'ia --
    await MessageChat.create({ conversation_chat_id: conversation.id,  acteur: "agent IA", message: reply });

    conversations.set(sessionId, updatedHistory.slice(-MAX_HISTORY_LENGTH));

    return res.json({ reply });
  } catch (error) {
    console.error('Erreur chatController.postPrestashopMessage:', error);
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
  postPrestashopMessage,
  resetConversation
};