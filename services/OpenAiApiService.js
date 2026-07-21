require('dotenv').config();
const OpenAI = require('openai');
const { magentoToolDefinitions, magentoToolImplementations } = require('../tools/magentoTools');
const { prestashopToolDefinitions, prestashopToolImplementations } = require('../tools/Prestashoptools');

// ------------------------------------------------------------
// System prompt : c'est LUI qui "anticipe" le comportement du
// bot. Sois précis sur : le rôle, ce qu'il a le droit de faire,
// ce qu'il doit vérifier avant de répondre, et le ton.
// ------------------------------------------------------------
const SYSTEM_PROMPT = `
Tu es l'assistant du Service Après-Vente (SAV) de la boutique en ligne.
Tu réponds aux clients en français, avec un ton professionnel, chaleureux et concis.

Règles :
1. Tu ne dois JAMAIS inventer d'informations (statut de commande, stock, prix, délais...).
   Si tu as besoin d'une donnée, utilise les outils (functions) mis à ta disposition.
2. Avant d'appeler un outil qui nécessite un "orderId" interne, commence TOUJOURS par
   récupérer la commande via son numéro visible (get_order_by_increment_id) ou via l'email
   du client (get_last_orders_by_email). N'appelle jamais un outil avec un orderId inventé.
3. Si le client ne donne pas assez d'informations pour identifier sa commande
   (ni numéro de commande, ni email), demande-lui poliment l'un des deux avant d'agir.
4. Si un outil renvoie une erreur ou aucun résultat, informe le client sans détail technique
   (ne montre jamais de stack trace, de code d'erreur brut ou de structure JSON) et propose
   une alternative (vérifier l'orthographe de l'email, contacter le SAV humain, etc.).
5. Ne communique jamais de données sensibles autres que celles du client qui écrit
   (pas d'informations sur une autre commande / un autre client).
6. Si la demande dépasse ce que tu peux traiter (litige, remboursement complexe, réclamation
   agressive), propose de transférer la conversation à un conseiller humain.
7. Réponses courtes et actionnables. Pas de jargon technique Magento (n'utilise jamais les mots
   "entity_id", "SKU", "API", "increment_id" dans tes réponses au client).
`.trim();

const MAX_TOOL_ROUNDS = 5;

class OpenAiService {
  constructor(apiKey = process.env.OPENAI_SECRET_KEY, model = process.env.OPENAI_MODEL) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required.');
    }
    this.client = new OpenAI({ apiKey });
    this.model = model || 'gpt-4o';
  }

  /**
   * Chat SAV branché sur les outils Magento.
   *
   * @param {Array} history - historique de conversation existant
   * @param {string} userMessage - nouveau message du client
   * @param {Object} context - infos connues sur le client, ex: { customerEmail }
   * @returns {Promise<{ reply: string, history: Array }>}
   */
  async magentochat(history = [], userMessage, context = {}) {
    return this._runChat(history, userMessage, context, magentoToolDefinitions, magentoToolImplementations);
  }

  /**
   * Chat SAV branché sur les outils PrestaShop.
   *
   * @param {Array} history - historique de conversation existant
   * @param {string} userMessage - nouveau message du client
   * @param {Object} context - infos connues sur le client, ex: { customerEmail }
   * @returns {Promise<{ reply: string, history: Array }>}
   */
  async prestashopchat(history = [], userMessage, context = {}) {
    return this._runChat(history, userMessage, context, prestashopToolDefinitions, prestashopToolImplementations);
  }

  /**
   * Logique commune de conversation + function calling, partagée entre
   * magentochat et prestashopchat (avant, c'était le même code dupliqué
   * deux fois avec juste les tools qui changeaient).
   *
   * @private
   */
  async _runChat(history, userMessage, context, toolDefinitions, toolImplementations) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Si le widget a réussi à identifier le client (déjà connecté sur
    // le site Magento/PrestaShop), on le donne au modèle une bonne
    // fois pour toutes, pour qu'il ne redemande jamais l'email.
    if (context.customerEmail) {
      messages.push({
        role: 'system',
        content:
          `Le client est déjà identifié : son email est ${context.customerEmail} ` +
          `(récupéré automatiquement depuis sa session connectée sur le site, ` +
          `pas besoin de le lui redemander). Utilise directement cet email pour ` +
          `retrouver ses commandes. S'il mentionne explicitement vouloir chercher ` +
          `avec un autre email ou un numéro de commande précis, utilise plutôt ` +
          `cette information-là.`
      });
    }

    messages.push(...history, { role: 'user', content: userMessage });

    // Boucle de function calling : le modèle peut demander plusieurs
    // appels d'outils successifs avant de donner sa réponse finale.
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
        temperature: 0.3 // bas = réponses plus factuelles, moins créatives (important pour du SAV)
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Cas 1 : le modèle veut appeler un ou plusieurs outils
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // On ajoute le message assistant (avec ses tool_calls) à l'historique
        messages.push(assistantMessage);

        // On exécute chaque appel d'outil demandé
        for (const toolCall of assistantMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            args = {};
          }

          let result;
          try {
            const impl = toolImplementations[fnName];
            if (!impl) throw new Error(`Fonction inconnue: ${fnName}`);
            result = await impl(args);
          } catch (error) {
            // On ne casse jamais la conversation : on renvoie l'erreur
            // au modèle sous forme de texte, il saura la gérer/reformuler.
            result = { error: true, message: error.message || 'Erreur inconnue.' };
          }

          // Réponse de l'outil réinjectée dans la conversation
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result ?? null)
          });
        }

        // On reboucle : on renvoie tout au modèle pour qu'il continue
        // (soit un nouvel appel d'outil, soit la réponse finale)
        continue;
      }

      // Cas 2 : réponse finale en texte, on sort de la boucle
      const finalHistory = [...history, { role: 'user', content: userMessage }, assistantMessage];
      return { reply: assistantMessage.content, history: finalHistory };
    }

    // Garde-fou si jamais le modèle boucle trop sur des appels d'outils
    return {
      reply:
        "Je rencontre une difficulté à traiter votre demande automatiquement. Un conseiller va prendre le relais.",
      history: [...history, { role: 'user', content: userMessage }]
    };
  }
}

module.exports = OpenAiService;