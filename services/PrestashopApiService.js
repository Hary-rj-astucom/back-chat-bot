require('dotenv').config();
const axios = require('axios');
const https = require('https');

const apiKey = process.env.PRESTASHOP_API_KEY;
const shopUrl = process.env.PRESTASHOP_URL;

const shopUrlDigiparf = process.env.PRESTASHOP_DIGIPARF_URL;
const shopUrlHelfrich = process.env.PRESTASHOP_HELFRICH_URL;
const shopUrlUniverscse = process.env.PRESTASHOP_UNIVERSCSE_URL;

const shopUrlAmbitioncse = process.env.PRESTASHOP_AMBITIONCSE_URL;
const shopUrlClubulys = process.env.PRESTASHOP_CLUBULYS_URL;
const shopUrlReducce = process.env.PRESTASHOP_REDUCCE_URL;

const apiUrlDigiparf = `${shopUrlDigiparf}/api/`;
const apiUrlHelfrich = `${shopUrlHelfrich}/api/`;
const apiUrlUniversce = `${shopUrlUniverscse}/api/`;

const apiUrlAmbitioncse = `${shopUrlAmbitioncse}/api/`;
const apiUrlClubulys = `${shopUrlClubulys}/api/`;
const apiUrlReducce = `${shopUrlReducce}/api/`;

