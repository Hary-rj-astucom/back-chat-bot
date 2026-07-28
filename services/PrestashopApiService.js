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

  if (data.length == 0) {
    return [];
  }

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
async function getOrderByReference(reference, email_client) {
  try {
    const { boutique, apiUrl, orderId } = await findOrderLocation(reference);

    const order = await getOrderById(apiUrl, orderId);
    if (!order) throw new Error("Commande non trouvée ou erreur lors de la récupération");

    let customer = null;
    if (order.id_customer) {
      customer = await getCustomerById(apiUrl, order.id_customer);
      console.log(customer ? "✓ Informations client récupérées !" : "⚠️ Impossible de récupérer les infos client");
    }

    // verification de l'appartenance de la commande
    if (customer.email != email_client) {
      return {};
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
// PRODUITS
// ============================================================

// ------------------------------------------------------------
// Détail / stock d'un produit précis (nécessite de connaître déjà
// son ID PrestaShop, obtenu via une recherche préalable)
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Recherche produits — point d'entrée unique.
// Combine librement (AND) : nom, référence/SKU, description (texte
// libre — sert aussi pour une note olfactive éventuellement mentionnée
// dans le texte), prix, marque, catégorie.
// `boutique` optionnel :
//   - fournie  -> recherche uniquement sur cette boutique
//   - omise    -> recherche en parallèle sur TOUTES les boutiques
//                 (ALL_SHOPS) et fusionne les résultats, chacun tagué
//                 avec son nom de boutique d'origine
// ------------------------------------------------------------

// Recherche sur UNE boutique (usage interne, appelée en boucle par
// searchProducts quand aucune boutique n'est précisée)
async function searchProductsInShop(criteria, shopName, apiUrl) {
  const {
    query, sku, description, priceMin, priceMax,
    limit = DEFAULT_PAGE_SIZE
  } = criteria;

  const pageSize = normalizeLimit(limit);
  const filters = [];

  const buildPrestashopFilter = (text) =>
    `%[${text.trim().replace(/\s+/g, '%')}]%`;

  if (query) filters.push(`filter[name]=${buildPrestashopFilter(query)}`);
  if (sku) filters.push(`filter[reference]=${buildPrestashopFilter(sku)}`);
  if (description) filters.push(`filter[description]=${buildPrestashopFilter(description)}`);
  
  const min = priceMin ?? 0.99;
  const max = priceMax ?? 999999;
  filters.push(`filter[price]=${encodeURIComponent(`[${min},${max}]`)}`);

  // ⚠️ C'était ça qui manquait : sans `display`, PrestaShop ne renvoie
  // que les id. On demande ici uniquement les champs utiles à une liste
  // de résultats (léger) — pas `display=full` qui renverrait TOUS les
  // champs + associations par produit (lourd, à réserver à getProduct()
  // pour le détail d'un seul produit).
  const displayFields = '[id,reference,name,price,id_category_default,description]';

  const url =
    `${apiUrl}products?${filters.join('&')}` +
    `&display=${encodeURIComponent(displayFields)}` +
    `&sort=name_ASC&limit=0,${pageSize}&output_format=JSON`;

  const data = await callPrestaShopAPI(url);

  console.log(url);
  console.log(data);

  const products = data.products || [];

  return products.map(p => ({ boutique: shopName, ...p }));
}

async function searchProducts(criteria, boutique = "Digiparf") {
  try {
    const pageSize = normalizeLimit(criteria.limit);

    // Boutique précisée -> recherche mono-boutique
    if (boutique) {
      const apiUrl = resolveApiUrl(boutique);
      return await searchProductsInShop(criteria, boutique, apiUrl);
    }

    // Pas de boutique précisée -> recherche en parallèle sur TOUTES les
    // boutiques. On isole les erreurs par boutique (une boutique en panne
    // ou sans la marque/catégorie ne doit pas faire échouer les autres).
    const shopEntries = Object.entries(ALL_SHOPS); // [nom, apiUrl][]
    const settled = await Promise.allSettled(
      shopEntries.map(([name, apiUrl]) => searchProductsInShop(criteria, name, apiUrl))
    );

    let merged = [];
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        merged = merged.concat(result.value);
      } else {
        console.error(`Erreur_Prestashop [searchProducts/${shopEntries[idx][0]}]:`, result.reason?.message);
      }
    });

    // Tri global par prix croissant (plus pertinent pour une recherche
    // cross-boutique qu'un tri par nom) ; à adapter si besoin.
    merged.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    return merged.slice(0, pageSize);
  } catch (error) {
    handleError('searchProducts', error);
  }
}

