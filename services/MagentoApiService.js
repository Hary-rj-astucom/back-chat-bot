require('dotenv').config();
const axios = require('axios');
const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

// ============================================================
// Initialisation du lien Magento
// ============================================================
const magento = axios.create({
  baseURL: `${process.env.MAGENTO_URL}/rest/V1`,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.MAGENTO_ACCESS_TOKEN}` // Token admin ou integration
  }
});

// ============================================================
// Helpers génériques
// ============================================================

/**
 * Construit une query string searchCriteria à partir de groupes de filtres.
 * filterGroups = [ [ {field, value, condition_type}, ... ], ... ]
 * Chaque sous-tableau = un groupe (OR entre filtres du même groupe,
 * AND entre les groupes).
 */
function buildSearchCriteria(filterGroups = [], options = {}) {
  const params = new URLSearchParams();

  filterGroups.forEach((group, gIdx) => {
    group.forEach((filter, fIdx) => {
      params.append(`searchCriteria[filter_groups][${gIdx}][filters][${fIdx}][field]`, filter.field);
      params.append(`searchCriteria[filter_groups][${gIdx}][filters][${fIdx}][value]`, filter.value);
      params.append(`searchCriteria[filter_groups][${gIdx}][filters][${fIdx}][condition_type]`, filter.condition_type || 'eq');
    });
  });

  if (options.pageSize) params.append('searchCriteria[pageSize]', options.pageSize);
  if (options.currentPage) params.append('searchCriteria[currentPage]', options.currentPage);
  if (options.sortField) {
    params.append('searchCriteria[sortOrders][0][field]', options.sortField);
    params.append('searchCriteria[sortOrders][0][direction]', options.sortDirection || 'DESC');
  }
  // Si aucun filtre n'est fourni, Magento exige quand même searchCriteria[filter_groups] présent au moins vide
  if (filterGroups.length === 0 && !params.has('searchCriteria[pageSize]')) {
    params.append('searchCriteria[pageSize]', options.pageSize || 20);
  }

  return params.toString();
}

/**
 * Garde-fou serveur pour toutes les requêtes de type "liste".
 * On NE FAIT JAMAIS confiance aveuglément aux options transmises par
 * le modèle IA : pageSize est systématiquement borné, et un tri par
 * défaut (le plus récent en premier) est appliqué si rien n'est précisé.
 *
 * - pageSize : borné entre 1 et MAX_PAGE_SIZE (défaut DEFAULT_PAGE_SIZE)
 * - sortField / sortDirection : valeurs par défaut si absentes
 */
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 10;

function normalizeListOptions(options = {}, defaults = {}) {
  const requestedSize = parseInt(options.pageSize, 10);
  const pageSize = Number.isFinite(requestedSize)
    ? Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE)
    : (defaults.pageSize || DEFAULT_PAGE_SIZE);

  const currentPage = Number.isFinite(parseInt(options.currentPage, 10))
    ? Math.max(parseInt(options.currentPage, 10), 1)
    : 1;

  return {
    pageSize,
    currentPage,
    sortField: options.sortField || defaults.sortField || 'created_at',
    sortDirection: (options.sortDirection === 'ASC' ? 'ASC' : 'DESC')
  };
}

/**
 * Retire les accents/diacritiques d'une chaîne ("Hermès" -> "Hermes").
 * Utilisé pour construire des filtres tolérants aux accents, car selon
 * la collation MySQL utilisée par l'instance Magento, une recherche
 * LIKE peut être sensible aux accents (ce qui donne 0 résultat pour
 * "Hermes" alors que le produit s'appelle "Hermès").
 */
function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Construit des filter_groups "mots-clés" à partir d'une requête libre.
 * Principe : on découpe la requête en mots significatifs (on ignore la
 * ponctuation et les mots vides comme "de", "le", "pour"...), et pour
 * CHAQUE mot on exige qu'il soit trouvé dans AU MOINS un des champs
 * fournis (`fields`), avec ou sans accents.
 *
 * -> Un groupe par mot (OR entre les variantes/champs du mot),
 *    les groupes étant AND-és entre eux par Magento : tous les mots
 *    doivent être trouvés quelque part, mais pas forcément au même
 *    endroit ni dans le même ordre. Ça couvre aussi bien une recherche
 *    par marque seule ("Hermès") qu'un nom de produit complet
 *    ("Terre d'Hermès").
 */
const SEARCH_STOP_WORDS = new Set([
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'pour', 'avec', 'a', 'au'
]);
const MAX_SEARCH_WORDS = 4;

function buildKeywordFilterGroups(query, fields) {
  const cleaned = String(query || '').replace(/[?!.,;:()"']/g, ' ');
  const rawWords = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !SEARCH_STOP_WORDS.has(w.toLowerCase()));

  const words = (rawWords.length > 0 ? rawWords : [cleaned.trim()])
    .filter(Boolean)
    .slice(0, MAX_SEARCH_WORDS);

  return words.map((word) => {
    const variants = new Set([word, stripDiacritics(word)]);
    const filters = [];
    variants.forEach((variant) => {
      fields.forEach((field) => {
        filters.push({ field, value: `%${variant}%`, condition_type: 'like' });
      });
    });
    return filters;
  });
}

function handleError(context, error) {
  console.error(`Erreur_Magento [${context}]:`, error.response?.data || error.message);
  throw error;
}

// ============================================================
// COMMANDES (Orders)
// ============================================================

// Récupérer une commande par son ID interne (entity_id)
async function get_order(orderId) {
  try {
    const { data } = await magento.get(`/orders/${orderId}`);
    return data;
  } catch (error) {
    handleError('get_order', error);
  }
}

// Récupérer une commande par son numéro visible (increment_id)
async function get_order_by_increment_id(orderNumber, email_client) {
  try {
    const query = buildSearchCriteria([
      [{ field: 'increment_id', value: orderNumber, condition_type: 'eq' }]
    ]);
    const { data } = await magento.get(`/orders?${query}`);
    if (!data.items || data.items.length === 0) {
      throw new Error(`Commande ${orderNumber} introuvable`);
    }

    //verication de l'appartenance de l'email
    if(data.items[0].customer_email == email_client){
      return data.items[0];
    }else{
      return null;
    }
    
  } catch (error) {
    handleError('get_order_by_increment_id', error);
  }
}

// Dernières commandes d'un client via son email
// (limit conservé pour compat, mais borné via normalizeListOptions)
async function get_last_orders_by_email(email, limit = DEFAULT_PAGE_SIZE) {
  try {
    const { pageSize, sortField, sortDirection } = normalizeListOptions({ pageSize: limit });
    const query = buildSearchCriteria(
      [[{ field: 'customer_email', value: email, condition_type: 'eq' }]],
      { pageSize, sortField, sortDirection }
    );
    const { data } = await magento.get(`/orders?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_last_orders_by_email', error);
  }
}

// Toutes les commandes d'un client via son customer_id
// -> pagination et tri désormais TOUJOURS appliqués (5 par défaut, 10 max)
async function get_customer_orders(customerId, options = {}) {
  try {
    const normalized = normalizeListOptions(options);
    const query = buildSearchCriteria(
      [[{ field: 'customer_id', value: customerId, condition_type: 'eq' }]],
      normalized
    );
    const { data } = await magento.get(`/orders?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_customer_orders', error);
  }
}

// Recherche générique de commandes (usage interne / admin uniquement,
// NE PAS exposer directement au modèle IA : filterGroups arbitraires =
// risque d'accès à des données hors périmètre du client courant.
// Côté tools, on passe par des wrappers dédiés type search_orders_by_status)
async function search_orders(filterGroups = [], options = {}) {
  try {
    const normalized = normalizeListOptions(options);
    const query = buildSearchCriteria(filterGroups, normalized);
    const { data } = await magento.get(`/orders?${query}`);
    return data;
  } catch (error) {
    handleError('search_orders', error);
  }
}

// Statut d'une commande
async function get_order_status(orderId) {
  try {
    const order = await get_order(orderId);
    return { status: order.status, state: order.state };
  } catch (error) {
    handleError('get_order_status', error);
  }
}

// Articles d'une commande
async function get_order_items(orderId) {
  try {
    const order = await get_order(orderId);
    return order.items || [];
  } catch (error) {
    handleError('get_order_items', error);
  }
}

// Totaux d'une commande
async function get_order_total(orderId) {
  try {
    const order = await get_order(orderId);
    return {
      grand_total: order.grand_total,
      subtotal: order.subtotal,
      shipping_amount: order.shipping_amount,
      tax_amount: order.tax_amount,
      discount_amount: order.discount_amount,
      total_paid: order.total_paid,
      total_due: order.total_due,
      currency: order.order_currency_code
    };
  } catch (error) {
    handleError('get_order_total', error);
  }
}

// ============================================================
// LIVRAISON / EXPÉDITION (Shipments)
// ============================================================

async function get_tracking(orderId) {
  try {
    const query = buildSearchCriteria([[{ field: 'order_id', value: orderId, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/shipments?${query}`);
    const shipments = data.items || [];
    const tracks = shipments.flatMap(s => s.tracks || []);
    return { shipments, tracks };
  } catch (error) {
    handleError('get_tracking', error);
  }
}

