/**
 * Master > App Services: switching a service off stops new orders, on the
 * server, not only the tile on the app's home screen.
 *
 * 2 Nov: a Food zone was switched off at 8:22 pm and FOD-0342931 was accepted
 * in it at 9:21 pm, because nothing checked the switch when an order was placed.
 *
 * Drives the real createOrder against an in-memory Mongo.
 *
 * Run: node tests/app-service-blocks-orders.smoke.mjs
 */
import { startFoodWorld, makeChecker, thrownBy } from './food-order-fixture.mjs';

const w = await startFoodWorld('app_service_blocks');
const { check, summary } = makeChecker();
let failed = 1;

try {
    const svc = await import('../src/core/appServices/appServices.service.js');
    const items = [w.appLine(w.dish)];
    const buyer = await w.makeUser();
    const pricing = await w.quote(buyer._id, { items });
    // A real zone around the world's restaurant and customer.
    const { FoodZone } = await import('../src/modules/food/admin/models/zone.model.js');
    const zone = await FoodZone.create({
        name: 'Test Zone', country: 'India', isActive: true,
        coordinates: [
            { latitude: -80, longitude: -170 }, { latitude: -80, longitude: 170 },
            { latitude: 80, longitude: 170 }, { latitude: 80, longitude: -170 },
        ],
    });
    const zoneId = String(zone._id);
    await w.m.FoodRestaurant.updateOne({ _id: w.restaurant._id }, { $set: { zoneId: zone._id } });
    const orders = async () => w.m.FoodOrder.countDocuments({});

    console.log('\nswitched on');
    check('an order goes through', Boolean(await w.saved(await w.place(buyer._id, { items, pricing }))));

    console.log('\nswitched off for the zone, with a reason');
    await svc.setZoneEnabled('food', zoneId, false, { reason: 'Closed for Diwali' });
    svc.clearAppServicesCache();
    const before = await orders();
    const err = await thrownBy(() => w.place(buyer._id, { items, pricing }));
    check('THE BUG: the order is refused', Boolean(err), err?.message || 'accepted');
    check('with the admin\'s reason', /Closed for Diwali/.test(err?.message || ''), err?.message);
    check('and nothing is saved', (await orders()) === before);

    console.log('\nthe other services in that zone');
    check('the same zone id switched off for Food does not close Quick', (await svc.appServiceClosedReason('quick', { zoneId })) === '');

    console.log('\nswitched back on');
    await svc.setZoneEnabled('food', zoneId, true);
    svc.clearAppServicesCache();
    check('orders go through again', Boolean(await w.saved(await w.place(buyer._id, { items, pricing }))));

    console.log('\nswitched off for the whole platform');
    await svc.setServiceEnabled('food', false, {});
    svc.clearAppServicesCache();
    const all = await thrownBy(() => w.place(buyer._id, { items, pricing }));
    check('the order is refused, with a clear message', /not available/.test(all?.message || ''), all?.message || 'accepted');
    await svc.setServiceEnabled('food', true, {});
    svc.clearAppServicesCache();

    console.log('\nreading an address');
    check('GeoJSON and lat/lng addresses both give a point',
        svc.pointOfAddress({ location: { type: 'Point', coordinates: [76.5, 32.1] } })?.lat === 32.1
        && svc.pointOfAddress({ latitude: 32.1, longitude: 76.5 })?.lng === 76.5);
    check('an address with no coordinates gives none', svc.pointOfAddress({ city: 'Palampur' }) === null);

    failed = summary();
} catch (err) {
    console.log(`\n  UNCAUGHT: ${err.stack || err.message}`);
} finally {
    await w.stop();
    process.exit(failed ? 1 : 0);
}