// ============================================================
// INFORMATIONS BOUTIQUE (pages CMS)
// ⚠️ Non standardisé nativement : on suppose que ces informations
// vivent dans des pages CMS identifiées par leur "link_rewrite".
// Adapte les identifiants par défaut selon ta config PrestaShop.
// ============================================================


async function getReturnPolicy() {
  try {
    return `
    Livraison à l’entreprise 

    Le colis sera remis contre signature au destinataire.

    Ce récépissé signé vaut preuve de la livraison par la Société et de la réception des Produits
    commandés par l’Acheteur.

    En cas d’absence du destinataire lors de la livraison de la commande, il pourra la récupérer durant les 15 prochains jours à l’adresse indiquée sur l’avis de passage.

    Passé ce délai, la commande sera renvoyée automatiquement à la Société qui reprendra contact avec l’Acheteur pour définir les conditions d’expédition. Les frais de traitement et de livraison seront alors facturés à l’Acheteur.

    7.2. Réception des produits

    Concernant la réception du colis, si le carton d'expédition apparaît visiblement endommagé (colis enfoncé, troué, déchiré, mouillé, découpé au cutter, reconditionné avec un adhésif différent ou si l'une des deux étiquettes située sur l'une des deux face refermable du colis est découpée au niveau de l'ouverture) la réception du colis doit être refusée par le destinataire pour procéder à un retour à la Société ou à défaut des réserves doivent être émises par le destinataire sur le bordereau de réception du transporteur. A défaut, la Société ne pourra procéder à aucun dédommagement de marchandise quand bien même les Produits seraient endommagés, inutilisables ou manquants.

    Lors de la réception du ou des Produit(s), il appartient à l'Acheteur de vérifier sans délai leur conformité et leur intégrité et cela avant de procéder à leur ouverture (ouverture du cellophane de protection).

    Toute anomalie concernant la livraison devra être signalée par l'Acheteur sur le récépissé que lui présentera le transporteur au moment de la remise du colis. Dans ce cas, pour que le retour puisse être accepté, l’Acheteur devra en informer la Société dans un délai de 2 jours après la livraison du colis, par e-mail adressé à contact@digiparf.com ou par téléphone.

    Il en est de même pour une anomalie concernant un article défectueux, l’Acheteur devra en informer la Société dans un délai de 2 jours suite à la réception de la commande, par e-mail adressé à  contact@digiparf.com ou par téléphone au 01.85.36.00.78.

    Toute réclamation formulée après ce délai sera rejetée et la Société sera dégagée de toute responsabilité.

    Pour tout article signalé défectueux, la procédure sera à effectuer directement auprès du fabricant du produit qui prendra sa responsabilité pour procéder à un échange de marchandise après analyse si celle-ci est confirmée défectueuse par ce dernier, la Société ne pourra être inquiété à ce sujet et n'aura aucune obligation de remboursement auprès de l'acheteur.

    Article 8. Garanties légales

    8.1. Garantie des vices cachés

    La Société est tenue des vices cachés du ou des Produit(s) dans les conditions prévues aux articles 1641 et suivants du Code civil. Sous réserve de la présentation d’une preuve d’achat, l’Acheteur pourra faire
    valoir la garantie des vices cachés dans un délai de 2 ans.

    L’Acheteur devra apporter la preuve que le vice était non apparent, existait lors de l’achat et rend le produit impropre à l’usage auquel il est destiné, ou diminue très fortement cet usage.

    Sous réserve de l’apport de cette preuve, l’Acheteur pourra choisir entre la résolution de la vente ou une réduction du prix de vente, conformément à l’article 1644 du Code civil.

    8.2 Garantie légale de conformité

    Sous réserve de la présentation d’une preuve d’achat, l’Acheteur dispose d’un délai de 2 ans à compter de la délivrance du Produit pour faire valoir la garantie légale de conformité.

    Pour les 24 premiers mois suivant la délivrance du Produit, l’Acheteur est dispensé de rapporter la preuve de l’existence du défaut de conformité, l’apport de la preuve pesant sur la Société.

    En cas de défaut de conformité, l’Acheteur aura le choix entre la réparation et le remplacement du Produit.

    Si aucune des solutions envisagées ne peut être mise en œuvre dans le mois suivant la réclamation, l’Acheteur a la possibilité de demander une diminution du prix ou un remboursement.

    Dans le cas où le défaut de conformité serait mineur, l’Acheteur ne pourra bénéficier du remboursement sur photographie du produit et retour du produit défectueux.
    `;
  } catch (error) {
    handleError('getReturnPolicy', error);
  }
}