// Agent HTTPS partagé (créé une seule fois, au lieu de le recréer à
// chaque appel comme dans la version précédente avec `await import('https')`)
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// Fonction générique pour appeler l'API PrestaShop
async function callPrestaShopAPI(url) {
  try {
    const response = await axios.get(url, {
      auth: {
        username: apiKey,
        password: "",
      },
      timeout: 30000,
      httpsAgent: insecureHttpsAgent,
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Erreur HTTP: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else {
      throw new Error(`Erreur Axios: ${error.message}`);
    }
  }
}

function handleError(context, error) {
  console.error(`Erreur_Prestashop [${context}]:`, error.message);
  throw error;
}

// ============================================================
// Boutiques : cascade de recherche multi-boutique (comportement
// identique à ta version précédente, mais en boucle plutôt qu'en
// switch récursif -> plus simple à étendre)
// ============================================================

// Boutiques incluses dans la recherche AUTOMATIQUE d'une commande par
// référence (ordre = ordre de recherche). Ajoute une entrée ici si une
// autre boutique doit aussi être scannée automatiquement.
const SEARCH_SHOPS = [
  { name: 'Digiparf', apiUrl: apiUrlDigiparf },
  { name: 'Helfrich', apiUrl: apiUrlHelfrich },
  { name: 'Universce', apiUrl: apiUrlUniversce }
];

// Table complète des boutiques connues (utile pour les fonctions qui
// demandent explicitement une boutique, ex: recherche produit).
const ALL_SHOPS = {
  Digiparf: apiUrlDigiparf,
  Helfrich: apiUrlHelfrich,
  Universce: apiUrlUniversce,
  Ambitioncse: apiUrlAmbitioncse,
  Clubulys: apiUrlClubulys,
  Reducce: apiUrlReducce
};

function resolveApiUrl(boutique) {
  const apiUrl = ALL_SHOPS[boutique];
  if (!apiUrl) throw new Error(`Boutique inconnue: "${boutique}". Boutiques valides: ${Object.keys(ALL_SHOPS).join(', ')}`);
  return apiUrl;
}

// Garde-fou pagination, même principe que côté Magento : borne le
// nombre de résultats entre 1 et 10 (5 par défaut).
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 10;
function normalizeLimit(limit) {
  const n = parseInt(limit, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

// ============================================================
// COMMANDES — fonctions de base (déjà existantes, inchangées)
// ============================================================

// Récupérer une commande spécifique
async function getOrderById(apiUrl, order_id) {
  const url = `${apiUrl}orders/${order_id}?output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.order ?? null;
}

// Récupérer un client par ID
async function getCustomerById(apiUrl, customerId) {
  const url = `${apiUrl}customers/${customerId}?output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.customer ?? null;
}

// Récupérer un statut de commande
async function getOrderStateById(apiUrl, stateId) {
  const url = `${apiUrl}order_states/${stateId}?output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.order_state ?? null;
}

// Récupérer les produits d'une commande
async function getOrderDetails(apiUrl, order_id) {
  const url = `${apiUrl}order_details?filter[id_order]=${order_id}&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.order_details ?? [];
}

// Recuperer les information de transaction
async function getOrderPayement(apiUrl, order_id) {
  const url = `${apiUrl}order_payments?filter[order_reference]=${order_id}&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  let result = [];
  if (data.order_payments.length > 0) {
    for (let a = 0; a < data.order_payments.length; a++) {
      result.push(await getOrderPayementDetail(apiUrl, data.order_payments[0].id));
    }
    return result;
  } else {
    return [];
  }
}

// Recuperation des data de l'info payement
async function getOrderPayementDetail(apiUrl, order_payment_id) {
  const url = `${apiUrl}order_payments/${order_payment_id}?output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.order_payment ?? [];
}

// Recuperation de l'order selon la reference du client
async function getOrderByReferenceNum(apiUrl, reference) {
  const url = `${apiUrl}orders?filter[reference]=${reference}&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  if (data.length == 0) {
    return null;
  } else {
    return data.orders[0].id ?? null;
  }
}

// ============================================================
// Localisation d'une commande (dans quelle boutique se trouve-t-elle ?)
// -> remplace le switch récursif par une boucle sur SEARCH_SHOPS.
// Utilisée par TOUTES les fonctions granulaires ci-dessous, pour ne
// faire l'appel de résolution qu'une seule fois.
// ============================================================
async function findOrderLocation(reference) {
  for (const shop of SEARCH_SHOPS) {
    const orderId = await getOrderByReferenceNum(shop.apiUrl, reference);
    if (orderId) {
      return { boutique: shop.name, apiUrl: shop.apiUrl, orderId };
    }
  }
  throw new Error(`Commande "${reference}" introuvable dans les boutiques : ${SEARCH_SHOPS.map(s => s.name).join(', ')}`);
}

// ============================================================
// Commandes par email client
// Contrairement à une référence de commande (unique à une boutique),
// un même email peut exister sur PLUSIEURS boutiques -> on interroge
// toutes les boutiques du cascade et on fusionne les résultats.
// ============================================================

// Retrouve l'id client PrestaShop correspondant à un email, sur UNE boutique
async function getCustomerIdByEmail(apiUrl, email) {
  const url = `${apiUrl}customers?filter[email]=${encodeURIComponent(email)}&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  const customers = data.customers || [];
  return customers[0]?.id ?? null;
}

// Commandes d'un client (déjà identifié par id) sur UNE boutique
// On demande directement les champs utiles via `display=[...]` pour
// éviter un appel getOrderById par commande (plus rapide).
// ⚠️ `date_add` n'est PAS un champ filtrable/triable exposé par le
// webservice PrestaShop (l'API le rejette avec l'erreur "Unable to
// filter by this field"). On trie donc par `id` décroissant, un ID
// plus élevé correspondant à une commande plus récente.
async function getOrdersByCustomerId(apiUrl, customerId, limit) {
  const url =
    `${apiUrl}orders?filter[id_customer]=${customerId}` +
    `&sort=id_DESC&limit=0,${limit}` +
    `&display=[id,reference,total_paid,current_state]` +
    `&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.orders || [];
}

// Dernières commandes d'un client à partir de son email, tous magasins
// confondus du cascade (SEARCH_SHOPS). C'est l'équivalent PrestaShop de
// get_last_orders_by_email côté Magento : point d'entrée par défaut
// quand le client ne connaît pas son numéro de commande.
async function getOrdersByEmail(email, limit = DEFAULT_PAGE_SIZE) {
  try {
    const pageSize = normalizeLimit(limit);
    const results = [];

    for (const shop of SEARCH_SHOPS) {
      const customerId = await getCustomerIdByEmail(shop.apiUrl, email);
      if (!customerId) continue;

      const orders = await getOrdersByCustomerId(shop.apiUrl, customerId, pageSize);
      orders.forEach((o) => results.push({ boutique: shop.name, ...o }));
    }

    if (results.length === 0) {
      throw new Error(`Aucune commande trouvée pour l'email "${email}"`);
    }

    // Tri global (toutes boutiques confondues) du plus récent au plus
    // ancien. `date_add` n'étant pas exposé par l'API, on utilise `id`
    // décroissant comme proxy de recency (valable au sein d'une même
    // boutique ; en cross-boutique c'est une approximation raisonnable
    // puisque chaque boutique a sa propre séquence d'ID).
    results.sort((a, b) => Number(b.id) - Number(a.id));
    return results.slice(0, pageSize);
  } catch (error) {
    handleError('getOrdersByEmail', error);
  }
}

//avoir les donnees avec les references digiparf:[UCMRBZIYS] - helfrich[OSAQVJDNX] - univercse[JTFRORPVM]
// (comportement identique à la version précédente, réécrit avec findOrderLocation)
async function getOrderByReference(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);

    const order = await getOrderById(apiUrl, orderId);
    if (!order) throw new Error("Commande non trouvée ou erreur lors de la récupération");

    let customer = null;
    if (order.id_customer) {
      customer = await getCustomerById(apiUrl, order.id_customer);
      console.log(customer ? "✓ Informations client récupérées !" : "⚠️ Impossible de récupérer les infos client");
    }

    let orderState = null;
    if (order.current_state) {
      orderState = await getOrderStateById(apiUrl, order.current_state);
      console.log(orderState ? "✓ Statut récupéré !" : "⚠️ Impossible de récupérer le statut");
    }

    const orderDetails = await getOrderDetails(apiUrl, orderId);
    console.log(orderDetails.length > 0 ? `✓ ${orderDetails.length} produit(s) récupéré(s)` : "⚠️ Aucun produit trouvé");

    const transaction_details = await getOrderPayement(apiUrl, reference);
    console.log(transaction_details ? "✓ detail payment récupéré !" : "⚠️ Impossible de récupérer le detail payment");

    return {
      boutique,
      order,
      customer,
      orderState,
      orderDetails,
      transaction_details
    };

  } catch (err) {
    console.error("❌ Erreur:", err.message);
    throw err;
  }
}

