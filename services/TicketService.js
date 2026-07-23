require('dotenv').config();
const Ticket = require('../models/Ticket.js');
const Project = require('../models/Project.js');
const ConversationChat = require('../models/ConversationChat.js');

function handleError(context, error) {
  console.error(`Erreur_Ticket [${context}]:`, error.response?.data || error.message);
  throw error;
}

// Récupérer une commande par son ID interne (entity_id)
async function create_ticket(project_id, subject_ticket, conversation_session_id, to_do, original_client_mail, reception_mail, nom_client, num_commande, label_id) {
  try {
    const project = await Project.findByPk(project_id);
    const lastId = await Ticket.max('id');

    // si on a pas de status
    const status = 'en attente';

    console.log('[Creation ticket] Conversation session ' + conversation_session_id);

    // get conversation chat id  
    const conversation_chat = await ConversationChat.findOne({ where: { session_id: conversation_session_id } });

    const num_ticket = project.code + "-" + (lastId + 1);
    const ticket =  await Ticket.create(
        {
            num_ticket: num_ticket,
            subject_ticket: subject_ticket,
            conversation_email_id: "none",
            conversation_chat_id: conversation_chat.id,
            to_do: to_do,
            original_client_mail: original_client_mail,
            reception_mail: reception_mail,
            nom_client: nom_client,
            num_commande: num_commande,
            label_id: label_id,
            project_id: project_id,
            status: status
        }
    );

    // assurer le numero du ticket est unique
    ticket.num_ticket = `${project.code}-${ticket.id}`;
    await ticket.save();

    return ticket.num_ticket;

  } catch (error) {
    handleError('create_ticket', error);
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    create_ticket
}