async function get_shipping_method(orderId) {
  try {
    const order = await get_order(orderId);
    return {
      method: order.extension_attributes?.shipping_assignments?.[0]?.shipping?.method || null,
      description: order.shipping_description || null
    };
  } catch (error) {
    handleError('get_shipping_method', error);
  }
}

async function get_shipping_cost(orderId) {
  try {
    const order = await get_order(orderId);
    return {
      shipping_amount: order.shipping_amount,
      shipping_incl_tax: order.shipping_incl_tax,
      shipping_tax_amount: order.shipping_tax_amount
    };
  } catch (error) {
    handleError('get_shipping_cost', error);
  }
}

// ============================================================
// PAIEMENT (Payment)
// ============================================================

async function get_payment_method(orderId) {
  try {
    const order = await get_order(orderId);
    return order.payment ? {
      method: order.payment.method,
      amount_ordered: order.payment.amount_ordered,
      amount_paid: order.payment.amount_paid
    } : null;
  } catch (error) {
    handleError('get_payment_method', error);
  }
}

// ============================================================
// FACTURES / AVOIRS (Invoices / Credit memos)
// ============================================================

async function get_invoice(orderId) {
  try {
    const query = buildSearchCriteria([[{ field: 'order_id', value: orderId, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/invoices?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_invoice', error);
  }
}

async function get_credit_memo(orderId) {
  try {
    const query = buildSearchCriteria([[{ field: 'order_id', value: orderId, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/creditmemos?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_credit_memo', error);
  }
}

// ============================================================
// PRODUITS (Products)
// ============================================================

// Recherche de produits par mot-clé.
// -> Cherche chaque mot significatif de la requête dans "name", "sku",
//    "description" et "short_description", avec et sans accents, et
//    exige que TOUS les mots soient trouvés (potentiellement dans des
//    champs différents). Corrige les cas où une recherche par marque
//    seule ("Hermès") ou sans accent ("Hermes") ne remontait rien alors
//    que le nom complet du produit matchait, et couvre aussi les
//    critères qui n'apparaissent que dans la description (ex: "senteur
//    agrume") plutôt que dans le nom.
// ⚠️ Si l'un de ces champs n'est pas filtrable côté Magento sur ton
//    instance (attribut non indexé/non "used in filterable in grid"),
//    tu auras une erreur explicite du type "Unable to filter by this
//    field" — retire-le alors du tableau SEARCH_FIELDS ci-dessous.
// -> pagination et tri désormais TOUJOURS appliqués (5 par défaut, 10 max)
const SEARCH_FIELDS = ['name', 'sku', 'description', 'short_description'];

async function search_products(query, options = {}) {
  try {
    const normalized = normalizeListOptions(options, { sortField: 'name' });
    const filterGroups = buildKeywordFilterGroups(query, SEARCH_FIELDS);
    const qs = buildSearchCriteria(filterGroups, normalized);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('search_products', error);
  }
}

async function get_product(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}`);
    return data;
  } catch (error) {
    handleError('get_product', error);
  }
}

// ------------------------------------------------------------
// OUTIL DE DÉCOUVERTE (usage développeur uniquement, PAS un tool IA) :
// liste tous les attributs produit disponibles avec leur code exact.
// Utile pour trouver le vrai code de "genre", "famille olfactive", etc.
// À exécuter une fois (ex: dans un script ou une route temporaire) :
//   const { list_searchable_attributes } = require('./MagentoApiService');
//   list_searchable_attributes().then(r => console.log(r));
// ------------------------------------------------------------
async function list_searchable_attributes() {
  try {
    const qs = buildSearchCriteria([], { pageSize: 200 });
    const { data } = await magento.get(`/products/attributes?${qs}`);
    return (data.items || []).map((a) => ({
      code: a.attribute_code,
      label: a.default_frontend_label,
      type: a.frontend_input, // 'select', 'multiselect', 'text'...
      options: a.options?.filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.label }))
    }));
  } catch (error) {
    handleError('list_searchable_attributes', error);
  }
}

// ------------------------------------------------------------
// Mapping "genre" -> ID d'option de l'attribut Magento "perfume_for"
// (attribut de type select, découvert via list_searchable_attributes()).
// Le libellé stocké est "Parfum Homme"/"Parfum Femme"/etc, mais Magento
// exige l'ID numérique de l'option pour filtrer, pas le texte.
// ------------------------------------------------------------
const PERFUME_FOR_OPTION_IDS = {
  homme: '862',
  femme: '859',
  mixte: '863',
  enfant: '858',
  fille: '860',
  garcon: '861',
  garçon: '861',
  bebe: '4254',
  bébé: '4254'
};

function resolveGenderOptionId(gender) {
  if (!gender) return null;
  const key = stripDiacritics(String(gender).toLowerCase().trim());
  return PERFUME_FOR_OPTION_IDS[key] || null;
}

// ------------------------------------------------------------
// Recherche PAR ATTRIBUTS structurés (genre, famille olfactive,
// catégorie...), à la différence de search_products qui ne fait que
// du mot-clé dans du texte libre.
//
// criteria = { keyword, gender, scentFamily, categoryId }
// ------------------------------------------------------------
async function search_products_advanced(criteria = {}, options = {}) {
  try {
    const normalized = normalizeListOptions(options, { sortField: 'name' });
    const filterGroups = [];

    if (criteria.keyword) {
      filterGroups.push(...buildKeywordFilterGroups(criteria.keyword, SEARCH_FIELDS));
    }

    if (criteria.gender) {
      const optionId = resolveGenderOptionId(criteria.gender);
      // Si le genre demandé ne correspond à aucune option connue, on
      // ignore silencieusement ce critère plutôt que de renvoyer une
      // erreur Magento ou zéro résultat sur une valeur mal formée.
      if (optionId) {
        filterGroups.push([{ field: 'perfume_for', value: optionId, condition_type: 'eq' }]);
      }
    }

    if (criteria.scentFamily) {
      // olfactive_families est un champ texte libre (pas une liste à
      // choix) -> simple LIKE, avec tolérance accents comme ailleurs.
      const variants = new Set([criteria.scentFamily, stripDiacritics(criteria.scentFamily)]);
      const filters = [];
      variants.forEach((v) => filters.push({ field: 'olfactive_families', value: `%${v}%`, condition_type: 'like' }));
      filterGroups.push(filters);
    }

    if (criteria.categoryId) {
      // Filtrer par catégorie fonctionne nativement sur /V1/products
      // via le champ virtuel "category_id".
      filterGroups.push([{ field: 'category_id', value: criteria.categoryId, condition_type: 'eq' }]);
    }

    const qs = buildSearchCriteria(filterGroups, normalized);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('search_products_advanced', error);
  }
}

async function get_product_by_name(name) {
  try {
    const qs = buildSearchCriteria([[{ field: 'name', value: name, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items?.[0] || null;
  } catch (error) {
    handleError('get_product_by_name', error);
  }
}

async function get_product_price(sku) {
  try {
    const product = await get_product(sku);
    return {
      price: product.price,
      special_price: product.custom_attributes?.find(a => a.attribute_code === 'special_price')?.value || null
    };
  } catch (error) {
    handleError('get_product_price', error);
  }
}

async function get_product_stock(sku) {
  try {
    const { data } = await magento.get(`/stockItems/${encodeURIComponent(sku)}`);
    return data;
  } catch (error) {
    handleError('get_product_stock', error);
  }
}

async function get_product_images(sku) {
  try {
    const product = await get_product(sku);
    return product.media_gallery_entries || [];
  } catch (error) {
    handleError('get_product_images', error);
  }
}

async function get_product_attributes(sku) {
  try {
    const product = await get_product(sku);
    return product.custom_attributes || [];
  } catch (error) {
    handleError('get_product_attributes', error);
  }
}

async function compare_products(sku1, sku2) {
  try {
    const [p1, p2] = await Promise.all([get_product(sku1), get_product(sku2)]);
    return { product_1: p1, product_2: p2 };
  } catch (error) {
    handleError('compare_products', error);
  }
}

async function get_related_products(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}/links/related`);
    return data;
  } catch (error) {
    handleError('get_related_products', error);
  }
}

async function get_cross_sell_products(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}/links/crosssell`);
    return data;
  } catch (error) {
    handleError('get_cross_sell_products', error);
  }
}

async function get_upsell_products(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}/links/upsell`);
    return data;
  } catch (error) {
    handleError('get_upsell_products', error);
  }
}

// ============================================================
// CATÉGORIES
// ============================================================

async function get_categories() {
  try {
    const { data } = await magento.get('/categories');
    return data;
  } catch (error) {
    handleError('get_categories', error);
  }
}

async function get_category(categoryId) {
  try {
    const { data } = await magento.get(`/categories/${categoryId}`);
    return data;
  } catch (error) {
    handleError('get_category', error);
  }
}

async function get_products_by_category(categoryId) {
  try {
    const { data } = await magento.get(`/categories/${categoryId}/products`);
    return data;
  } catch (error) {
    handleError('get_products_by_category', error);
  }
}

// Nouveaux produits -> pagination désormais TOUJOURS bornée
async function get_new_products(limit = DEFAULT_PAGE_SIZE) {
  try {
    const normalized = normalizeListOptions({ pageSize: limit });
    const qs = buildSearchCriteria([], normalized);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('get_new_products', error);
  }
}

// ⚠️ Endpoint custom requis (non standard Magento REST)
async function get_best_sellers(limit = DEFAULT_PAGE_SIZE) {
  try {
    const normalized = normalizeListOptions({ pageSize: limit });
    const { data } = await magento.get(`/products/bestsellers?limit=${normalized.pageSize}`);
    return data;
  } catch (error) {
    handleError('get_best_sellers (endpoint custom requis)', error);
  }
}

async function search_brand(brand, attributeCode = 'manufacturer', options = {}) {
  try {
    const normalized = normalizeListOptions(options, { sortField: 'name' });
    const qs = buildSearchCriteria(
      [[{ field: attributeCode, value: brand, condition_type: 'eq' }]],
      normalized
    );
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('search_brand', error);
  }
}

// ============================================================
// INFORMATIONS BOUTIQUE (Store / CMS)
// ============================================================

async function get_store_information() {
  try {
    const data = `Créée en 1977, Cosma Parfumeries est une parfumerie indépendante dont le magasin historique était situé en région parisienne à Rueil Malmaison (92500).
      Nos équipes mettent depuis toujours un point d'honneur à vous accueillir en ligne avec la même rigueur et le même professionnalisme que dans les points de vente physiques vous faisant ainsi bénéficier de leurs expériences, conseils et suivis personnalisés. 
      Forte du soutien indéfectible de sa clientèle (5 étoiles notamment sur Truspilot) et Dépositaire agréé des plus grandes marques de parfumerie, Cosma Parfumeries accélère désormais son développement en multipliant les ouvertures de boutiques et en diffusant désormais ses produits dans les principaux pays européens.
      Cette croissance nous permettra de continuer à vous offrir les meilleurs produits au plus juste prix.
      
      Retrouvez ainsi dans la rubrique «parfums» du site, les toutes dernières nouveautés, les bons plans Cosma et surtout, les plus grandes marques ! Dior, Guerlain, Hermès, Yves Saint Laurent, Paco Rabanne, Jean-Paul Gaultier, Lancôme… Les parfums best-sellers comme Angel, La Vie est belle, La Petite Robe Noire, Black Opium, 1 Million, Sauvage, La Nuit de l'Homme, Wanted.
      Elles sont toutes là et à prix compétitif !
      Également, l'espace maquillage et soins pourront vous permettre de mettre en valeur votre visage et votre corps à travers les plus grandes gammes de cosmétiques. Clarins, Revlon ou encore Pupa sauront vous satisfaire ! Que ce soit pour un fond de teint, un eyeliner, un crayon, un mascara ou encore un anticernes, nous vous proposons là aussi les marques les plus réputées en parfumerie.
      Et pour finir, une fois votre choix fait, il ne vous restera plus qu'à commander en quelques clics et nous prendrons le relais pour vous faire parvenir votre commande dans les meilleurs délais !
      Pour en savoir plus, suivez-nous sur Facebook, Instagram ! `;
    return data;
  } catch (error) {
    handleError('get_store_information', error);
  }
}

async function get_store_hours() {
  try {
    return `Horaires d'ouverture :
      Mardi au samedi
      10h30-19h00`;
  } catch (error) {
    handleError('get_store_hours', error);
  }
}

async function get_store_locations() {
  try {
    return `Cosma Parfumeries
      1 Avenue Paul Doumer
      92500 Rueil Malmaison

      Tel : 01 47 08 62 37

      Horaires d'ouverture :
      Mardi au samedi
      10h30-19h00


      IMPORTANT : Les prix pratiqués en magasin sont différents des prix sur internet.

      Les offres promotionnelles sur le site sont uniquement Exclu Web.`;
  } catch (error) {
    handleError('get_store_locations', error);
  }
}

async function get_contact_information() {
  try {
    return ` 
      email : contact@cosma-parfumeries.fr `;
  } catch (error) {
    handleError('get_contact_information', error);
  }
}

async function get_terms() {
  try {
    return `Conditions générales d'utilisation
    Préambule
    Cosma Parfumeries (ci-après dénommée "la Société"), société anonyme au capital de 169 000 euros, dont le siège social est situé 17 Route des Boulangers 78530 Buc, France, immatriculée au Registre du Commerce et des Sociétés de Versailles sous le numéro 384 736 666. La Société exerce une activité de vente au détail notamment par l'intermédiaire d'un site web connecté à Internet, https://www.cosma- parfumeries.com (ci-après dénommé le "Site"). Le Site permet à la Société de proposer à la vente des produits cosmétiques et des parfums (ci-après dénommés les "Produits" aux internautes (ci-après dénommés "Utilisateur(s)" ou "Acheteur(s)") qui naviguent sur le Site. Le Site met à la disposition des Utilisateurs des informations sur les Produits fabriqués par différents fabricants figurant en ligne dans le catalogue, ainsi qu'un système de commande et de paiement en ligne, sous réserve du respect par l'Utilisateur des présentes conditions générales.
    Toute commande passée sur le Site implique la consultation et l'acceptation expresse des présentes conditions générales de vente.

    Avant de passer commande, l'Utilisateur déclare que l'achat de produits sur le Site n'est pas directement lié à son activité professionnelle et est limité à un usage strictement personnel.

    Article 1 : Objet
    Les présentes conditions générales ont pour objet de définir les droits et obligations de la Société et de l'Utilisateur nés de l'accès au Site et de la vente en ligne des Produits proposés sur le Site, exclusivement dans le cadre des relations qu'ils établissent sur le réseau Internet et uniquement sur le Site. Ces conditions s'appliquent à l'exclusion de tout autre document. Dès lors qu'une disposition des Conditions Générales serait déclarée nulle et non avenue, les autres dispositions des Conditions Générales resteront en vigueur et de plein effet.

    Article 2 : Produits vendus
    www.cosma-parfumeries.com est un site de vente en ligne de parfums, de cosmétiques et de maquillage. La Société s'approvisionne en Produits auprès de fabricants qui ont expressément accepté d'être référencés sur le Site. La Société se réserve expressément le droit à tout moment d'ajouter de nouveaux Produits, de supprimer tout ou partie des Produits vendus ou présentés sur le Site, de modifier leur présentation ou de cesser leur commercialisation sur son Site, sans être tenue d'en informer préalablement l'Utilisateur.

    Article 3 : Informations accessibles
    Les caractéristiques essentielles des Produits obtenus directement auprès des fabricants sont décrites dans les Fiches Produits. Toutefois, les informations caractérisant les Produits présentés peuvent être incomplètes ou ne pas correspondre aux attentes de l'Utilisateur. L'Entreprise ne saurait être tenue responsable d'éventuelles erreurs dans la description des Produits. En outre, la Société ne peut être tenue responsable des erreurs typographiques. De même, les photographies et graphismes illustrant les Produits ne sont pas contractuels. Ils n'ont qu'une valeur indicative et ne peuvent en aucun cas engager la responsabilité de la Société.

    Article 4 : Commandes
    4.1. Navigation
    L'Utilisateur peut naviguer librement sur les différentes pages du Site, sans être lié par une quelconque commande.
    
    4.2. Passation de commande
    Si l'Utilisateur souhaite passer commande, il sélectionnera les différents Produits qui l'intéressent en cliquant sur l'icône de la colonne " Ajouter ". La quantité de références commandées par l'Utilisateur est automatiquement limitée en fonction des recommandations émises à cet égard par les fabricants. La commande de l'Utilisateur sera récapitulée dans une page intitulée " mon panier ", consultable à tout moment, reprenant tous les éléments de la commande et son montant total. L'Utilisateur peut revenir sur le panier avant que la commande ne soit validée, le compléter, en modifier les quantités ou l'annuler tant qu'il n'a pas été validé. Si la liste présentée correspond aux Produits choisis, l'Utilisateur validera le récapitulatif en cliquant sur le bouton "Valider la commande". L'Utilisateur devra alors s'identifier, soit en saisissant son adresse électronique et son mot de passe, s'il a déjà effectué des achats sur le Site, soit en remplissant avec exactitude le formulaire mis à sa disposition, sur lequel il fera figurer les informations nécessaires à son identification et notamment ses nom, prénom, email, adresse postale et numéro de téléphone au format international. L'Utilisateur s'engage à ce que les informations qu'il fournit à la Société soient complètes, exactes et à jour. En cas d'informations incomplètes ou inexactes, la Société se réserve le droit d'annuler la commande et le paiement. Une fois identifié, un bon de commande apparaîtra à l'écran, récapitulant : la nature, la quantité et le prix des Produits sélectionnés par l'Utilisateur, l'adresse de facturation et de livraison des Produits.
    
    4.3. Validation définitive de la commande
    Après avoir vérifié le contenu de sa commande et complété l'ensemble des informations demandées, l'Utilisateur précisera le mode de paiement qu'il souhaite utiliser pour régler sa commande : virement, carte bancaire, PayPal, Apple Pay, Google Pay, Bancontact, iDeal. Dès que l'Utilisateur confirme son paiement, la commande est enregistrée et devient irrévocable. L'Utilisateur devient alors Acheteur. Les systèmes d'enregistrement automatique de la Société sont considérés comme valant preuve du contenu et de la date de la commande.
    
    4.4 Confirmation de la commande
    Une fois le paiement confirmé, un récapitulatif de la commande de l'Acheteur s'affiche avec le numéro de la transaction. Dans les 24 heures suivant l'enregistrement de la commande, l'Acheteur recevra un courrier électronique accusant réception de la commande. Si ce document n'est pas reçu dans le délai indiqué, il appartient à l'Acheteur de contacter la Société, car il est possible que la commande n'ait pas pu être enregistrée pour des raisons techniques.

    4.5. Modifications de la commande
    Toute modification de la commande demandée par l'Acheteur ne peut être prise en considération que si elle est parvenue à la Société par courrier électronique à contact@cosma-parfumeries.fr avant l'expédition des Produits.

    Article 5 : Indisponibilité des produits
    Les produits sont proposés dans la limite des stocks disponibles. Dans l'éventualité d'une indisponibilité de l'un des Produits après passation de la commande par l'Acheteur, la Société l'en informera et lui proposera le remboursement du Produit ou d'attendre une nouvelle réception fournisseur dudit Produit.

    Dans l'hypothèse d'une commande comprenant plusieurs produits, la Société procédera à une livraison partielle de la commande des produits commandés disponibles sauf avis contraire immédiat de l'Acheteur.
    
    Article 6 : Prix - Paiement
    6.1. Prix
    Les prix des produits sont indiqués en euros ou dans la devise locale du pays de livraison. Ils incluent la TVA du pays de livraison applicable au jour de la commande.

    Les prix indiqués ne comprennent pas les frais de livraison, qui seront facturés en supplément et seront précisés à l'Acheteur lors de la validation de la commande.

    Les prix indiqués sur le Site sont indicatifs et mis à jour régulièrement et donc susceptibles d'être modifiés sans préavis.

    Toutefois, les prix facturés sont ceux en vigueur à la date de la commande. L'Acheteur peut également bénéficier, pendant certaines périodes spécifiques, d'offres promotionnelles sur certains Produits. Ces offres seront annoncées en ligne sur le Site et seront valables dans la limite des stocks disponibles.

    
    6.2. Paiement
    Les commandes sont payables en euros Toutes Taxes Comprises ou dans la devise locale TTC du pays de livraison. Les éventuels frais bancaires liés à l'achat seront à la charge de l'Acheteur.

    Le paiement des Produits s'effectue soit :

    - Par carte de crédit via Revolut, Mollie ou Lyra, qui font partie des solutions de paiement les plus sécurisées du marché.

    Elles garantissent la sécurité et la confidentialité de toutes les données personnelles collectées lors du paiement. Les pages de paiement desdites solutions utilisent le protocole TLS (cryptage de toutes les informations liées à la carte) et font l'objet de nombreux agréments (certification PCI DSS, agrément CB Cartes Bancaires, agrément d'agent commercial Visa, etc.).

    Ainsi à aucun moment les coordonnées bancaires des Acheteurs ne sont affichées ou visibles.

    Ces dernières ne sont en outre pas stockées sur les serveurs informatiques de la Société.

    - Par Paypal. Les informations financières et personnelles sont automatiquement cryptées lorsque des informations sensibles sont envoyées aux serveurs de PAYPAL.

    - Par virement bancaire. Afin de finaliser le paiement et de traiter la commande, l'Acheteur doit réaliser un virement du montant de sa commande sur le compte bancaire de la Société dont les coordonnées sont communiquées après le passage de la commande en indiquant clairement les références de la commande. Dès réception du virement, la commande sera traitée et l'Acheteur en sera informé par courrier électronique. Le paiement doit être reçu par la Société dans un délai maximum de 10 jours après l'enregistrement de la commande. Passé ce délai de 10 jours, la commande sera annulée.

    - Apple Pay : Dans cette éventualité, Apple Pay utilise un numéro propre à l'appareil de l'Acheteur et un code de transaction unique (La société ne dispose ainsi jamais des numéros de carte de paiement de l'Acheteur).

    - Bancontact : Dans cette éventualité, l'Acheteur doit scanner le code QR avec l'application dédiée, et confirmer le montant avec son code PIN, son empreinte digitale ou sa reconnaissance faciale.

    - iDeal : Système de paiement par internet utilisé essentiellement aux Pays-Bas.

    Dans le cadre de la lutte contre les fraudes sur Internet, les informations relatives aux commandes des Acheteurs pourront être transmises à tout tiers pour vérification.

    La société se réserve le droit de demander une photocopie de la carte d'identité de l'acheteur pour tout paiement par carte bancaire.

    
    Article 7 : Livraison
    7.1. Modalités de livraison
    Si le destinataire est absent lors de la livraison de la commande à domicile, une seconde tentative de livraison sera effectuée. La date de cette nouvelle livraison sera déterminée au choix à l'aide du formulaire notifié par mail ou SMS. En cas de nouvelle absence du destinataire, le colis est déposé en point de retrait et peut être récupéré pendant la période d'instance communiquée par le transporteur. Passé ce délai, la commande sera automatiquement retournée à la Société qui prendra contact avec l'Acheteur pour proposer une réexpédition ou un remboursement de la commande.

    
    7.2. Délais de livraison
    Les délais de livraison sont indiqués en jours ouvrés. Aucune expédition n'est effectuée le samedi, le dimanche ou jour férié. Aucune livraison n'est effectuée le dimanche ou jour férié.

    La Société fera son possible pour expédier les produits dans les deux jours ouvrés suivant la confirmation de la commande.

    Les colis sont pris en charge par les transporteurs entre 14h00 et 16h30, du lundi au vendredi. Les commandes passées après 15h00 du lundi au jeudi seront expédiées dans la mesure du possible le lendemain, et le lundi si la commande est validée le vendredi après 15h00. Le délai de livraison commence le jour où le colis quitte les locaux de la Société.

    La livraison interviendra dans les délais estimatifs indiqués sur l'email de confirmation de commande que la Société aura adressé à l'Acheteur sauf événement indépendant de la volonté de la Société.

    Les produits seront expédiés par Mondial Relay, La Poste (Colissimo suivi), dans les délais estimatifs de 48 à 72 heures, ou de 24/48 heures pour une livraison par TNT.

    La Société décline donc toute responsabilité en cas de non-respect des délais de livraison de la part des transporteurs, ainsi qu'en cas de perte des Produits commandés ou de grève des transporteurs, et d'une manière générale, en cas d'événements indépendants de sa volonté.

    Les retards de livraison ne peuvent donner lieu à aucune demande de dommages et intérêts ou de retenue de la part de l'Acheteur.

    En cas de retard de livraison par rapport à la date initialement prévue, l'Acheteur doit le signaler par e-mail à contact@cosma-parfumeries.fr ou par téléphone (dans un délai maximum de sept jours) afin de permettre à la Société d'effectuer les démarches auprès du transporteur.

    Une enquête auprès du transporteur peut prendre jusqu'à 30 jours ouvrables. Si le colis est retrouvé pendant ce délai, il sera expédié immédiatement à l'adresse de livraison indiquée sur le bon de commande. En revanche, si le colis n'est pas retrouvé à l'issue de ce délai de 30 jours, la Société procédera, à ses frais, à une nouvelle expédition ou au remboursement des produits commandés par l'Acheteur.

    En cas de litige de livraison, des documents (photocopie de la carte d'identité et des documents d'accompagnement) seront demandés afin d'étayer la réclamation et d'obtenir un dédommagement si la conclusion de l'enquête est favorable au destinataire.

    
    7.3. Réception des produits
    A réception des colis, si le carton d'expédition apparaît visiblement endommagé (emballage bosselé, perforé, déchiré, mouillé, coupé au cutter, etc.), reconditionné avec un autre adhésif ou si le poids du colis laisse à penser qu'il est vide, la réception du colis doit être refusée afin de procéder à un retour à l'expéditeur ou des réserves doivent être émises sur le bordereau de réception du transporteur, sans quoi la société Cosma Parfumeries ne pourra procéder à l'indemnisation des Produits éventuellement abîmés, inutilisables ou manquants.

    A réception du Produit, il appartient à l'Acheteur de vérifier sans délai la conformité et l'intégrité des Produits expédiés, avant de les ouvrir (ouverture du film cellophane de protection).

    Toute anomalie concernant la livraison doit être indiquée par l'Acheteur sur le récépissé présenté par le transporteur au moment de la livraison. Dans ce cas, pour que le retour soit accepté, l'Acheteur doit en informer la Société dans les 2 jours suivant la livraison du colis, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au +33(0)1 56 83 84 88.

    En cas de réclamation relative à la commande et/ou sa livraison, l'Acheteur doit en informer la Société dans les 2 jours suivant la réception de la commande, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au +33(0)1 56 83 84 88. L'Acheteur transmettra à la Société des photographies des éléments à l'appui de sa demande.

    Toute réclamation formulée après ce délai sera rejetée et la Société sera dégagée de toute responsabilité.

    De même toute réclamation portant sur la présentation d'un emballage ou une modification d'aspect du Produit à la suite d'un renouvellement de gamme du Produit par le fabricant ne pourra pas être prise en compte.

    
    7.4. Délai de rétractation et retour des produits
    Conformément à l'article L221-18 du Code de la consommation, l'Acheteur dispose d'un délai de rétractation de quatorze (14) jours calendaires à compter du lendemain de la réception du Produit pour retourner, à ses frais, le(s) Produit(s) qu'il a commandé(s) s'il n'en est pas satisfait et s'il n'a pas été ouvert et utilisé. Toutefois, si le délai expire un samedi, un dimanche ou un jour férié, il est prorogé jusqu'au premier jour ouvrable suivant. Les Produits doivent être retournés complets, dans un état propre à leur revente (produits en parfait état, dans leur emballage d'origine, sous cellophane de protection, non utilisés ou abîmés, accompagnés de leurs accessoires, échantillons, notices...). La Société se réserve le droit de refuser tout retour ne respectant pas les conditions ci-dessus. La Société n'accepte pas les colis envoyés en port dû.

    Conformément aux dispositions de l'article L.221-28 du Code de la consommation, le droit de rétractation ne peut être exercé pour les produits de beauté (cosmétiques et maquillage) descellés après la livraison pour des raisons d'hygiène ou de protection de la santé. L'Acheteur n'a donc pas de droit de rétractation pour ce type de produit.

    L'Acheteur peut exercer son droit de rétractation :
    - soit en répondant à l'e-mail de confirmation de commande envoyé par la Société,
    - soit à l'aide du formulaire de rétractation prévu par l'article R.221-1 du Code de la Consommation ci-dessous :


    MODÈLE DE FORMULAIRE DE RÉTRACTATION


    Je/nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*) ci-dessous :


    Commandé le                /reçu le             :


    Nom du (des) consommateur(s) :


    Adresse du (des) consommateur(s) :


    Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :


    Date :


    (*) Rayez la mention inutile.


    - soit en écrivant sur papier libre exprimant sa volonté claire de se rétracter, en indiquant de manière claire et lisible ses coordonnées et les références de sa commande.

    Le formulaire de rétractation ou la rétractation rédigée sur papier libre peut être envoyé(e) :
    - par courrier à l'adresse suivante : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC (FRANCE)
    - par courrier électronique à l'adresse suivante : contact@cosma-parfumeries.fr


    Si les conditions de la rétractation sont réunies, la Société procèdera au remboursement du Produit retourné par l'Acheteur sur le compte émetteur de l'achat.

    
    Article 8 : Garanties légales
    8.1. Garantie légale de conformité
    Dans l'hypothèse d'une non-conformité du produit réceptionné suite à la commande de l'Acheteur, ce dernier bénéficie de la garantie légale de conformité dans les conditions de l'article L.217-4 et suivants du Code de la consommation.

    En cas de défaut de conformité existant au moment de la délivrance du produit au sens de l'article  L. 216-1 du Code de la consommation, l'Acheteur doit en informer la Société dans le délai de 24 mois suivant la réception de la commande, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au +33(0)1 56 83 84 88.
    L'Acheteur pourra mettre en œuvre la garantie légale de conformité lorsque le produit est impropre à l'usage habituellement attendu (défaut de fabrication) pour un produit du même type, lorsqu'il présente un défaut d'emballage ou lorsqu'il ne correspond pas à la description mentionnée sur le site de la Société.

    L'Acheteur transmettra à la Société la preuve de son achat à l'appui de sa demande. Si le défaut de conformité du produit est avéré, l'Acheteur pourra solliciter auprès de la Société la mise en conformité du produit par réparation ou son remplacement. Pour ce faire, l'Acheteur retournera le produit non conforme au frais de la Société qui transmettra un bon de retour à l'Acheteur à cet effet.

    La Société pourra refuser la /mise en conformité sollicitée si celle-ci est impossible ou entraîne des coûts disproportionnés. Le cas échéant, l'Acheteur pourra demander le remplacement du produit non-conforme après réception de ce dernier par la Société.

    Si la réparation est possible, la mise en conformité du produit aura lieu dans le délai de trente jours suivant la réception de la demande de l'acheteur sous réserve de la réception du produit non conforme par la Société.

    Le produit réparé dans le cadre de la garantie légale de conformité bénéficiera d'une extension de cette garantie d'une durée de six mois.

    Si aucune des solutions envisagées ne peut être mise en œuvre dans le mois suivant la demande de l'Acheteur, ce dernier aura la possibilité de demander une diminution du prix dans les cas prévus à l'article  L. 217-14 du Code de la consommation.

    Dans le cas où le défaut de conformité est mineur, l'Acheteur ne pourra bénéficier du remboursement du prix du produit.

    Dans le cas où la réduction du prix est accordée par la Société, celle-ci sera proportionnelle à la différence entre la valeur du produit délivré et la valeur du produit en l'absence du défaut de conformité.

    Le remboursement accordé la Société sera effectué dès réception du produit non-conforme retourné à l'aide du bon de retour transmis par la Société et au plus tard dans les quatorze jours suivants.

    
    8.2. Garantie légale des vices cachés
    Conformément aux dispositions des articles 1641 et suivants du Code civil, l'Acheteur bénéficie de la garantie légale des vices cachés.

    En présence d'un vice caché d'un produit, l'Acheteur doit en informer la Société dans le délai dans le délai de 24 mois suivant la découverte du vice entachant le produit acheté auprès de la Société, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au 01 56 83 84 88.

    L'Acheteur pourra mettre en œuvre la garantie légale des vices cachés si les 3 conditions suivantes sont réunies : 

    - Le défaut doit être un défaut caché, c'est-à-dire non apparent lors de l'achat,

    - Le défaut doit rendre le produit inutilisable ou diminuer très fortement son usage,

    - Le défaut doit exister au moment de l'achat.


    L'Acheteur transmettra à la Société la preuve de son achat à l'appui de sa demande ainsi toutes preuves démontrant que le défaut rend le produit impropre à l'usage auquel on le destine ou le diminue fortement en produisant des photographies de toutes les faces du produit et de son emballage.

    Pour tout article comportant un vice caché, la procédure se fera directement auprès du fabricant du produit ou auprès de la Société selon le produit concerné, qui se chargera de l'échange de la marchandise après analyse, si le vice caché du produit est confirmé par le fabricant. La Société ne pourra voir sa responsabilité engagée à ce titre et ne sera pas tenue de rembourser l'Acheteur.

    Sous réserve de l'apport de ces preuves, l'Acheteur pourra choisir entre la résolution de la vente ou une réduction du prix de vente, conformément à l'article 1644 du code civil.

    Ces dispositions ne sont pas exclusives du droit de rétraction défini à l'article 7.4 ci-dessus.

    
    Article 9 : Informatique et liberté
    9.1. Données personnelles
    Les informations personnelles collectées dans le cadre de la vente à distance sont obligatoires pour assurer la bonne gestion des commandes, des livraisons et des factures. Ces informations sont confidentielles. Le défaut de renseignement entraîne le rejet automatique de la commande.

    Conformément notamment au RGPD et à la loi n° 78-17 du 6 janvier 1978 modifiée relative à l'informatique, aux fichiers et aux libertés, l'Acheteur dispose d'un droit d'accès, de modification, de rectification et de suppression des données qui le concernent. Pour exercer ce droit, l'Acheteur peut soit envoyer un e-mail à contact@cosma-parfumeries.fr, soit écrire à la Société : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC, FRANCE.

    En passant commande sur le Site, l'Acheteur donne son consentement à l'utilisation des informations nominatives recueillies au moment de la commande dans le fichier clients de la Société à des fins de facturation. Par ailleurs, la Société pourra utiliser les données personnelles de l'Acheteur pour lui adresser des offres commerciales susceptibles de l'intéresser. En application de la loi Informatique et Libertés, l'Acheteur a le droit de s'opposer à recevoir des documents de prospection commerciale non sollicités par courrier électronique, en cochant la case prévue à cet effet en ligne ou en adressant un courrier à la Société : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC, FRANCE.

    
    9.2. Cookies
    La Société se réserve le droit d'utiliser des cookies sur le Site afin de faciliter la navigation et de personnaliser les informations apparaissant sur le Site. La Société se réserve également le droit d'utiliser des cookies pour collecter des informations non personnelles sur les Utilisateurs (adresse IP, type de navigateur Internet, système d'exploitation utilisé ou pages du Site visitées par l'Utilisateur). Ces cookies ne sont utilisés par la Société que pour personnaliser le service offert à l'Utilisateur.

    
    Article 10 : Propriété intellectuelle
    Conformément aux lois régissant la propriété industrielle, les droits littéraires et artistiques ou autres droits similaires, ce site et tous les éléments (images, dessins, scripts sources, logos, etc.) composant le Site sont la propriété exclusive de la Société ou de ses fournisseurs, ces derniers ne concédant aucune licence, ni aucun droit autre que celui de consulter le site.

    L'Utilisateur s'engage donc à ne pas distribuer ou reproduire le Site, en tout ou en partie, sous quelque forme que ce soit. La société est propriétaire de la marque "Cosma Parfumeries" et du nom de domaine "cosma-parfumeries.com". Toute reproduction, distribution, transmission, modification ou utilisation de ces marques à quelque fin que ce soit est interdite.

    Toute autre utilisation est constitutive de contrefaçon et sanctionnée au titre de la propriété intellectuelle, sauf autorisation préalable et écrite de Cosma Parfumeries.

    
    Article 11 : Droit applicable - Litige
    Les présentes conditions générales sont soumises à la loi française. En cas de litige, les tribunaux français seront seuls compétents. Toutefois, une solution amiable sera recherchée avant toute action judiciaire.

    L'Acheteur est informé de la possibilité de recourir, en cas de contestation, à une procédure de médiation conventionnelle en adressant une réclamation écrite au service de médiation FEVAD, pour toute réclamation liée à un achat sur le Site introduite au cours des 12 derniers mois.

    Conformément aux dispositions du Code de la consommation concernant le règlement amiable des litiges, la Société adhère au Service du Médiateur du e-commerce de la FEVAD (Fédération du e-commerce et de la vente à distance) dont les coordonnées sont les suivantes :

    Médiateur de la consommation FEVAD

    BP 20015

    75362 PARIS CEDEX 8

    https://www.mediateurfevad.fr

    Après démarche préalable écrite de l'Acheteur auprès du service client de la Société, le Service du Médiateur peut être saisi pour tout litige de consommation dont le règlement n'aurait pas abouti.

    Pour les livraisons effectuées en Belgique, toute plainte peut également être introduite au service de médiation pour les consommateurs

    Boulevard du Roi Albert II, 8, Bte 1

    1000 Bruxelles

    Tél. : 02/702.52.20

    Fax. : 02/808.71.29

    E-mail : contact@mediationconsommateur.be

    L'Acheteur peut enfin également introduire sa plainte auprès des services de la commissions européenne en utilisant le lien ci-dessous :

    https://ec.europa.eu/consumers/odr/main/?event=main.home.selfTest

    La solution proposée par le Médiateur ne s'impose pas aux Parties, qui restent libres à tout moment de sortir du processus de médiation.

    
    Article 12 : Modification des conditions générales de vente
    Compte tenu des évolutions possibles du Site, la Société se réserve la possibilité d'adapter ou de modifier à tout moment les présentes conditions générales de vente. Les nouvelles conditions générales de vente seront, le cas échéant, portées à la connaissance de l'Utilisateur par modification en ligne et ne seront applicables qu'aux ventes réalisées postérieurement à la modification.`
  } catch (error) {
    handleError('get_terms', error);
  }
}

async function get_privacy_policy() {
  try {
    return `Article 9 : Informatique et liberté
    9.1. Données personnelles
    Les informations personnelles collectées dans le cadre de la vente à distance sont obligatoires pour assurer la bonne gestion des commandes, des livraisons et des factures. Ces informations sont confidentielles. Le défaut de renseignement entraîne le rejet automatique de la commande.

    Conformément notamment au RGPD et à la loi n° 78-17 du 6 janvier 1978 modifiée relative à l'informatique, aux fichiers et aux libertés, l'Acheteur dispose d'un droit d'accès, de modification, de rectification et de suppression des données qui le concernent. Pour exercer ce droit, l'Acheteur peut soit envoyer un e-mail à contact@cosma-parfumeries.fr, soit écrire à la Société : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC, FRANCE.

    En passant commande sur le Site, l'Acheteur donne son consentement à l'utilisation des informations nominatives recueillies au moment de la commande dans le fichier clients de la Société à des fins de facturation. Par ailleurs, la Société pourra utiliser les données personnelles de l'Acheteur pour lui adresser des offres commerciales susceptibles de l'intéresser. En application de la loi Informatique et Libertés, l'Acheteur a le droit de s'opposer à recevoir des documents de prospection commerciale non sollicités par courrier électronique, en cochant la case prévue à cet effet en ligne ou en adressant un courrier à la Société : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC, FRANCE.

    
    9.2. Cookies
    La Société se réserve le droit d'utiliser des cookies sur le Site afin de faciliter la navigation et de personnaliser les informations apparaissant sur le Site. La Société se réserve également le droit d'utiliser des cookies pour collecter des informations non personnelles sur les Utilisateurs (adresse IP, type de navigateur Internet, système d'exploitation utilisé ou pages du Site visitées par l'Utilisateur). Ces cookies ne sont utilisés par la Société que pour personnaliser le service offert à l'Utilisateur.`;
  } catch (error) {
    handleError('get_privacy_policy', error);
  }
}

async function get_return_policy() {
  try {
    return `Article 7 : Livraison
      7.1. Modalités de livraison
      Si le destinataire est absent lors de la livraison de la commande à domicile, une seconde tentative de livraison sera effectuée. La date de cette nouvelle livraison sera déterminée au choix à l'aide du formulaire notifié par mail ou SMS. En cas de nouvelle absence du destinataire, le colis est déposé en point de retrait et peut être récupéré pendant la période d'instance communiquée par le transporteur. Passé ce délai, la commande sera automatiquement retournée à la Société qui prendra contact avec l'Acheteur pour proposer une réexpédition ou un remboursement de la commande.

      
      7.2. Délais de livraison
      Les délais de livraison sont indiqués en jours ouvrés. Aucune expédition n'est effectuée le samedi, le dimanche ou jour férié. Aucune livraison n'est effectuée le dimanche ou jour férié.

      La Société fera son possible pour expédier les produits dans les deux jours ouvrés suivant la confirmation de la commande.

      Les colis sont pris en charge par les transporteurs entre 14h00 et 16h30, du lundi au vendredi. Les commandes passées après 15h00 du lundi au jeudi seront expédiées dans la mesure du possible le lendemain, et le lundi si la commande est validée le vendredi après 15h00. Le délai de livraison commence le jour où le colis quitte les locaux de la Société.

      La livraison interviendra dans les délais estimatifs indiqués sur l'email de confirmation de commande que la Société aura adressé à l'Acheteur sauf événement indépendant de la volonté de la Société.

      Les produits seront expédiés par Mondial Relay, La Poste (Colissimo suivi), dans les délais estimatifs de 48 à 72 heures, ou de 24/48 heures pour une livraison par TNT.

      La Société décline donc toute responsabilité en cas de non-respect des délais de livraison de la part des transporteurs, ainsi qu'en cas de perte des Produits commandés ou de grève des transporteurs, et d'une manière générale, en cas d'événements indépendants de sa volonté.

      Les retards de livraison ne peuvent donner lieu à aucune demande de dommages et intérêts ou de retenue de la part de l'Acheteur.

      En cas de retard de livraison par rapport à la date initialement prévue, l'Acheteur doit le signaler par e-mail à contact@cosma-parfumeries.fr ou par téléphone (dans un délai maximum de sept jours) afin de permettre à la Société d'effectuer les démarches auprès du transporteur.

      Une enquête auprès du transporteur peut prendre jusqu'à 30 jours ouvrables. Si le colis est retrouvé pendant ce délai, il sera expédié immédiatement à l'adresse de livraison indiquée sur le bon de commande. En revanche, si le colis n'est pas retrouvé à l'issue de ce délai de 30 jours, la Société procédera, à ses frais, à une nouvelle expédition ou au remboursement des produits commandés par l'Acheteur.

      En cas de litige de livraison, des documents (photocopie de la carte d'identité et des documents d'accompagnement) seront demandés afin d'étayer la réclamation et d'obtenir un dédommagement si la conclusion de l'enquête est favorable au destinataire.

      
      7.3. Réception des produits
      A réception des colis, si le carton d'expédition apparaît visiblement endommagé (emballage bosselé, perforé, déchiré, mouillé, coupé au cutter, etc.), reconditionné avec un autre adhésif ou si le poids du colis laisse à penser qu'il est vide, la réception du colis doit être refusée afin de procéder à un retour à l'expéditeur ou des réserves doivent être émises sur le bordereau de réception du transporteur, sans quoi la société Cosma Parfumeries ne pourra procéder à l'indemnisation des Produits éventuellement abîmés, inutilisables ou manquants.

      A réception du Produit, il appartient à l'Acheteur de vérifier sans délai la conformité et l'intégrité des Produits expédiés, avant de les ouvrir (ouverture du film cellophane de protection).

      Toute anomalie concernant la livraison doit être indiquée par l'Acheteur sur le récépissé présenté par le transporteur au moment de la livraison. Dans ce cas, pour que le retour soit accepté, l'Acheteur doit en informer la Société dans les 2 jours suivant la livraison du colis, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au +33(0)1 56 83 84 88.

      En cas de réclamation relative à la commande et/ou sa livraison, l'Acheteur doit en informer la Société dans les 2 jours suivant la réception de la commande, par e-mail à contact@cosma-parfumeries.fr ou par téléphone au +33(0)1 56 83 84 88. L'Acheteur transmettra à la Société des photographies des éléments à l'appui de sa demande.

      Toute réclamation formulée après ce délai sera rejetée et la Société sera dégagée de toute responsabilité.

      De même toute réclamation portant sur la présentation d'un emballage ou une modification d'aspect du Produit à la suite d'un renouvellement de gamme du Produit par le fabricant ne pourra pas être prise en compte.

      
      7.4. Délai de rétractation et retour des produits
      Conformément à l'article L221-18 du Code de la consommation, l'Acheteur dispose d'un délai de rétractation de quatorze (14) jours calendaires à compter du lendemain de la réception du Produit pour retourner, à ses frais, le(s) Produit(s) qu'il a commandé(s) s'il n'en est pas satisfait et s'il n'a pas été ouvert et utilisé. Toutefois, si le délai expire un samedi, un dimanche ou un jour férié, il est prorogé jusqu'au premier jour ouvrable suivant. Les Produits doivent être retournés complets, dans un état propre à leur revente (produits en parfait état, dans leur emballage d'origine, sous cellophane de protection, non utilisés ou abîmés, accompagnés de leurs accessoires, échantillons, notices...). La Société se réserve le droit de refuser tout retour ne respectant pas les conditions ci-dessus. La Société n'accepte pas les colis envoyés en port dû.

      Conformément aux dispositions de l'article L.221-28 du Code de la consommation, le droit de rétractation ne peut être exercé pour les produits de beauté (cosmétiques et maquillage) descellés après la livraison pour des raisons d'hygiène ou de protection de la santé. L'Acheteur n'a donc pas de droit de rétractation pour ce type de produit.

      L'Acheteur peut exercer son droit de rétractation :
      - soit en répondant à l'e-mail de confirmation de commande envoyé par la Société,
      - soit à l'aide du formulaire de rétractation prévu par l'article R.221-1 du Code de la Consommation ci-dessous :


      MODÈLE DE FORMULAIRE DE RÉTRACTATION


      Je/nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*) ci-dessous :


      Commandé le                /reçu le             :


      Nom du (des) consommateur(s) :


      Adresse du (des) consommateur(s) :


      Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :


      Date :


      (*) Rayez la mention inutile.


      - soit en écrivant sur papier libre exprimant sa volonté claire de se rétracter, en indiquant de manière claire et lisible ses coordonnées et les références de sa commande.

      Le formulaire de rétractation ou la rétractation rédigée sur papier libre peut être envoyé(e) :
      - par courrier à l'adresse suivante : Cosma - Service Clients - 17 Route des Boulangers, 78 530 BUC (FRANCE)
      - par courrier électronique à l'adresse suivante : contact@cosma-parfumeries.fr


      Si les conditions de la rétractation sont réunies, la Société procèdera au remboursement du Produit retourné par l'Acheteur sur le compte émetteur de l'achat.

      `;
  } catch (error) {
    handleError('get_return_policy', error);
  }
}

// ============================================================
// FACTURATION
// ============================================================
//Invoice data
function convertInvoiceItems(invoiceItems) {
  // 1️⃣ Séparer les parents et les enfants
  const parents = {};
  const children = {};

  invoiceItems.forEach(item => {
    if (item.base_price > 0) {
      parents[item.entity_id] = item;
    } else {
      children[item.entity_id] = item;
    }
  });

  // 2️⃣ Associer les enfants à leur parent (même SKU)
  const merged = Object.values(parents).map(parent => {
    // trouver le child avec même sku (peut être absent maintenant)
    const child = Object.values(children).find(c => c.sku === parent.sku);

    const finalName = parent.name;

    // Pas de child trouvé => pas de variation à extraire
    const variation = child
      ? child.name.replace(parent.name, "").trim()
      : "";

    // 3️⃣ Calcul TVA%
    const taxPercent =
      parent.price > 0
        ? Math.round((parent.tax_amount / parent.price) * 100)
        : 0;

    return {
      sku: parent.sku,
      name: finalName.replace(/\s+/g, " ").trim(),
      variation,
      qty: parent.qty,
      unit_price_ht: parent.base_price,
      unit_price_ttc: parent.base_price_incl_tax || parent.price_incl_tax,
      tax_percent: taxPercent
    };
  });

  return merged;
}
// create invoice html
function createHtmlInvoice(data){
  return `<!DOCTYPE html>
    <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <title>Facture</title>

            <style>
                @page {
                    size: A4;
                    margin: 5mm; /* marge basse pour éviter que le contenu touche le footer */
                }

                body {
                    font-family: Arial, sans-serif;
                    color: #333;
                    margin: 0;
                    padding: 0;
                }

                .container {
                    width: 100%;
                    padding: 20px;
                    box-sizing: border-box;
                }

                .title {
                    margin-bottom: 30px;
                    font-size: 28px;
                    font-weight: bold;
                }

                .section {
                    margin-bottom: 25px;
                }

                .section-title {
                    font-size: 16px;
                    font-weight: bold;
                    margin-bottom: 5px;
                }

                .info-table {
                    width: 65%;
                    border-collapse: collapse;
                    margin-top: 5px;
                }

                .info-table td {
                    border: none;
                    padding: 3px;
                }

                .double-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 10px;
                }

                .double-table td {
                    padding: 10px;
                    vertical-align: top;
                }

                .double-table-header td {
                    font-weight: bold;
                    padding-bottom: 5px;
                }

                .double-table-body td {
                    border: 1px solid #333;
                }

                .items-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 20px;
                }

                .items-table th,
                .items-table td {
                    border-bottom: 1px solid #999;
                    padding: 10px;
                    width: max-content;
                }

                .items-table .no_border td {
                    border: none;
                    padding: 10px;
                    width: max-content;
                }

                .items-table th {
                    background: #f2f2f2;
                    font-weight: bold;
                    text-align: center;
                }

                .items-table td {
                    text-align: center;
                }

                .total {
                    text-align: right;
                    margin-top: 20px;
                    font-size: 18px;
                    font-weight: bold;
                }

                .footer {
                    top: 0;
                    width: 100%;
                    border-bottom: 1px solid #ccc;
                    padding: 5px 10px;
                    font-size: 10px;
                    background: #fff;
                    margin-top: 0px; /* pour séparer du contenu */
                }

                .triple-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 5px;
                }

                .triple-table td {
                    padding: 5px;
                    vertical-align: top;
                }

            </style>
        </head>
        <body>
            <div  class="footer">
                <table class="triple-table">
                    <tr>
                        <td>
                            COSMA PARFUMERIES S.A au Capital de 1 216 600 €<br>
                            384 736 666 R.C.S. Versailles<br>
                            SIRET 384 736 666 00072<br>
                            TVA FR26 384 736 666
                        </td>
                        <td>
                            Siège social<br>
                            17 Route des Boulangers<br>
                            78530 BUC - FRANCE<br>
                            Tél. : 01 56 83 84 88
                        </td>
                        <td>
                            E-commerce : cosma-parfumeries.com<br>
                            17 Route des Boulangers<br>
                            78530 BUC - FRANCE<br>
                            Tél. : 01 56 83 84 88
                        </td>
                    </tr>
                </table>
            </div>
            <div class="container">

                <h1 class="title">
                    <img src="https://www.cosma-parfumeries.com/media/logo/websites/1/LOGO_1.png"  width="230px">
                </h1>

                <div class="section">
                    <table class="info-table">
                        <tr>
                            <td><b>Facture :</b></td>
                            <td>${data.invoice.invoice_number}</td>
                        </tr>
                        <tr>
                            <td><b>Date de facturation :</b></td>
                            <td>${data.invoice.invoice_created_at}</td>
                        </tr>
                        <tr>
                            <td><b>Commande :</b></td>
                            <td>${data.order_number}</td>
                        </tr>
                        <tr>
                            <td><b>Date de commande :</b></td>
                            <td>${data.order_created_at}</td>
                        </tr>
                    </table>
                </div>

                <div class="section">
                    <table class="double-table">
                        <tr class="double-table-header">
                            <td style="width: 50%;"><b>Adresse de facturation</b></td>
                            <td><b>Adresse de livraison</b></td>
                        </tr>
                        <tr class="double-table-body">
                            <td>
                                ${data.billing_address.firstname} ${data.billing_address.lastname}<br>
                                ${
                                  data.billing_address.street.map(item => `
                                    ${item}<br>
                                  `).join('')
                                }
                                ${data.billing_address.postcode} ${data.billing_address.city}<br>
                                ${data.billing_address.country}<br>
                                T: ${data.billing_address.telephone}
                            </td>
                            <td>
                                ${data.shipping_address.firstname} ${data.shipping_address.lastname}<br>
                                ${
                                  data.shipping_address.street.map(item => `
                                    ${item}<br>
                                  `).join('')
                                }
                                ${data.shipping_address.postcode} ${data.shipping_address.city}<br>
                                ${data.shipping_address.country}<br>
                                T: ${data.shipping_address.telephone}
                            </td>
                        </tr>
                    </table>
                </div>

                <div class="section">
                    <table class="double-table">
                        <tr class="double-table-header">
                            <td style="width: 50%;"><b>Mode de paiement</b></td>
                            <td><b>Méthode de livraison</b></td>
                        </tr>
                        <tr class="double-table-body">
                            <td>
                                ${data.payment.method} ${data.payment.type}<br>
                                Ref: ${data.payment.transaction_id}
                            </td>
                            <td>
                                ${data.shipping_address.method}
                            </td>
                        </tr>
                    </table>
                </div>

                <h3>Résumé de la commande</h3>

                <table class="items-table">
                    <tr>
                        <th>Référence</th>
                        <th>Désignation</th>
                        <th>Prix</th>
                        <th>Qté</th>
                        <th>Sous-total</th>
                    </tr>

                    ${
                        data.invoice.items.map(item => `
                          <tr>
                              <td>
                                  ${item.sku}<br>
                                  ${item.variation}
                              </td>
                              <td> ${item.name}</td>
                              <td>${item.unit_price_ttc} ${data.currency}</td>
                              <td>${item.qty}</td>
                              <td>${(item.unit_price_ttc * item.qty).toFixed(2)} ${data.currency}</td>
                          </tr>
                        `).join('')
                      }

                    <tr class="no_border">
                        <td></td>
                        <td></td>
                        <td>Sous-total :</td>
                        <td></td>
                        <td>${data.totals.subtotal_ht} ${data.currency}</td>
                    </tr>
                    <tr class="no_border">
                        <td></td>
                        <td></td>
                        <td>TVA :</td>
                        <td></td>
                        <td>${data.totals.tax} ${data.currency}</td>
                    </tr>
                    <tr class="no_border">
                        <td></td>
                        <td></td>
                        <td><b>Total :</b></td>
                        <td></td>
                        <td><b>${data.totals.grand_total_ttc} ${data.currency}</b></td>
                    </tr>
                </table>

            </div>
        </body>
    </html>
`;
}

async function getInvoicePDF(orderNumber, langue, baseUrl = process.env.BASE_URL_APP) {
  try {

    // 1. Rechercher la commande via increment_id
    const searchCriteria = `searchCriteria[filter_groups][0][filters][0][field]=increment_id` +
      `&searchCriteria[filter_groups][0][filters][0][value]=${orderNumber}` +
      `&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

    const orderResponse = await magento.get(`/orders?${searchCriteria}`);

    if (!orderResponse.data.items || orderResponse.data.items.length === 0) {
      throw new Error(`Commande ${orderNumber} introuvable`);
    }
    const order = orderResponse.data.items[0];

    // 2. Récupérer les factures liées via order_id
    const invoiceSearch =
      `searchCriteria[filter_groups][0][filters][0][field]=order_id` +
      `&searchCriteria[filter_groups][0][filters][0][value]=${order.entity_id}` +
      `&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

    const invoiceResponse = await magento.get(`/invoices?${invoiceSearch}`);

    const invoices = invoiceResponse.data.items || [];

    let data = {
      "order_id": order.entity_id,
      "order_number": order.increment_id,
      "order_created_at": order.created_at,
      "status": order.status,
      "currency": order.order_currency_code,
      "totals": {
        "subtotal_ht": order.subtotal_invoiced,
        "tax": order.tax_invoiced,
        "shipping": order.shipping_amount,
        "discount": order.discount_invoiced,
        "grand_total_ttc": order.total_invoiced
      },
      "customer": {
        "id": order.customer_id,
        "firstname": order.billing_address.firstname,
        "lastname": order.billing_address.lastname,
        "email": order.billing_address.email,
        "is_guest": false
      },
      "billing_address": {
        "firstname": order.billing_address.firstname,
        "lastname": order.billing_address.lastname,
        "street": order.billing_address.street,
        "city": order.billing_address.city,
        "postcode": order.billing_address.postcode,
        "country": order.billing_address.country_id,
        "telephone": order.billing_address.telephone
      },
      "shipping_address": {
        "firstname": order.billing_address.firstname,
        "lastname": order.billing_address.lastname,
        "street": order.extension_attributes.shipping_assignments[0].shipping.address.street,
        "city": order.extension_attributes.shipping_assignments[0].shipping.address.city,
        "postcode": order.extension_attributes.shipping_assignments[0].shipping.address.postcode,
        "country": order.extension_attributes.shipping_assignments[0].shipping.address.country_id,
        "telephone": order.extension_attributes.shipping_assignments[0].shipping.address.telephone,
        "method": order.shipping_description
      },
      "payment": {
        "method": order.payment.method,
        "type": order.payment.cc_type,
        "amount_paid": order.payment.base_amount_paid1,
        "status": order.payment.cc_status_description,
        "transaction_id": order.payment.last_trans_id
      },
      "invoice": {
        "invoice_number": invoices[0].increment_id,
        "invoice_created_at": invoices[0].created_at,
        "items": convertInvoiceItems(invoices[0].items)
      }
    }

    // HTML invoice
    const html = createHtmlInvoice(data);

    //Translate HTML
    const OpenAiService = require('../services/OpenAiApiService');
    const openAiService = new OpenAiService();
    const html_translated = await openAiService.translate(html, {target: langue});

    // Générer PDF normal
    const browser = await puppeteer.launch({
        headless: "true",
        //executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html_translated, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true
    });
    await browser.close();

    // Charger PDF dans pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBuffer);

    // Exporter PDF protégé
    const protectedPdf = await pdfDoc.save();

    // Sauvegarder dans un dossier
    const filename = `${orderNumber}.pdf`;
    const outputPath = path.join(__dirname, "../public/uploads/invoices", filename);

    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, protectedPdf);

    const finalUrl = `${baseUrl}/public/uploads/invoices/${encodeURIComponent(filename)}`;

    // Retourner infos
    return {
        invoice_link: finalUrl
    };
    
  } catch (error) {
    console.error('Erreur_Magento:', error.response?.data || error.message);
    throw error;
  }
}


// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  magento,
  buildSearchCriteria,
  normalizeListOptions,

  // Commandes
  get_order,
  get_order_by_increment_id,
  get_last_orders_by_email,
  get_customer_orders,
  search_orders,
  get_order_status,
  get_order_items,
  get_order_total,

  // Livraison
  get_tracking,
  get_shipping_method,
  get_shipping_cost,

  // Paiement
  get_payment_method,

  // Factures / avoirs
  get_invoice,
  get_credit_memo,

  // Produits
  search_products,
  search_products_advanced,
  list_searchable_attributes,
  get_product,
  get_product_by_name,
  get_product_price,
  get_product_stock,
  get_product_images,
  get_product_attributes,
  compare_products,
  get_related_products,
  get_cross_sell_products,
  get_upsell_products,

  // Catégories
  get_categories,
  get_category,
  get_products_by_category,
  get_new_products,
  get_best_sellers,
  search_brand,

  // Boutique
  get_store_information,
  get_store_hours,
  get_store_locations,
  get_contact_information,
  get_terms,
  get_privacy_policy,
  get_return_policy,

  // Facturation
  getInvoicePDF,
};