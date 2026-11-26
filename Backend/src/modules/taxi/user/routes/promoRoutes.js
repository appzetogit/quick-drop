import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticateOrResolveUser } from '../../middlewares/authMiddleware.js';
import { getAvailablePromos, getUnusedPromos, validatePromo } from '../controllers/promoController.js';

export const promoRouter = Router();

promoRouter.post('/validate', authenticateOrResolveUser(['user']), asyncHandler(validatePromo));
promoRouter.get('/available', authenticateOrResolveUser(['user']), asyncHandler(getAvailablePromos));
// Per-user unused coupons for the home-screen nudge (location optional).
promoRouter.get('/unused', authenticateOrResolveUser(['user']), asyncHandler(getUnusedPromos));