// ============================================================
// COMMANDES — fonctions granulaires (nouvelles)
// Chacune ne fait que les appels API strictement nécessaires,
// plutôt que de tout récupérer comme getOrderByReference.
// ============================================================

// Statut d'une commande
async function getOrderStatus(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);
    const order = await getOrderById(apiUrl, orderId);
    const orderState = order?.current_state ? await getOrderStateById(apiUrl, order.current_state) : null;
    return {
      boutique,
      status: orderState?.name ?? null
    };
  } catch (error) {
    handleError('getOrderStatus', error);
  }
}

// Articles d'une commande
async function getOrderItems(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);
    const orderDetails = await getOrderDetails(apiUrl, orderId);
    return { boutique, items: orderDetails };
  } catch (error) {
    handleError('getOrderItems', error);
  }
}

// Totaux d'une commande
async function getOrderTotal(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);
    const order = await getOrderById(apiUrl, orderId);
    return {
      boutique,
      total_paid: order?.total_paid,
      total_paid_real: order?.total_paid_real,
      total_products: order?.total_products,
      total_shipping: order?.total_shipping,
      total_discounts: order?.total_discounts,
      currency: order?.id_currency
    };
  } catch (error) {
    handleError('getOrderTotal', error);
  }
}

// Suivi de livraison d'une commande
// ⚠️ Dépend de la config PrestaShop (transporteur/module de livraison).
// On récupère le numéro de suivi + le transporteur via order_carriers.
async function getTracking(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);
    const url = `${apiUrl}order_carriers?filter[id_order]=${orderId}&output_format=JSON`;
    const data = await callPrestaShopAPI(url);
    const orderCarriers = data.order_carriers ?? [];

    const tracks = [];
    for (const oc of orderCarriers) {
      // La liste ne donne que des ID, il faut récupérer le détail de chaque order_carrier
      const detailUrl = `${apiUrl}order_carriers/${oc.id}?output_format=JSON`;
      const detail = await callPrestaShopAPI(detailUrl);
      const info = detail.order_carrier;
      if (!info) continue;

      let carrierName = null;
      if (info.id_carrier) {
        const carrierUrl = `${apiUrl}carriers/${info.id_carrier}?output_format=JSON`;
        const carrierData = await callPrestaShopAPI(carrierUrl);
        carrierName = carrierData.carrier?.name ?? null;
      }

      tracks.push({
        tracking_number: info.tracking_number || null,
        carrier: carrierName
      });
    }

    return { boutique, tracks };
  } catch (error) {
    handleError('getTracking', error);
  }
}

