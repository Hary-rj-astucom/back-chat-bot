// import ShippingboApiService from '../services/ShippingboApiService.js';
// const shippingbo = new ShippingboApiService();
// const result = await shippingbo.getOrderByReference('2000871243');
// console.dir(result);


const fs = require('fs');
const { list_searchable_attributes } = require('../services/MagentoApiService');
list_searchable_attributes()
    .then(result => {
        fs.writeFileSync(
            'searchable_attributes.txt',
            JSON.stringify(result, null, 2),
            'utf8'
        );
        console.log('Résultat enregistré dans searchable_attributes.txt');
    })
    .catch(console.error);

// import {callPrestaShopAPI} from '../services/PrestashopApiService.js';
// const url = `https://www.digiparf.com/api/product_features?output_format=JSON`;
// const data = await callPrestaShopAPI(url);
// console.log(data.product_features.map(f => ({ id: f.id, name: f.name })));