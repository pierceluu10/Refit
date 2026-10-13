# Charges

## charges

PaymentIntent.charges was removed from paymentIntents.retrieve responses. Charge history is no longer embedded on the PaymentIntent. Use the Charges list endpoint filtered by payment_intent and iterate every page. The latest_charge field is one charge reference and does not replace the charges collection.
