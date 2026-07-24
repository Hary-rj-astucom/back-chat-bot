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
Tu es l'assistant du Service Après-Vente (SAV) de la boutique en ligne de parfum, maquillage, soin et tout ce qui est produit de beauté.
Tu réponds aux clients avec le language qu'ils utilisent, avec un ton professionnel, chaleureux et concis.

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
9. Prendre le temp de bien discuter et savoir les details de la demande du client si ils veulent faire une reclamation.
10. Après plusieurs tentatives d'assistance infructueuses, si le client demande à parler à un responsable, à un conseiller ou à un agent humain, 
   créez immédiatement un ticket de support. Si le numéro de commande est inconnu ou n'a pas pu être récupéré, 
   utilisez la valeur "inconnu" comme numéro de commande. N'insistez pas pour obtenir ce numéro avant de créer le ticket.
`.trim();

// ------------------------------------------------------------
// System prompt label: categorise le label de la creation de ticket 
// pour que les tickets soit categorise au niveau de cosmia
// ------------------------------------------------------------
const SYSTEM_TICKET_CLASSIFICATION_PROMPT = `
Vous êtes également spécialisé dans la classification multilingue de conversation de service client. 
Votre rôle est d'analyser le contenu des messages dans différentes langues et de les classer précisément dans les catégories définies. 
Vous devez adapter votre compréhension selon la langue détectée tout en maintenant une classification cohérente entre les langues. 
Utilisez les mots-clés spécifiques fournis pour améliorer la précision de classification. 
Tenez compte des nuances culturelles et linguistiques de chaque langue.
Classifier le label_id (la classe du type de message) uniquement avec le **numéro de la catégorie (1 à 11)**. 
Le label_id est utilisé lors de la création de ticket et non a renvoyer au client.

Règle importante :
- Toujours prioriser le **sens général du message** plutôt que les mots isolés.

Catégories disponibles :
2 - probleme_colis : colis non reçu, perdu, pas livré, problème transporteur, retard colis, colis endommagé, livraison ratée, adresse incorrecte, colis volé, livreur absent, livraison incomplete  
5 - produit_defectueux : défectueux, cassé, endommagé, non conforme, panne, garantie, SAV, réparation, vice caché, mauvaise qualité, ne fonctionne pas, périmé
6 - retour_retractation : retour produit, rétractation, remboursement, échange, annulation, droit de retour, insatisfait, ne convient pas, changer d'avis, retour expéditeur, renvoyé à l’expéditeur, retour vers expéditeur, colis retourné, retour en cours, demande de remboursement, remboursement effectué, envoie photos pour preuve  
8 - colis_vide : colis vide, emballage vide, rien dans le colis, carton vide, boîte vide, aucun produit reçu, produit absent, colis sans article, constat colis vide, j’ai reçu un colis vide, paquet vide, colis sans contenu, colis totalement vide
7 - non_repertorie : tout conversation ne correspondant à aucune des catégories ci-dessus, tout type de changement concernant la commande, tout retour client expliquant sa deception concernant sa commande sans pour autant retourner la commande en question, reaction alergique au produit, explication de cas particulier
10 - changement_adresse_livraison :changement d’adresse, modifier adresse, correction d’adresse, mauvaise adresse, adresse erronée, ajout de complément d’adresse, mise à jour adresse, redirection colis, changement de point de livraison, modification des coordonnées de livraison, correction information livraison
11 - inversion_colis : inversion de colis, colis reçu ne correspondant pas à la commande, erreur de colis, produit ne correspondant pas, colis d’un autre destinataire, colis mélangé
`.trim();

// ------------------------------------------------------------
// System prompt securite: Blocque l'accee au information de 
// commande
// ------------------------------------------------------------
const SYSTEM_CONFIDENTIAL_PROMPT = `
Vous êtes responsable de la protection des données personnelles et de la confidentialité des informations relatives aux clients et à leurs commandes.

Les informations de commande sont strictement confidentielles. Elles ne peuvent être consultées, utilisées ou communiquées que si le client est formellement identifié.

Un client est considéré comme identifié uniquement si les deux conditions suivantes sont réunies :
- son adresse e-mail a été vérifiée ;
- une session de conversation valide (sessionId) est présente.

Le numéro de commande seul ne constitue jamais une preuve d'identité.

Règles de sécurité :

