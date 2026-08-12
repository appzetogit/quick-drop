const express = require('express');
const router = express.Router();
const WorkerSubscriptionPlan = require('../../models/WorkerSubscriptionPlan');
const Worker = require('../../models/Worker');
const { authenticate } = require('../../middleware/authMiddleware');
const { isWorker } = require('../../middleware/roleMiddleware');
const { createSubscriptionOrder, verifySubscriptionPayment } = require('../../controllers/paymentControllers/subscriptionPaymentController');

// POST /api/workers/subscription/create-order → Create Razorpay order
router.post('/create-order', authenticate, isWorker, createSubscriptionOrder);

// POST /api/workers/subscription/verify-payment → Verify & activate
router.post('/verify-payment', authenticate, isWorker, verifySubscriptionPayment);

/**
 * GET /api/workers/subscription/plans
 * Fetch all active subscription plans (for workers to browse & buy)
 */
router.get('/plans', authenticate, isWorker, async (req, res) => {
  try {
    const plans = await WorkerSubscriptionPlan.find({ isActive: true }).sort({ price: 1 });
    res.status(200).json({ success: true, data: plans });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * GET /api/workers/subscription/status
 * Get current worker's subscription status
 */
router.get('/status', authenticate, isWorker, async (req, res) => {
  try {
    const worker = await Worker.findById(req.user.id).select('subscription wallet').lean();
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const isActive = worker.subscription?.isActive &&
      worker.subscription?.expiryDate &&
      new Date(worker.subscription.expiryDate) > new Date();

    res.status(200).json({
      success: true,
      data: {
        isActive,
        expiryDate: worker.subscription?.expiryDate || null,
        planName: worker.subscription?.planName || null,
        walletBalance: worker.wallet?.balance || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * POST /api/workers/subscription/activate
 * Admin can manually activate a plan for a worker (or after Razorpay webhook)
 */
router.post('/activate', authenticate, isWorker, async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = await WorkerSubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, message: 'Plan not found or inactive' });
    }

    const worker = await Worker.findById(req.user.id);
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    // Calculate new expiry
    const now = new Date();
    // If subscription still active, extend from current expiry; else from now
    const baseDate = (worker.subscription?.isActive && worker.subscription?.expiryDate &&
      new Date(worker.subscription.expiryDate) > now)
      ? new Date(worker.subscription.expiryDate)
      : now;

    const expiryDate = new Date(baseDate);
    expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

    worker.subscription = {
      isActive: true,
      planId: plan._id,
      planName: plan.title,
      startDate: now,
      expiryDate,
      durationDays: plan.durationDays
    };

    await worker.save();

    res.status(200).json({
      success: true,
      message: `Subscription activated! Valid until ${expiryDate.toLocaleDateString('en-IN')}`,
      data: {
        planName: plan.title,
        expiryDate,
        durationDays: plan.durationDays
      }
    });
  } catch (error) {
    console.error('[Subscription] Activate error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

module.exports = router;
