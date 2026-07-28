/**
 * PrestashopTools.js
 * ------------------------------------------------------------
 * Fait le pont entre PrestashopApiService.js et le format "tools"
 * attendu par l'API OpenAI (function calling). Même principe que
 * magentoTools.js.
 *
 * Particularité Prestashop : plusieurs boutiques (Digiparf, Helfrich,
 * Universce, Ambitioncse, Clubulys, Reducce).
 *  - Pour les COMMANDES : le modèle n'a jamais besoin de préciser la
 *    boutique, la recherche est automatique (getOrderByReference /
 *    findOrderLocation scannent les boutiques concernées).
 *  - Pour la RECHERCHE PRODUITS : la boutique est optionnelle. Si le
 *    modèle ne la précise pas, la recherche se fait automatiquement
 *    sur TOUTES les boutiques et les résultats sont fusionnés.
 *  - Pour le détail/stock d'un produit précis (via son ID) et pour les
 *    infos boutique (retours, contact, horaires), la boutique DOIT être
 *    précisée explicitement (paramètre `boutique`, en enum fermée),
 *    car un même ID produit n'a de sens que dans une boutique donnée.
 * ------------------------------------------------------------
 */

const prestashopService = require('../services/PrestashopApiService');
const ticketService = require('../services/TicketService');
const ShippingboApiService = require('../services/ShippingboApiService');
const shippingbo = new ShippingboApiService();

const BOUTIQUE_ENUM = Object.keys(prestashopService.ALL_SHOPS);

const LIST_LIMIT_SCHEMA = {
  type: 'integer',
  description: 'Nombre de résultats à retourner (1 à 10).',
  minimum: 1,
  maximum: 10,
  default: 5
};

const BOUTIQUE_SCHEMA = {
  type: 'string',
  description: "Nom de la boutique concernée.",
  enum: BOUTIQUE_ENUM
};

// ------------------------------------------------------------
// 1. Schémas des fonctions (ce que le modèle "voit")
// ------------------------------------------------------------
const prestashopToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_orders_by_email',
      description:
        "Récupère les dernières commandes d'un client à partir de son adresse email, tous magasins confondus, triées de la plus récente à la plus ancienne. C'est le point d'entrée par défaut quand le client ne connaît pas (ou ne donne pas) son numéro de commande.",
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Adresse email du client.' },
          limit: LIST_LIMIT_SCHEMA
        },
        required: ['email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_by_reference',
      description:
        "Récupère TOUTES les informations d'une commande (détail commande, client, statut, articles, paiement) à partir de son numéro de référence visible par le client. Recherche automatiquement dans toutes les boutiques, pas besoin de préciser laquelle. À utiliser en priorité si le client pose plusieurs questions à la fois sur sa commande (ex: statut ET contenu ET paiement). Si une seule information précise est demandée (juste le statut, juste le suivi...), préfère la fonction dédiée correspondante, plus rapide.",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande visible par le client.' },
          email_client: { type: 'string', description: "Email utilise par le client lors de son identification" },
        },
        required: ['reference', 'email_client']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: "Donne uniquement le statut d'une commande (ex: en cours de traitement, expédiée, livrée, annulée).",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande.' }
        },
        required: ['reference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_items',
      description: "Liste uniquement les articles (produits, quantités) contenus dans une commande.",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande.' }
        },
        required: ['reference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_total',
      description: "Donne uniquement le détail financier d'une commande (total payé, produits, livraison, remises).",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande.' }
        },
        required: ['reference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tracking',
      description: "Donne uniquement les informations de suivi de livraison (transporteur, numéro de suivi) d'une commande.",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande.' }
        },
        required: ['reference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_payment_method',
      description: "Donne uniquement la méthode de paiement et les détails de transaction d'une commande.",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Numéro de référence de commande.' }
        },
        required: ['reference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        "Recherche de produits. Combine librement tous les critères fournis (recherche AND) : mot-clé dans le nom, référence/SKU, mot-clé dans la description, fourchette de prix, marque, catégorie (ex: 'Homme', 'Femme', 'Soin') et note olfactive (ex: boisé, floral, oriental). Si aucune boutique n'est précisée, recherche automatiquement sur TOUTES les boutiques et fusionne les résultats (chaque résultat indique sa boutique d'origine). Précise `boutique` uniquement si le client demande explicitement une boutique donnée. Retourne au maximum 10 résultats.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Mot-clé dans le nom du produit.' },
          sku: { type: 'string', description: 'Référence produit (SKU), exacte ou partielle.' },
          description: { type: 'string', description: 'Mot-clé recherché dans la description du produit.' },
          price_min: { type: 'number', description: 'Prix minimum.' },
          price_max: { type: 'number', description: 'Prix maximum.' },
          brand: { type: 'string', description: "Nom de la marque (ex: 'Dior', 'Chanel')." },
          category: { type: 'string', description: "Nom de la catégorie (ex: 'Homme', 'Femme', 'Maquillage')." },
          olfactory_note: { type: 'string', description: 'Note olfactive recherchée (ex: boisé, floral, oriental, gourmand).' },
          boutique: {
            type: 'string',
            description: "Boutique précise à cibler. Ne pas renseigner pour chercher sur toutes les boutiques à la fois.",
            enum: BOUTIQUE_ENUM
          },
          limit: LIST_LIMIT_SCHEMA
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_product',
      description: "Détail complet d'un produit via son ID PrestaShop, dans une boutique précise.",
      parameters: {
        type: 'object',
        properties: {
          idProduct: { type: 'string', description: 'ID PrestaShop du produit.' },
          boutique: BOUTIQUE_SCHEMA
        },
        required: ['idProduct', 'boutique']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_product_stock',
      description: "Vérifie la disponibilité en stock d'un produit via son ID, dans une boutique précise.",
      parameters: {
        type: 'object',
        properties: {
          idProduct: { type: 'string', description: 'ID PrestaShop du produit.' },
          boutique: BOUTIQUE_SCHEMA
        },
        required: ['idProduct', 'boutique']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_return_policy',
      description: "Donne la politique de retour d'une boutique précise.",
      parameters: {
        type: 'object',
        properties: { boutique: BOUTIQUE_SCHEMA },
        required: ['boutique']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_contact_information',
      description: "Donne les coordonnées de contact du service client d'une boutique précise.",
      parameters: {
        type: 'object',
        properties: { boutique: BOUTIQUE_SCHEMA },
        required: ['boutique']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_store_hours',
      description: "Donne les horaires d'ouverture du service client d'une boutique précise.",
      parameters: {
        type: 'object',
        properties: { boutique: BOUTIQUE_SCHEMA },
        required: ['boutique']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_store_information',
      description: "Donne la description de la boutique",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_store_locations',
      description: "Donne la localisation de la boutique",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_terms',
      description: "Avoir les terms et condition general de la boutique en ligne",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_privacy_policy',
      description: "Avoir la politique de confidentialite",
      parameters: { type: 'object', properties: {} }
    }
  },

  // fonction issue de shippingbo
  {
    type: 'function',
    function: {
      name: 'get_order_shippinbo_info_by_reference',
      description: "Retourne tout ce qui est processus de preparation jusqu'a livraison de la commande à partir de son numéro visible par le client. Information visible depuis shippingbo. Il faut appeller cette fonction quand on ne trouve pas de lien de suivi sur les autres fonctions",
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Le numero de commande visible par le client' }
        },
        required: ['reference']
      }
    }
  },

  // fonction specialiser dans la creation du ticket
  {
    type: 'function',
    function: {
      name: 'create_ticket',
      description: "Cree un ticket dans la base de données quand le client demande une assistance physique ou de resoudre un probleme dans le categorie de massage",
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'integer', description: 'ID du projet dans la base de donnees.' }, 
          subject_ticket: { type: 'string', description: 'Le sujet qui englobe le probleme du client' }, 
          conversation_session_id: { type: 'string', description: 'la session_id de la conversation. Si il n\'y a pas mettre "null" ' }, 
          to_do: { type: 'string', description: 'Une description du probleme du client apres analyse de la conversation' }, 
          original_client_mail: { type: 'string', description: 'L\'email du client' }, 
          reception_mail: { type: 'string', description: 'le mail du service client' }, 
          nom_client: { type: 'string', description: 'Le nom du client' }, 
          num_commande: { type: 'string', description: 'Le numero de commande visible par le client. Si il n\'y a pas mettre "inconnu"' }, 
          label_id: { type: 'integer', description: 'Le numero  de la categorie issue de la classification de la conversation' }
        },
        required: ['subject_ticket', 'conversation_session_id', 'to_do', 'original_client_mail', 'nom_client', 'num_commande', 'label_id']
      }
    }
  },
];

