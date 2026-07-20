require('dotenv').config();
const axios = require('axios');

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
async function get_order_by_increment_id(orderNumber) {
  try {
    const query = buildSearchCriteria([
      [{ field: 'increment_id', value: orderNumber, condition_type: 'eq' }]
    ]);
    const { data } = await magento.get(`/orders?${query}`);
    if (!data.items || data.items.length === 0) {
      throw new Error(`Commande ${orderNumber} introuvable`);
    }
    return data.items[0];
  } catch (error) {
    handleError('get_order_by_increment_id', error);
  }
}

// Dernières commandes d'un client via son email
async function get_last_orders_by_email(email, limit = 5) {
  try {
    const query = buildSearchCriteria(
      [[{ field: 'customer_email', value: email, condition_type: 'eq' }]],
      { pageSize: limit, sortField: 'created_at', sortDirection: 'DESC' }
    );
    const { data } = await magento.get(`/orders?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_last_orders_by_email', error);
  }
}

// Toutes les commandes d'un client via son customer_id
async function get_customer_orders(customerId, options = {}) {
  try {
    const query = buildSearchCriteria(
      [[{ field: 'customer_id', value: customerId, condition_type: 'eq' }]],
      { sortField: 'created_at', sortDirection: 'DESC', ...options }
    );
    const { data } = await magento.get(`/orders?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_customer_orders', error);
  }
}

// Recherche générique de commandes
// filterGroups = [ [ {field, value, condition_type} ] ]
async function search_orders(filterGroups = [], options = {}) {
  try {
    const query = buildSearchCriteria(filterGroups, options);
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

// Suivi de livraison d'une commande (via les expéditions liées)
// Retourne les shipments + leurs "tracks" (transporteur, numéro de suivi...)
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

// Méthode de livraison utilisée sur une commande
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

// Coût de livraison d'une commande
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

// Méthode de paiement d'une commande
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

// Facture(s) liée(s) à une commande
async function get_invoice(orderId) {
  try {
    const query = buildSearchCriteria([[{ field: 'order_id', value: orderId, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/invoices?${query}`);
    return data.items || [];
  } catch (error) {
    handleError('get_invoice', error);
  }
}

// Avoir(s) lié(s) à une commande
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

// Recherche de produits par mot-clé (sur le nom)
async function search_products(query, options = {}) {
  try {
    const qs = buildSearchCriteria(
      [[{ field: 'name', value: `%${query}%`, condition_type: 'like' }]],
      options
    );
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('search_products', error);
  }
}

// Détail d'un produit via son SKU
async function get_product(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}`);
    return data;
  } catch (error) {
    handleError('get_product', error);
  }
}

// Recherche d'un produit par nom exact
async function get_product_by_name(name) {
  try {
    const qs = buildSearchCriteria([[{ field: 'name', value: name, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items?.[0] || null;
  } catch (error) {
    handleError('get_product_by_name', error);
  }
}

// Prix d'un produit
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

// Stock disponible d'un produit
async function get_product_stock(sku) {
  try {
    const { data } = await magento.get(`/stockItems/${encodeURIComponent(sku)}`);
    return data;
  } catch (error) {
    handleError('get_product_stock', error);
  }
}

// Images d'un produit
async function get_product_images(sku) {
  try {
    const product = await get_product(sku);
    return product.media_gallery_entries || [];
  } catch (error) {
    handleError('get_product_images', error);
  }
}

// Attributs custom d'un produit
async function get_product_attributes(sku) {
  try {
    const product = await get_product(sku);
    return product.custom_attributes || [];
  } catch (error) {
    handleError('get_product_attributes', error);
  }
}

// Comparer deux produits
async function compare_products(sku1, sku2) {
  try {
    const [p1, p2] = await Promise.all([get_product(sku1), get_product(sku2)]);
    return { product_1: p1, product_2: p2 };
  } catch (error) {
    handleError('compare_products', error);
  }
}

// Produits liés (related)
async function get_related_products(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}/links/related`);
    return data;
  } catch (error) {
    handleError('get_related_products', error);
  }
}

// Ventes croisées (cross-sell)
async function get_cross_sell_products(sku) {
  try {
    const { data } = await magento.get(`/products/${encodeURIComponent(sku)}/links/crosssell`);
    return data;
  } catch (error) {
    handleError('get_cross_sell_products', error);
  }
}

// Montées en gamme (upsell)
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

// Arborescence complète des catégories
async function get_categories() {
  try {
    const { data } = await magento.get('/categories');
    return data;
  } catch (error) {
    handleError('get_categories', error);
  }
}

// Détail d'une catégorie
async function get_category(categoryId) {
  try {
    const { data } = await magento.get(`/categories/${categoryId}`);
    return data;
  } catch (error) {
    handleError('get_category', error);
  }
}

// Produits d'une catégorie (SKU + position ; enrichir avec get_product si besoin)
async function get_products_by_category(categoryId) {
  try {
    const { data } = await magento.get(`/categories/${categoryId}/products`);
    return data;
  } catch (error) {
    handleError('get_products_by_category', error);
  }
}

// Nouveaux produits.
// Approche : tri par date de création décroissante (approximation).
// Pour une vraie logique "nouveautés", filtrer idéalement sur les
// attributs news_from_date / news_to_date si indexés/filtrables.
async function get_new_products(limit = 10) {
  try {
    const qs = buildSearchCriteria([], {
      pageSize: limit,
      sortField: 'created_at',
      sortDirection: 'DESC'
    });
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('get_new_products', error);
  }
}

// Meilleures ventes.
// ⚠️ Magento ne fournit pas ces données via l'API REST standard
// (le rapport "Bestsellers" est réservé à l'Admin). Une implémentation
// fiable nécessite soit un module custom exposant les données du
// rapport, soit une agrégation manuelle depuis les order items
// (coûteux, à éviter en usage direct/production sans cache).
async function get_best_sellers(limit = 10) {
  try {
    const { data } = await magento.get(`/products/bestsellers?limit=${limit}`); // endpoint custom requis
    return data;
  } catch (error) {
    handleError('get_best_sellers (endpoint custom requis)', error);
  }
}

// Recherche par marque.
// ⚠️ Adapter attribute_code selon la config du catalogue (souvent
// "manufacturer" ou "brand").
async function search_brand(brand, attributeCode = 'manufacturer') {
  try {
    const qs = buildSearchCriteria([[{ field: attributeCode, value: brand, condition_type: 'eq' }]]);
    const { data } = await magento.get(`/products?${qs}`);
    return data.items || [];
  } catch (error) {
    handleError('search_brand', error);
  }
}

// ============================================================
// INFORMATIONS BOUTIQUE (Store / CMS)
// ============================================================

// Configuration générale de la boutique (nom, devise, locale, etc.)
async function get_store_information() {
  try {
    const { data } = await magento.get('/store/storeConfigs');
    return data;
  } catch (error) {
    handleError('get_store_information', error);
  }
}

// Récupère une page CMS via son identifiant (slug)
async function getCmsPageByIdentifier(identifier) {
  const qs = buildSearchCriteria([[{ field: 'identifier', value: identifier, condition_type: 'eq' }]]);
  const { data } = await magento.get(`/cmsPage/search?${qs}`);
  return data.items?.[0] || null;
}

// Récupère un bloc CMS via son identifiant
async function getCmsBlockByIdentifier(identifier) {
  const qs = buildSearchCriteria([[{ field: 'identifier', value: identifier, condition_type: 'eq' }]]);
  const { data } = await magento.get(`/cmsBlock/search?${qs}`);
  return data.items?.[0] || null;
}

// Horaires d'ouverture. ⚠️ Non standard : provient généralement d'un
// bloc CMS dédié. Adapter l'identifiant selon la config réelle.
async function get_store_hours(blockIdentifier = 'store-hours') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_store_hours', error);
  }
}

// Localisation(s) physique(s) des magasins. ⚠️ Non natif à Magento
// core (souvent géré par une extension type "Store Locator").
// Fallback proposé : bloc CMS dédié.
async function get_store_locations(blockIdentifier = 'store-locations') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_store_locations', error);
  }
}

// Coordonnées de contact. ⚠️ Non natif : bloc/page CMS ou store config.
async function get_contact_information(blockIdentifier = 'contact-information') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_contact_information', error);
  }
}

// Conditions générales / conditions d'utilisation.
// Utilise l'endpoint standard checkoutAgreements quand disponible,
// sinon fallback sur une page CMS.
async function get_terms(cmsIdentifier = 'terms-and-conditions') {
  try {
    const { data } = await magento.get('/checkoutAgreements');
    if (data && data.length > 0) return data;
    return await getCmsPageByIdentifier(cmsIdentifier);
  } catch (error) {
    handleError('get_terms', error);
  }
}

// Politique de confidentialité. ⚠️ Page CMS, identifiant à adapter.
async function get_privacy_policy(cmsIdentifier = 'privacy-policy-cookie-restriction-mode') {
  try {
    return await getCmsPageByIdentifier(cmsIdentifier);
  } catch (error) {
    handleError('get_privacy_policy', error);
  }
}

// Politique de retour. ⚠️ Page CMS, identifiant à adapter.
async function get_return_policy(cmsIdentifier = 'return-policy') {
  try {
    return await getCmsPageByIdentifier(cmsIdentifier);
  } catch (error) {
    handleError('get_return_policy', error);
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  magento,
  buildSearchCriteria,

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
  get_return_policy
};