import ShippingboApiService from '../services/ShippingboApiService.js';

const shippingbo = new ShippingboApiService();

const result = await shippingbo.getOrderByReference('2000871243');

console.dir(result);