async function getContactInformation() {
  try {
    return ` email: contact@digiparf.com `;
  } catch (error) {
    handleError('getContactInformation', error);
  }
}

async function getStoreHours() {
  try {
    return `Pas de boutique physique mais le site est disponible 24h/24 7j/7`;
  } catch (error) {
    handleError('getStoreHours', error);
  }
}

async function get_store_information() {
  try {
    return `DIGIPARF est le partenaire de confiance des CSE, associations et collectivités, dépositaire agréé des plus grandes marques de parfumerie, de maquillage et de cosmétiques.

    Nos équipes mettent depuis toujours un point d’honneur à vous accueillir au 01 85 36 00 78 du lundi au vendredi de 9h à 18h ou par mail contact@digiparf.comavec la même rigueur et le même professionnalisme que dans les points de vente physiques vous faisant ainsi bénéficier de leurs expériences, conseils et suivis personnalisés. 

    Retrouvez sur notre site www.digiparf.com, les toutes dernières nouveautés, les bons plans DIGIPARF et surtout, les plus grandes marques ! Dior, Guerlain, Hermès, Yves Saint Laurent, Paco Rabanne, Jean-Paul Gaultier, Lancôme… Les parfums best-sellers comme Angel, La Vie est belle, La Petite Robe Noire, Black Opium, 1 Million, Sauvage, La Nuit de l’Homme, Wanted.

    Toutes vos marques préférées sont sur www.digiparf.comà prix compétitif !

    Également, l’espace maquillage et soins à travers les plus grandes gammes de cosmétiques. Clarins, Revlon ou encore Pupa sauront vous satisfaire ! Que ce soit pour un fond de teint, un eyeliner, un crayon, un mascara ou encore un anticernes, nous vous proposons là aussi les marques les plus réputées en parfumerie. Sans oublier notre gamme accessoires !

    Et pour finir, une fois votre choix fait, il ne vous restera plus qu’à commander en quelques clics sur notre site www.digiparf.com ou de nous retourner votre bon de commande à contact@digiparf.com et nous prendrons le relais pour vous faire parvenir votre commande dans le délai de 24/48h sans frais de livraison !

    N’attendez plus et bénéficiez dès maintenant des meilleurs produits au plus juste prix.`;
  } catch (error) {
    handleError('get_store_information', error);
  }
}

async function get_store_locations() {
  try {
    return `On a juste une boutique en ligne`;
  } catch (error) {
    handleError('get_store_locations', error);
  }
}

