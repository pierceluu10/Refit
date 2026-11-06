import stripe
from flask import Flask, jsonify, request

app = Flask(__name__)


@app.post("/charge")
def charge():
    intent = stripe.PaymentIntent.create(amount=request.json["amount"], currency="eur")
    return jsonify({"id": intent["id"]})
