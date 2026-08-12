import { sendResponse, sendError } from '../../../../utils/response.js';
import { FoodRestaurantWithdrawal } from '../models/foodRestaurantWithdrawal.model.js';
import { getRestaurantWithdrawalSettings } from '../../admin/services/admin.service.js';
import { getRestaurantFinance } from '../services/restaurantFinance.service.js';

export const createWithdrawalRequestController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const { amount, bankDetails } = req.body;
        const parsedAmount = Number(amount);

        if (!restaurantId) return sendError(res, 401, 'Restaurant authentication required');
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return sendError(res, 400, 'Invalid withdrawal amount');

        const finance = await getRestaurantFinance(restaurantId);
        const totalEarnings = Number(finance?.currentCycle?.netAvailable ?? finance?.currentCycle?.estimatedPayout ?? 0);
        const withdrawalSettings = await getRestaurantWithdrawalSettings();
        const minimumWithdrawalAmount = Number(withdrawalSettings?.minimumWithdrawalAmount) || 0;

        if (parsedAmount < minimumWithdrawalAmount) {
            return sendError(res, 400, `Minimum withdrawal amount is Rs ${minimumWithdrawalAmount.toLocaleString('en-IN')}`);
        }

        if (parsedAmount > totalEarnings) {
            return sendError(res, 400, `Insufficient balance. Available to withdraw: Rs ${totalEarnings.toLocaleString('en-IN')}`);
        }

        const withdrawal = new FoodRestaurantWithdrawal({
            restaurantId,
            amount: parsedAmount,
            bankDetails,
            status: 'pending'
        });

        await withdrawal.save();

        return sendResponse(res, 201, 'Withdrawal request submitted successfully', withdrawal);
    } catch (error) {
        next(error);
    }
};

export const listMyWithdrawalsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!restaurantId) return sendError(res, 401, 'Restaurant authentication required');

        const withdrawals = await FoodRestaurantWithdrawal.find({ restaurantId })
            .sort({ createdAt: -1 })
            .lean();

        return sendResponse(res, 200, 'Withdrawals fetched successfully', withdrawals);
    } catch (error) {
        next(error);
    }
};
