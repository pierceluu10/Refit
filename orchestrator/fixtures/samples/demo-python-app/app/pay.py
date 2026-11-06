# Illustrative fixture code.
import stripe


def charge(amount, token):
    return stripe.Charge.create(amount=amount, currency="usd", source=token)
