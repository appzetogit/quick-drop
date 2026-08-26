import { sendResponse } from '../../../../utils/response.js';
import {
    createPrescriptionOrder,
    fillPrescriptionOrder,
} from '../services/prescriptionOrder.service.js';

/** Customer: place an order from a photographed prescription. */
export async function createPrescriptionOrderController(req, res, next) {
    try {
        const order = await createPrescriptionOrder(req.user?.userId, req.body || {});
        return sendResponse(res, 201, 'Prescription sent to the pharmacy', { order });
    } catch (err) {
        next(err);
    }
}

/** Pharmacist: enter what will be dispensed, which prices the order. */
export async function fillPrescriptionOrderController(req, res, next) {
    try {
        const order = await fillPrescriptionOrder(
            req.params.orderId,
            req.user?.userId,
            req.body || {},
        );
        return sendResponse(res, 200, 'Order priced', { order });
    } catch (err) {
        next(err);
    }
}