// ------------------------------------------------------------
// 2. Table de correspondance nom -> fonction réelle
// ------------------------------------------------------------
const prestashopToolImplementations = {
  get_orders_by_email: (args) => prestashopService.getOrdersByEmail(args.email, args.limit),
  get_order_by_reference: (args) => prestashopService.getOrderByReference(args.reference, args.email_client),
  get_order_status: (args) => prestashopService.getOrderStatus(args.reference),
  get_order_items: (args) => prestashopService.getOrderItems(args.reference),
  get_order_total: (args) => prestashopService.getOrderTotal(args.reference),
  get_tracking: (args) => prestashopService.getTracking(args.reference),
  get_payment_method: (args) => prestashopService.getPaymentMethod(args.reference),

  search_products: (args) => prestashopService.searchProducts({
    query: args.query,
    sku: args.sku,
    description: args.description,
    priceMin: args.price_min,
    priceMax: args.price_max,
    brand: args.brand,
    category: args.category,
    olfactoryNote: args.olfactory_note,
    limit: args.limit
  }, args.boutique),
  get_product: (args) => prestashopService.getProduct(args.idProduct, args.boutique),
  get_product_stock: (args) => prestashopService.getProductStock(args.idProduct, args.boutique),

  get_return_policy: (args) => prestashopService.getReturnPolicy(args.boutique),
  get_contact_information: (args) => prestashopService.getContactInformation(args.boutique),
  get_store_hours: (args) => prestashopService.getStoreHours(args.boutique),
  get_store_information: () => prestashopService.get_store_information(),
  get_store_locations: () => prestashopService.get_store_locations(),
  get_terms: () => prestashopService.get_terms(),
  get_privacy_policy: () => prestashopService.get_privacy_policy(),

  // fonction issue de shippingbo
  get_order_shippinbo_info_by_reference: (args) => shippingbo.getOrderByReference(args.reference),

  // creation de ticket 
  create_ticket: (args) => ticketService.create_ticket(3, args.subject_ticket, args.conversation_session_id, args.to_do, args.original_client_mail, "contact@digiparf.com", args.nom_client, args.num_commande || "inconnu", args.label_id),
};

module.exports = { prestashopToolDefinitions, prestashopToolImplementations };