// Méthode / détail de paiement d'une commande
async function getPaymentMethod(reference) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);
    const order = await getOrderById(apiUrl, orderId);
    const transaction_details = await getOrderPayement(apiUrl, reference);
    return {
      boutique,
      payment_method: order?.payment ?? null,
      total_paid: order?.total_paid,
      transaction_details
    };
  } catch (error) {
    handleError('getPaymentMethod', error);
  }
}

// ============================================================
// PRODUITS — nécessitent de préciser explicitement la boutique
// (contrairement aux commandes, les catalogues produits ne sont
// pas cherchés automatiquement dans toutes les boutiques : un même
// mot-clé pourrait matcher des produits différents selon la boutique)
// ============================================================

// Recherche de produits par mot-clé dans le nom
async function searchProducts(query, boutique, limit = DEFAULT_PAGE_SIZE) {
  try {
    const apiUrl = resolveApiUrl(boutique);
    const pageSize = normalizeLimit(limit);
    const url = `${apiUrl}products?filter[name]=${encodeURIComponent('%' + query + '%')}&sort=name_ASC&limit=0,${pageSize}&output_format=JSON`;
    const data = await callPrestaShopAPI(url);
    return data.products || [];
  } catch (error) {
    handleError('searchProducts', error);
  }
}

// Détail d'un produit via son ID PrestaShop
async function getProduct(idProduct, boutique) {
  try {
    const apiUrl = resolveApiUrl(boutique);
    const url = `${apiUrl}products/${idProduct}?output_format=JSON`;
    const data = await callPrestaShopAPI(url);
    return data.product ?? null;
  } catch (error) {
    handleError('getProduct', error);
  }
}

// Stock disponible d'un produit
async function getProductStock(idProduct, boutique) {
  try {
    const apiUrl = resolveApiUrl(boutique);
    const url = `${apiUrl}stock_availables?filter[id_product]=${idProduct}&output_format=JSON`;
    const data = await callPrestaShopAPI(url);
    return data.stock_availables || [];
  } catch (error) {
    handleError('getProductStock', error);
  }
}

// ============================================================
// INFORMATIONS BOUTIQUE (pages CMS)
// ⚠️ Non standardisé nativement : on suppose que ces informations
// vivent dans des pages CMS identifiées par leur "link_rewrite".
// Adapte les identifiants par défaut selon ta config PrestaShop.
// ============================================================

async function getCmsPageByLinkRewrite(apiUrl, linkRewrite) {
  const url = `${apiUrl}cms?filter[link_rewrite]=${encodeURIComponent(linkRewrite)}&output_format=JSON`;
  const data = await callPrestaShopAPI(url);
  return data.cms?.[0] || null;
}

async function getReturnPolicy(boutique, linkRewrite = 'politique-de-retour') {
  try {
    const apiUrl = resolveApiUrl(boutique);
    return await getCmsPageByLinkRewrite(apiUrl, linkRewrite);
  } catch (error) {
    handleError('getReturnPolicy', error);
  }
}

async function getContactInformation(boutique, linkRewrite = 'contact') {
  try {
    const apiUrl = resolveApiUrl(boutique);
    return await getCmsPageByLinkRewrite(apiUrl, linkRewrite);
  } catch (error) {
    handleError('getContactInformation', error);
  }
}

async function getStoreHours(boutique, linkRewrite = 'horaires') {
  try {
    const apiUrl = resolveApiUrl(boutique);
    return await getCmsPageByLinkRewrite(apiUrl, linkRewrite);
  } catch (error) {
    handleError('getStoreHours', error);
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  ALL_SHOPS,
  SEARCH_SHOPS,

  // Bas niveau (déjà existant)
  callPrestaShopAPI,
  getOrderById,
  getCustomerById,
  getOrderStateById,
  getOrderDetails,
  getOrderPayement,
  getOrderPayementDetail,
  getOrderByReferenceNum,
  getOrderByReference,
  findOrderLocation,
  getOrdersByEmail,

  // Commandes (granulaire)
  getOrderStatus,
  getOrderItems,
  getOrderTotal,
  getTracking,
  getPaymentMethod,

  // Produits
  searchProducts,
  getProduct,
  getProductStock,

  // Boutique
  getReturnPolicy,
  getContactInformation,
  getStoreHours
};