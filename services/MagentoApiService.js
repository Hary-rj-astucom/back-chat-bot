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

// Recherche de produits par mot-clé (sur le nom)
// -> pagination et tri désormais TOUJOURS appliqués (5 par défaut, 10 max)
async function search_products(query, options = {}) {
  try {
    const normalized = normalizeListOptions(options, { sortField: 'name' });
    const qs = buildSearchCriteria(
      [[{ field: 'name', value: `%${query}%`, condition_type: 'like' }]],
      normalized
    );
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
    const { data } = await magento.get('/store/storeConfigs');
    return data;
  } catch (error) {
    handleError('get_store_information', error);
  }
}

async function getCmsPageByIdentifier(identifier) {
  const qs = buildSearchCriteria([[{ field: 'identifier', value: identifier, condition_type: 'eq' }]]);
  const { data } = await magento.get(`/cmsPage/search?${qs}`);
  return data.items?.[0] || null;
}

async function getCmsBlockByIdentifier(identifier) {
  const qs = buildSearchCriteria([[{ field: 'identifier', value: identifier, condition_type: 'eq' }]]);
  const { data } = await magento.get(`/cmsBlock/search?${qs}`);
  return data.items?.[0] || null;
}

async function get_store_hours(blockIdentifier = 'store-hours') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_store_hours', error);
  }
}

async function get_store_locations(blockIdentifier = 'store-locations') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_store_locations', error);
  }
}

async function get_contact_information(blockIdentifier = 'contact-information') {
  try {
    return await getCmsBlockByIdentifier(blockIdentifier);
  } catch (error) {
    handleError('get_contact_information', error);
  }
}

async function get_terms(cmsIdentifier = 'terms-and-conditions') {
  try {
    const { data } = await magento.get('/checkoutAgreements');
    if (data && data.length > 0) return data;
    return await getCmsPageByIdentifier(cmsIdentifier);
  } catch (error) {
    handleError('get_terms', error);
  }
}

async function get_privacy_policy(cmsIdentifier = 'privacy-policy-cookie-restriction-mode') {
  try {
    return await getCmsPageByIdentifier(cmsIdentifier);
  } catch (error) {
    handleError('get_privacy_policy', error);
  }
}

async function get_return_policy(cmsIdentifier = 'return-policy') {
  try {
    return await getCmsPageByIdentifier(cmsIdentifier);
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