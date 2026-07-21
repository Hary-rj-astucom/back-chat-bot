require('dotenv').config();
const axios = require("axios");
const fs = require('fs').promises;
const path = require('path');

class ShippingboApiService {
  constructor() {

    this.clientId = process.env.SHIPPINGBO_CLIENTID;
    this.clientSecret = process.env.SHIPPINGBO_CLIENT_SECRET;
    this.redirectUri = process.env.SHIPPINGBO_REDIRECT_URI;

    this.authUrl = process.env.SHIPPINGBO_AUTH_URL;
    this.tokenUrl = process.env.SHIPPINGBO_TOKEN_URL;
    this.apiUrl = process.env.SHIPPINGBO_API_URL;

    this.x_api_app_id = process.env.SHIPPINGBO_X_API_APP_ID;
    this.x_api_version = process.env.SHIPPINGBO_X_API_VERSION;

    this.accessToken = null;
    this.refreshToken = null;
  }

  /**
   * Étape 1 : Générer l’URL d’authentification
   */
  getAuthUrl(scope = "read write") {
    return `${this.authUrl}?response_type=code&client_id=${
      this.clientId
    }&redirect_uri=${encodeURIComponent(this.redirectUri)}&scope=${scope}`;
  }

  // 2️⃣ Callback OAuth
  async callback (code){

    if (!code) {
      throw new Error("❌ Aucun code reçu dans la redirection.")
    }

    try {

      console.log("code: ", code);      
      
      const tokenData = await this.getAccessToken(code);

      console.log("accessToken : ", this.accessToken);
      console.log("refreshToken: ", this.refreshToken);

      return tokenData;
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * Étape 2 : Échanger un code contre un token
   */
  async getAccessToken(authCode) {
    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code: authCode,
        },
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;

      // write the data in the JSON 
      const filePath = path.join(__dirname, 'json_mock/shippingbo_token.json');
      data.access_token = response.data.access_token;
      data.refresh_token = response.data.refresh_token;
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Étape 3 : Rafraîchir le token si expiré
   */
  async refreshAccessToken() {

    const filePath = path.join(__dirname, 'json_mock/shippingbo_token.json');

    // get data in the JSON
    const jsonString = await fs.readFile(filePath, 'utf8');
    let data = JSON.parse(jsonString);

    console.log("old_token :", data);

    if (!data.refresh_token) {
      throw new Error("⚠️ Aucun refresh_token disponible");
    }

    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          grant_type: "refresh_token",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: data.refresh_token,
        },
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;

      console.log("new_token :", response.data);

      // update the data in the JSON
      data.access_token = response.data.access_token;
      data.refresh_token = response.data.refresh_token;
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Méthode générique pour appeler l’API Shippingbo
   */
  async request(endpoint, method = "GET", data = null) {

    await this.refreshAccessToken();

    if (!this.accessToken) {
      throw new Error("⚠️ Pas de token. Appelez getAccessToken() d'abord.");
    }

    console.log(`${this.apiUrl}${endpoint}`);

    try {
      const response = await axios({
        method,
        url: `${this.apiUrl}${endpoint}`,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
          'X-API-APP-ID': this.x_api_app_id,
          'X-API-VERSION': this.x_api_version
        },
        data,
      });

      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }


  // -------------------------------------------------------------------------------- //

  /**
   * Exemple : récupérer une commande par référence
   */
  async getOrderByReference(reference) {
    const result = await this.request(`/orders?search[origin_ref__eq][]=${encodeURIComponent(reference)}`);
    console.info("consultation shippingbo");
    if(result.orders.length > 0){
        return this.request(`/orders/${result.orders[0].id}`);
    }else{
        return [];
    }
  }

  /**
   * Exemple : récupérer une commande par ID
   */
  async getOrderById(orderId) {
    return this.request(`/orders/${orderId}`);
  }

  /**
   * Gestion des erreurs API
   */
  handleError(error) {
    if (error.response) {
      console.error("❌ API error:", error.response.data);
      throw error;
    } else {
      console.error("❌ Request error:", error.message);
      throw error;
    }
  }
}

module.exports = ShippingboApiService;