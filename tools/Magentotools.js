/**
 * magentoTools.js
 * ------------------------------------------------------------
 * Fait le pont entre tes fonctions MagentoApiService.js et le
 * format "tools" attendu par l'API OpenAI (function calling).
 *
 * Deux choses ici :
 *  1. `toolDefinitions` : le schéma JSON que tu envoies à OpenAI
 *     pour lui dire "voici les fonctions que tu peux appeler".
 *  2. `toolImplementations` : la table de correspondance
 *     nom-de-fonction -> vraie fonction JS à exécuter.
 *
 * Idée clé : tu n'exposes QUE les fonctions utiles au SAV client
 * (pas toutes les 40, pour ne pas noyer le modèle et limiter les
 * risques). Ajoute-en au fur et à mesure de tes besoins.
 * ------------------------------------------------------------
 */

const magentoService = require('../services/MagentoApiService');

// ------------------------------------------------------------
// 1. Schémas des fonctions (ce que le modèle "voit")
// ------------------------------------------------------------
const magentoToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_order_by_increment_id',
      description:
        "Récupère les détails complets d'une commande à partir de son numéro visible par le client (ex: 000012345). C'est le point d'entrée par défaut quand un client donne un numéro de commande.",
      parameters: {
        type: 'object',
        properties: {
          orderNumber: {
            type: 'string',
            description: "Numéro de commande visible par le client, ex: '000012345'."
          }
        },
        required: ['orderNumber']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_last_orders_by_email',
      description:
        "Récupère les dernières commandes d'un client à partir de son adresse email. Utile quand le client ne connaît pas son numéro de commande.",
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Adresse email du client.' },
          limit: { type: 'integer', description: 'Nombre de commandes à retourner.', default: 5 }
        },
        required: ['email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: "Donne le statut/état d'une commande (ex: en traitement, expédiée, livrée, annulée).",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: "ID interne (entity_id) de la commande, PAS le numéro visible." }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_items',
      description: "Liste les articles (produits, quantités) contenus dans une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_total',
      description: "Donne le détail financier d'une commande (total, sous-total, livraison, taxes, remise, reste dû).",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tracking',
      description: "Donne les informations de suivi de livraison (transporteur, numéro de suivi) d'une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_shipping_method',
      description: "Donne la méthode de livraison utilisée sur une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_payment_method',
      description: "Donne la méthode de paiement utilisée et le montant payé/à payer sur une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_invoice',
      description: "Récupère la ou les factures liées à une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_credit_memo',
      description: "Récupère le ou les avoirs (remboursements) liés à une commande.",
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID interne (entity_id) de la commande.' }
        },
        required: ['orderId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: "Recherche des produits par mot-clé dans le nom. Utile quand le client cherche un produit sans en connaître le SKU.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Mot-clé de recherche.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_product',
      description: "Détail complet d'un produit via son SKU exact.",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU exact du produit.' }
        },
        required: ['sku']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_product_stock',
      description: "Vérifie la disponibilité en stock d'un produit via son SKU.",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU exact du produit.' }
        },
        required: ['sku']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_return_policy',
      description: "Donne la politique de retour de la boutique.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_contact_information',
      description: "Donne les coordonnées de contact du service client (email, téléphone, adresse).",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_store_hours',
      description: "Donne les horaires d'ouverture du magasin/service client.",
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ------------------------------------------------------------
// 2. Table de correspondance nom -> fonction réelle
//    (doit correspondre EXACTEMENT aux "name" ci-dessus)
// ------------------------------------------------------------
const magentoToolImplementations = {
  get_order_by_increment_id: (args) => magentoService.get_order_by_increment_id(args.orderNumber),
  get_last_orders_by_email: (args) => magentoService.get_last_orders_by_email(args.email, args.limit),
  get_order_status: (args) => magentoService.get_order_status(args.orderId),
  get_order_items: (args) => magentoService.get_order_items(args.orderId),
  get_order_total: (args) => magentoService.get_order_total(args.orderId),
  get_tracking: (args) => magentoService.get_tracking(args.orderId),
  get_shipping_method: (args) => magentoService.get_shipping_method(args.orderId),
  get_payment_method: (args) => magentoService.get_payment_method(args.orderId),
  get_invoice: (args) => magentoService.get_invoice(args.orderId),
  get_credit_memo: (args) => magentoService.get_credit_memo(args.orderId),
  search_products: (args) => magentoService.search_products(args.query),
  get_product: (args) => magentoService.get_product(args.sku),
  get_product_stock: (args) => magentoService.get_product_stock(args.sku),
  get_return_policy: () => magentoService.get_return_policy(),
  get_contact_information: () => magentoService.get_contact_information(),
  get_store_hours: () => magentoService.get_store_hours()
};

module.exports = { magentoToolDefinitions, magentoToolImplementations };