async function get_terms() {
  try {
    return `Préambule
    La Société Cosma Parfumeries, (ci après dénommée "la Société"), Société Anonyme au capital de 1 216 600 euros ayant pour siège social 17 Route des Boulangers 78530 BUC/ FRANCE, inscrite au Registre du Commerce et des Sociétés de Versailles sous le numéro 384 736 666.

    La Société met en place une activité de vente au détail, et ce notamment par l’intermédiaire d’un site Web relié au réseau Internet, adresse électronique https://www.digiparf.com (ci-après dénommé le "Site").

    Le Site permet à la Société de proposer à la vente, des produits cosmétiques, du maquillage, des accessoires et des parfums (ci-après dénommés les "Produits") à des internautes (ci après dénommés "Utilisateurs") naviguant sur le Site. Le Site met à la disposition des Utilisateurs des informations sur les Produits fabriqués par différents fabricants référencés en ligne dans le catalogue, ainsi qu’un système de commandes et de paiement en ligne, sous réserve du respect par l’Utilisateur des présentes conditions générales.

    Toute consultation du site ou commande passée par l’intermédiaire du Site suppose la consultation et l’acceptation expresse des présentes conditions générales de vente.

    Compte tenu des évolutions possibles du Site, la Société se réserve la possibilité d'adapter ou de modifier à tout moment les présentes conditions générales de vente. La nouvelle version sera, le cas échéant, portée à la connaissance des Utilisateurs par modification en ligne et sera applicable aux seules ventes réalisées postérieurement à la modification.

    Article 1 : Objet

    Les conditions générales de vente ont pour objet de définir, exclusivement à raison des relations qu’elles établissent sur le réseau Internet et uniquement sur le Site, les droits et obligations de la Société et de l’Utilisateur nés de la vente en ligne des Produits proposés sur le Site. Ces conditions générales s’appliquent à l’exclusion de tout autre document.

    Article 2 : Produits commercialisés

    www.digiparf.com est un site de vente en ligne de parfums, de produits cosmétiques, de maquillage et d’accessoires. La Société s’approvisionne en Produits auprès des fabricants ayant acceptés expressément d’être référencés sur le Site. La Société se réserve expressément le droit à tout moment d’ajouter de nouveaux Produits, de supprimer tout ou partie des Produits vendus ou présentés sur le Site, de changer leur présentation ou cesser leur commercialisation sur son Site, et cela, sans qu’elle soit contrainte d’en aviser au préalable l’Utilisateur.

    Article 3 : Informations accessibles

    Les caractéristiques essentielles des Produits obtenues directement des fabricants sont décrites dans les Fiches Produits. Cependant les informations caractérisant les Produits présentés peuvent être incomplètes ou ne pas correspondre aux attentes de l’Utilisateur. La Société ne saurait être tenue pour responsable d’éventuelles erreurs qui se seraient glissées dans le descriptif des Produits. Par ailleurs, la Société ne pourra être tenue responsable des erreurs typographiques. De même, les photographies et graphismes illustrant les Produits n’ont aucun engagement contractuel. Ils ne sont qu’indicatifs et ne peuvent en aucun cas engager la responsabilité de la Société.

    Article 4 : Commandes

    4.1. Navigation

    L’Utilisateur peut naviguer librement sur les différentes pages du Site, sans pour autant être engagé au titre d’une commande.

    4.2. Enregistrement d’une commande

    Si l'Utilisateur veut passer une commande, il sélectionnera les différents Produits auxquels il porte un intérêt en cliquant sur l'icône dans la colonne "Ajouter". La quantité des références commandées par l'Utilisateur est automatiquement limitée suivant les recommandations émises à cet égard par les fabricants. Un service d’emballage des produits peut, en outre, à ce stade, être proposé par la Société à l’Utilisateur. La commande fera l'objet d'un récapitulatif appelé "mon panier" et consultable à tout moment, reprenant tous les éléments de celle-ci et qui indiquera le montant global. L'Utilisateur pourra, revenir sur cette commande, la compléter, modifier les quantités ou l'annuler tant qu'elle n'aura pas été validée. Si la liste qui lui est présentée correspond bien aux Produits qu'il a choisis, l'Utilisateur validera le récapitulatif en cliquant sur le bouton "Valider la commande". L'Utilisateur devra alors s'identifier, soit en saisissant son adresse e-mail ainsi que son mot de passe, s'il a déjà effectué des achats sur le Site, soit en créant un compte client en remplissant avec exactitude le formulaire mis à sa disposition, sur lequel il fera figurer les informations nécessaires à son identification complète. L’Utilisateur s’engage à ce que les informations communiquées à la Société soient complètes, exactes et à jour. En cas d’informations incomplètes ou inexactes, la Société se réserve le droit d’annuler purement et simplement la commande ainsi que le paiement. Une fois identifié, un bon de commande apparaîtra à l'écran, récapitulant : les natures, quantité et prix des Produits retenus par l'Utilisateur, l'adresse de facturation et de livraison des Produits.

    4.3. Validation de la commande

    Après avoir pris connaissance de l’état de sa commande, et une fois que l’ensemble des informations demandées aura été complété par l’Utilisateur, ce dernier précisera ensuite le moyen de paiement qu’il souhaite utiliser pour régler sa commande : chèque, virement ou carte bancaire. Dès que l’Utilisateur valide sa commande, celle-ci devient irrévocable. L’Utilisateur devient alors Acheteur. Les systèmes d’enregistrement automatiques de la Société sont considérés comme valant preuve du contenu de la commande et de sa date.

    4.4. Confirmation de la commande

    Lorsque l’Acheteur aura validé sa commande, un récapitulatif s’affichera et mentionnera notamment le numéro de la transaction. Dans un délai de 24 heures après l’enregistrement de la commande, l’Acheteur recevra par e-mail un accusé de réception ; si ce document n’était pas reçu dans les délais indiqués, il appartient à l’Acheteur de contacter la Société car il est possible que sa commande n’ait pu être enregistrée pour des raisons techniques. Si l’accusé de réception de la commande ne peut être distribué à l’adresse e-mail indiquée, la commande sera annulée. La commande ne sera considérée comme ferme et définitive qu’après confirmation par e-mail de la Société.

    4.5. Modifications de commandes

    Toute éventuelle modification de la commande demandée par l’Acheteur ne peut être prise en considération que si elle est parvenue à la Société par courrier électronique et qu’elle a pu être traitée par cette dernière avant l’expédition des Produits (un e-mail de confirmation de la Société sera alors adressé à l’Acheteur).

    Article 5 : Indisponibilité des produits

    Les Produits sont proposés dans la limite des stocks disponibles. En cas d’indisponibilité de l’un des Produits après passation de la commande de l’Acheteur, la Société l’informera de la nouvelle disponibilité des Produits, et procédera sauf instruction contraire et immédiate de l’Acheteur à l’éventuelle livraison partielle de la commande. De manière générale, les commandes ne sont pas annulables en cas de rupture de stock.

    Article 6 : Prix - Paiement

    6.1. Prix

    Les prix des Produits sont indiqués en Euros et sont applicables dans le cadre d’une vente par Internet. Ils tiennent compte de la T.V.A. applicable au pays de destination au jour de la commande.

    Ils comprennent les rabais et ristournes que la Société serait amenée à octroyer.

    Aucun escompte ne sera consenti en cas de paiement anticipé.

    L’Acheteur prendra en outre en charge les frais bancaires (y compris en cas de remboursement) .

    Les prix indiqués sur le Site sont indicatifs et sont remis à jour régulièrement et donc modifiables sans préavis. Toutefois, les prix facturés sont ceux en vigueur à la date de la commande. L’Acheteur pourra également bénéficier, pendant certaines périodes déterminées, d’offres promotionnelles sur certains Produits. Ces offres seront annoncées en ligne sur le Site et seront valables pendant la période indiquée et toujours dans la limite des stocks disponibles.

    6.2. Paiements

    Le règlement des Produits est effectué par une personne habilitée soit :

            Par carte bancaire (Carte Bancaire – Visa – Eurocard/Mastercard ou American Express).
    Les solutions de paiement retenues par la Société sont parmi les plus sécurisées du marché. Elles assurent aux Acheteurs la sécurité ainsi que la confidentialité de toutes les données personnelles qui sont récoltés lors des paiements. Les pages de paiement utilisent, en effet, le protocole TLS (cryptage de toutes informations liées à la carte) et sont soumises à de nombreux agréments (certification PCI DSS, agrément CB Cartes Bancaires, agrément Visa merchant agent...).

    A ce titre et à aucun moment, les données confidentielles de paiement des Acheteurs ne sont stockées ni même accessibles par la Société. Les données précitées sont, en effet, accessibles uniquement au partenaire bancaire de la Société.

            Par Virement Bancaire. 
    L’Acheteur doit effectuer le virement correspondant au montant de sa commande vers le compte bancaire de la Société, dont les coordonnées sont les suivantes : IBAN : FR76 3000 3036 1600 0200 0787 213 - BIC-ADRESSE SWIFT : SOGEFRPP.

    Le règlement devra être reçu par la Société dans un délai maximum de 15 jours suivant la réception du ou des Produits.

            Par chèque bancaire ou postal.
    L’Acheteur doit adresser son chèque correspondant au montant de sa commande à la Société, libellé à l’ordre de DIGIPARF, aux coordonnées suivantes DIGIPARF, 17 Route des Boulangers, 78 530 BUC. Le règlement devra être reçu par la Société dans un délai maximum de 15 jours suivant la date de facture.

    Dans le cadre de la lutte contre les fraudes sur Internet, les informations relatives aux commandes des Acheteurs pourront être transmises à tout tiers pour vérification.

    La Société se réserve le droit de demander une photocopie d’une pièce d’identité du titulaire de la carte bancaire utilisée.

    6.3. Retard de Paiement

    En cas de défaut de paiement total ou partiel du ou des Produits livrées à l'échéance, l'Acheteur devra alors verser à la Société une pénalité de retard égale à trois fois le taux de l'intérêt légal (le taux de l'intérêt légal retenu est celui en vigueur au jour de la livraison des marchandises)

    Cette pénalité sera alors calculée sur le montant TTC de la somme restant due, et courra à compter de la date d'échéance du prix sans qu'aucune mise en demeure préalable ne soit nécessaire.

    En sus des indemnités de retard, toute somme, y compris l’acompte, non payée à sa date d’exigibilité produira de plein droit le paiement d’une indemnité forfaitaire de 40 euros due au titre des frais de recouvrement (Articles 441-10 et D. 441-5 du code de commerce.)

    6.4. Clause Résolutoire

    Si dans les sept jours qui suivent la mise en œuvre de la clause 6.3 "Retard de paiement", l'Acheteur ne s'est pas acquitté des sommes restant dues, la vente sera résolue de plein droit.

    Dans une telle hypothèse, l’Acheteur sera lors tenu concomitamment :

            de restituer immédiatement, à ses frais le ou les Produits concernés au siège social de la Société.
            de payer à la Société des dommages et intérêts équivalant à 25 % du montant de vente résolue.
    6.3. Clause de Réserve de Propriété

    Le ou les Produits resteront la propriété exclusive de la Société jusqu’à leur paiement intégral.

    Le droit de suite de la Société s’appliquera également, le cas échéant, au prix ou à la partie du prix de revente de ce ou de ces Produits, ainsi qu’à l’indemnité d’assurance qui lui ou leur serait subrogée. L’Acheteur prendra toutes les mesures nécessaires pour en informer toute personne susceptible d’être concernée directement ou indirectement par la présente clause de réserve de propriété.

    Article 7 : Livraison

    7.1. Conditions de livraison

    On entend par livraison l’ensemble des moyens mis en œuvre pour livrer au destinataire de la commande (ci-après dénommé «Destinataire») les Produits commandés par l’Acheteur qui seront livrés à l’adresse de livraison qu’il aura indiquée lors de sa commande (« Adresse de livraison »).

    Les livraisons sont possibles en France métropolitaine, Corse, Monaco, Belgique.

    Les livraisons ne pourront pas être réalisées les dimanches et les jours fériés.

    La livraison interviendra dans les délais indiqués sur l’email de confirmation de commande que la Société aura adressé à l’Acheteur sauf évènement indépendant de la volonté de la Société.

    Tout dépassement éventuel ne pourra donner lieu à l’octroi de dommages intérêts par la Société à l’Acheteur.

    En cas de retard de livraison par rapport à la date initialement fixée, l'Acheteur devra le signaler par e-mail adressé à contact@digiparf.com ou par téléphone au 01.85.36.00.78 (dans un délai maximum de deux jours) afin de permettre à la Société de procéder à une enquête auprès du transporteur.

    Livraison à l’entreprise 

    Le colis sera remis contre signature au destinataire.

    Ce récépissé signé vaut preuve de la livraison par la Société et de la réception des Produits
    commandés par l’Acheteur.

    En cas d’absence du destinataire lors de la livraison de la commande, il pourra la récupérer durant les 15 prochains jours à l’adresse indiquée sur l’avis de passage.

    Passé ce délai, la commande sera renvoyée automatiquement à la Société qui reprendra contact avec l’Acheteur pour définir les conditions d’expédition. Les frais de traitement et de livraison seront alors facturés à l’Acheteur.

    7.2. Réception des produits

    Concernant la réception du colis, si le carton d'expédition apparaît visiblement endommagé (colis enfoncé, troué, déchiré, mouillé, découpé au cutter, reconditionné avec un adhésif différent ou si l'une des deux étiquettes située sur l'une des deux face refermable du colis est découpée au niveau de l'ouverture) la réception du colis doit être refusée par le destinataire pour procéder à un retour à la Société ou à défaut des réserves doivent être émises par le destinataire sur le bordereau de réception du transporteur. A défaut, la Société ne pourra procéder à aucun dédommagement de marchandise quand bien même les Produits seraient endommagés, inutilisables ou manquants.

    Lors de la réception du ou des Produit(s), il appartient à l'Acheteur de vérifier sans délai leur conformité et leur intégrité et cela avant de procéder à leur ouverture (ouverture du cellophane de protection).

    Toute anomalie concernant la livraison devra être signalée par l'Acheteur sur le récépissé que lui présentera le transporteur au moment de la remise du colis. Dans ce cas, pour que le retour puisse être accepté, l’Acheteur devra en informer la Société dans un délai de 2 jours après la livraison du colis, par e-mail adressé à contact@digiparf.com ou par téléphone.

    Il en est de même pour une anomalie concernant un article défectueux, l’Acheteur devra en informer la Société dans un délai de 2 jours suite à la réception de la commande, par e-mail adressé à  contact@digiparf.com ou par téléphone au 01.85.36.00.78.

    Toute réclamation formulée après ce délai sera rejetée et la Société sera dégagée de toute responsabilité.

    Pour tout article signalé défectueux, la procédure sera à effectuer directement auprès du fabricant du produit qui prendra sa responsabilité pour procéder à un échange de marchandise après analyse si celle-ci est confirmée défectueuse par ce dernier, la Société ne pourra être inquiété à ce sujet et n'aura aucune obligation de remboursement auprès de l'acheteur.

    Article 8. Garanties légales

    8.1. Garantie des vices cachés

    La Société est tenue des vices cachés du ou des Produit(s) dans les conditions prévues aux articles 1641 et suivants du Code civil. Sous réserve de la présentation d’une preuve d’achat, l’Acheteur pourra faire
    valoir la garantie des vices cachés dans un délai de 2 ans.

    L’Acheteur devra apporter la preuve que le vice était non apparent, existait lors de l’achat et rend le produit impropre à l’usage auquel il est destiné, ou diminue très fortement cet usage.

    Sous réserve de l’apport de cette preuve, l’Acheteur pourra choisir entre la résolution de la vente ou une réduction du prix de vente, conformément à l’article 1644 du Code civil.

    8.2 Garantie légale de conformité

    Sous réserve de la présentation d’une preuve d’achat, l’Acheteur dispose d’un délai de 2 ans à compter de la délivrance du Produit pour faire valoir la garantie légale de conformité.

    Pour les 24 premiers mois suivant la délivrance du Produit, l’Acheteur est dispensé de rapporter la preuve de l’existence du défaut de conformité, l’apport de la preuve pesant sur la Société.

    En cas de défaut de conformité, l’Acheteur aura le choix entre la réparation et le remplacement du Produit.

    Si aucune des solutions envisagées ne peut être mise en œuvre dans le mois suivant la réclamation, l’Acheteur a la possibilité de demander une diminution du prix ou un remboursement.

    Dans le cas où le défaut de conformité serait mineur, l’Acheteur ne pourra bénéficier du remboursement sur photographie du produit et retour du produit défectueux.


    Article 9. Droit de propriété intellectuelle

    En accord avec les lois régissant la propriété industrielle des droits littéraires et artistiques ou autres droits similaires, le présent site et l’ensemble des éléments (images, dessins, sources scripts, logos …) constituant le Site sont la propriété exclusive de la Société ou de ses fournisseurs, ces derniers ne concédant aucune licence, ni aucun droit que celui de consulter le site.

    L’Utilisateur s’interdit en conséquence de diffuser ou de reproduire le Site, en tout ou en partie, sous quelque forme que ce soit. La Société est, quant à elle, propriétaire de la marque "DIGIPARF" ainsi que du nom de domaine « digiparf.com ». Toute reproduction, distribution, transmission, modification ou utilisation de la marque ou du nom de domaine précité pour quelque motif que ce soit, est interdit.

    Toute autre utilisation est constitutive de contrefaçon et sanctionnée au titre de la propriété intellectuelle, sauf autorisation préalable et écrite de la Société.

    Article 10. Données Personnelles

    La Politique Générale de Protection des Données Personnelles de la Société est disponible sur  le présent Site et les Acheteurs sont invités à en prendre connaissance.

    Les données personnelles de l’Acheteur collectées et conservées par la Société dans le cadre de sa commande ont pour but la bonne gestion de ses commandes, livraisons et factures.
    La Société se réserve la possibilité d'utiliser à des fins commerciales les données transmises par l’Acheteur si celui-ci l'accepte lors de l'inscription sur le Site.

    Dans le cas contraire, l’Acheteur y renonce.

    Article 11. Limite de Responsabilité

    La responsabilité de la Société ne peut être engagée lorsque l’Acheteur ne respecte pas, en tout ou partie, les présentes conditions générales de vente, ou en cas de fait imprévisible d’un tiers ou en cas de Force majeure tel que défini par les juridictions françaises.

    La Société décline toute responsabilité quant aux dommages directs et/ou indirects, qu'ils soient prévisibles ou non, causé a l'occasion de l'utilisation de son site Internet.

    Article 12. Loi applicable et juridiction compétente

    12.1. Nullité – Divisibilité

    Au cas où l'une quelconque des présentes conditions générales de ventes serait reconnue ou déclarée nulle ou en violation d'une disposition d'ordre public, ladite conditions sera réputée non écrite et toutes les autres conditions resteront en vigueur.

    12.2. Cadre - Loi applicable

    La langue du présent contrat est la langue française.

    Les présentes conditions Générales de Ventes sont soumises à la loi française. Tout litige relatif à l'existence, l'interprétation, l'exécution ou la rupture du contrat conclu entre la Société et l’Acheteur, même en cas de pluralité de défendeurs, sera, a défaut d'accord amiable, de la compétence exclusive des tribunaux français compétents en application des règles édictées par le code de procédure civile français.

    Par dérogation, et pour les commandes livrées hors du territoire nationale Français, les
    Commandes sont soumises au droit français sous réserve des dispositions impératives nationales qui viendraient en remplacement des règles françaises en cas de contradiction.`;
  } catch (error) {
    handleError('get_terms', error);
  }
}

