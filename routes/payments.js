const { ObjectId } = require('mongodb');
const Stripe = require('stripe');
const STRIPE_SECKET = process.env.STRIPE_SECRET_KEY
const stripe = Stripe(STRIPE_SECKET);

module.exports = (usersCollection, paymentsCollection) => {
  const express = require('express');
  const router = express.Router();

  // Create payment intent
  router.post('/create-payment-intent', async (req, res) => {
    try {
      const { plan, billingCycle, amount, userId, userEmail } = req.body;

      // Validate required fields
      if (!plan || !billingCycle || !amount || !userId) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Convert amount to cents (Stripe uses smallest currency unit)
      const amountInCents = Math.round(amount * 100);

      // Create payment intent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: 'usd',
        metadata: {
          plan: plan,
          billingCycle: billingCycle,
          userId: userId,
          userEmail: userEmail
        }
      });

      // Store payment record in database (pending status)
      const paymentRecord = {
        userId: userId,
        userEmail: userEmail,
        plan: plan,
        billingCycle: billingCycle,
        amount: amount,
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await paymentsCollection.insertOne(paymentRecord);

      res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });

    } catch (error) {
      console.error('Error creating payment intent:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create payment intent',
        error: error.message
      });
    }
  });

  // Confirm payment and update user package
  router.post('/confirm-payment', async (req, res) => {
    try {
      const { paymentIntentId, userId, plan } = req.body;

      if (!paymentIntentId || !userId || !plan) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Verify payment with Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({
          success: false,
          message: 'Payment not successful'
        });
      }

      // Update payment record status
      const paymentUpdate = await paymentsCollection.updateOne(
        { stripePaymentIntentId: paymentIntentId },
        {
          $set: {
            status: 'completed',
            updatedAt: new Date(),
            completedAt: new Date()
          }
        }
      );

      if (paymentUpdate.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Payment record not found'
        });
      }

      // Calculate package expiry date
      const billingCycle = paymentIntent.metadata.billingCycle;
      const expiryDate = new Date();
      if (billingCycle === 'monthly') {
        expiryDate.setMonth(expiryDate.getMonth() + 1);
      } else {
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      }

      // Update user package
      const userUpdate = await usersCollection.updateOne(
        { uid: userId },
        {
          $set: {
            package: plan.toLowerCase(),
            packageExpiry: expiryDate,
            updatedAt: new Date()
          }
        }
      );

      if (userUpdate.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Get updated user data
      const updatedUser = await usersCollection.findOne({ uid: userId });

      res.json({
        success: true,
        message: 'Payment confirmed and user package updated',
        user: updatedUser,
        package: plan.toLowerCase(),
        expiryDate: expiryDate
      });

    } catch (error) {
      console.error('Error confirming payment:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to confirm payment',
        error: error.message
      });
    }
  });

  // Get user payment history
  router.get('/user/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const payments = await paymentsCollection
        .find({ userId: userId })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        payments: payments,
        count: payments.length
      });

    } catch (error) {
      console.error('Error fetching payment history:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch payment history',
        error: error.message
      });
    }
  });

  // Get all payments (admin only)
  router.get('/', async (req, res) => {
    try {
      const payments = await paymentsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        payments: payments,
        count: payments.length
      });

    } catch (error) {
      console.error('Error fetching payments:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch payments',
        error: error.message
      });
    }
  });

  return router;
};