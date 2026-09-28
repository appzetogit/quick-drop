import assert from 'node:assert/strict';
import mongoose from 'mongoose';
const { fillAddressLocality } = await import('../src/modules/quickCommerce/modules/food/shared/geo.utils.js');
const { reviewPrescription } = await import('../src/modules/quickCommerce/modules/food/shared/prescriptionRules.js');
const r = { location: { city: 'Indore', state: 'Madhya Pradesh' } };
assert.deepEqual([fillAddressLocality({ city: null, state: '' }, r).city, fillAddressLocality({ city: null, state: '' }, r).state], ['Indore', 'Madhya Pradesh']);
assert.equal(fillAddressLocality({ city: 'Bhopal', state: 'MP' }, r).city, 'Bhopal');
assert.equal(fillAddressLocality({ area: 'Vijay Nagar' }, r).city, 'Vijay Nagar');
// review on a real subdocument keeps bill/packet
const S = new mongoose.Schema({ prescription: { required: Boolean, status: String, bill: { status: String, amount: Number }, packet: { note: String } } });
const M = mongoose.model('RxT', S);
const doc = new M({ prescription: { required: true, status: 'pending', bill: { status: 'none', amount: 0 }, packet: { note: '' } } });
const out = reviewPrescription(doc, 'approved', {});
assert.equal(out.status, 'approved');
assert.equal(out.bill.status, 'none');
doc.prescription = out;
assert.equal(doc.validateSync(), undefined);
console.log('rx + address checks passed');