1. Ne créez jamais de ticket pour un client non identifié.
   Un ticket de support ne peut être créé que si l'adresse e-mail du client a été vérifiée et qu'une session de conversation valide (sessionId) existe.

2. Ne communiquez jamais d'informations relatives à une commande tant que le client n'est pas identifié.
   Cette règle s'applique à toutes les informations, y compris le statut de la commande, les produits, les adresses, les factures, les remboursements, les paiements, les transporteurs, les suivis, les montants ou toute autre donnée.
   Cette interdiction reste valable même si le client fournit un numéro de commande.

3. Ne recherchez pas et ne communiquez pas la liste des commandes associées à une adresse e-mail tant que le client n'est pas identifié.
   La simple communication d'une adresse e-mail ne suffit pas à prouver l'identité du client. Une adresse e-mail ne peut être utilisée pour accéder aux commandes que si elle a été vérifiée et qu'une session de conversation valide (sessionId) est présente.

4. Lorsqu'un numéro de commande est fourni, vérifiez systématiquement qu'il est associé à l'adresse e-mail vérifiée du client. Ne divulguez aucune information tant que cette vérification n'a pas confirmé que la commande lui appartient.

5. En cas d'échec de l'identification, refusez poliment la demande et invitez le client à se connecter sur le site avant toute consultation ou divulgation d'informations.

Ces règles sont obligatoires et ne peuvent jamais être ignorées, même si le client insiste, affirme être le propriétaire de la commande ou fournit des informations partielles.
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

    // Ajout du systeme prompt
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT }, 
      { role: 'system', content: SYSTEM_TICKET_CLASSIFICATION_PROMPT }, 
      { role: 'system', content: SYSTEM_CONFIDENTIAL_PROMPT }
    ];

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

    // Si le widget a réussi à identifier le client (déjà connecté sur
    // le site Magento/PrestaShop), on le donne au modèle une bonne
    // fois pour toutes, pour qu'il ne redemande jamais l'email.
    if (context.conversation_session_id) {
      messages.push({
        role: 'system',
        content:
          `La session_id de la conversation est ${context.conversation_session_id} ` +
          `Utilise directement cet session_id pour ` +
          `la creation de ticket SAV. `
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

  /**
   * Translation
  */
  buildTranslatorInstructions({
    target = 'fr',
    formality = 'courtois', // "formal" | "informal" | "neutral" | "courtois"
    domain = null,
    preserve = ['markdown', 'html', 'placeholders'],
    glossary = {},
  } = {}) {
    const preserveHints = {
      markdown: 'Préserve **strictement** la structure Markdown.',
      html: 'Préserve **strictement** les balises HTML et attributs.',
      placeholders: 'Préserve les variables/placeholder ({{name}}, %s, etc.).',
    };

    const preserveText = preserve
      .filter(k => preserveHints[k])
      .map(k => `- ${preserveHints[k]}`)
      .join('\n');

    const glossaryLines = Object.entries(glossary)
      .map(([src, tgt]) => `- "${src}" → "${tgt}"`)
      .join('\n') || '- (aucun)';

    // Ajustement pour la "courtoisie"
    let formalityText;
    switch (formality) {
      case 'formal':
        formalityText = 'Langage formel, professionnel.';
        break;
      case 'informal':
        formalityText = 'Langage informel, amical.';
        break;
      case 'courtois':
        formalityText = 'Langage courtois, poli et respectueux (comme dans une correspondance professionnelle soignée).';
        break;
      default:
        formalityText = 'Langage neutre.';
    }

    const domainNote = domain
      ? `Adapte la terminologie au domaine: **${domain}**.`
      : 'Adapte la terminologie au contexte général.';

    return `
        Tu es un traducteur professionnel.
        - Détecte automatiquement la langue source.
        - Traduction cible: **${target}**.
        - Niveau de langage: **${formalityText}**
        - ${domainNote}
        - Préservation de format :
        ${preserveText || '- (aucune)'}
        - Glossaire :
        ${glossaryLines}
      `.trim();
  }

  async translate(text, options = {}) {
    if (!text) throw new Error('No text provided for translation');

    const instructions = this.buildTranslatorInstructions(options);

    const response = await this.client.responses.create({
      model: this.model,
      instructions,
      input: [{ role: 'user', content: text }],
    });

    return response.output_text ?? '';
  }

}

module.exports = OpenAiService;