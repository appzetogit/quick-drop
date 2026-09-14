import { sendResponse } from '../../../../utils/response.js';
import {
    listPrescriptionOrders,
    getPrescriptionOrder,
    getPrescriptionOrderCounts,
} from '../services/prescriptionAdmin.service.js';

export async function listPrescriptionOrdersController(req, res, next) {
    try {
        const data = await listPrescriptionOrders(req.query || {});
        return sendResponse(res, 200, 'Prescription orders retrieved', data);
    } catch (error) {
        next(error);
    }
}

export async function getPrescriptionOrderCountsController(req, res, next) {
    try {
        const data = await getPrescriptionOrderCounts(req.query || {});
        return sendResponse(res, 200, 'Prescription counts retrieved', data);
    } catch (error) {
        next(error);
    }
}

export async function getPrescriptionOrderController(req, res, next) {
    try {
        const data = await getPrescriptionOrder(req.params.orderId);
        return sendResponse(res, 200, 'Prescription order retrieved', data);
    } catch (error) {
        next(error);
    }
}