async function get_privacy_policy() {
  try {
    return `Article 10. Données Personnelles
    La Politique Générale de Protection des Données Personnelles de la Société est disponible sur  le présent Site et les Acheteurs sont invités à en prendre connaissance.

    Les données personnelles de l’Acheteur collectées et conservées par la Société dans le cadre de sa commande ont pour but la bonne gestion de ses commandes, livraisons et factures.
    La Société se réserve la possibilité d'utiliser à des fins commerciales les données transmises par l’Acheteur si celui-ci l'accepte lors de l'inscription sur le Site.

    Dans le cas contraire, l’Acheteur y renonce.

    Article 11. Limite de Responsabilité

    La responsabilité de la Société ne peut être engagée lorsque l’Acheteur ne respecte pas, en tout ou partie, les présentes conditions générales de vente, ou en cas de fait imprévisible d’un tiers ou en cas de Force majeure tel que défini par les juridictions françaises.

    La Société décline toute responsabilité quant aux dommages directs et/ou indirects, qu'ils soient prévisibles ou non, causé a l'occasion de l'utilisation de son site Internet.`;
  } catch (error) {
    handleError('get_privacy_policy', error);
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
  getStoreHours,
  get_store_information,
  get_store_locations,
  get_terms,
  get_privacy_policy,
};