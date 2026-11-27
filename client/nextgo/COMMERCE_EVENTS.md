# NextGo commerce event contract

Send currency amounts as numbers in major units, for example `129.99`, and use one ISO 4217 currency code per store.

```js
NextGo.commerce.productViewed({
  productId: "sku-104", productName: "Everyday Backpack", category: "Bags",
  price: 79.00, currency: "USD"
});

NextGo.commerce.addedToCart({
  productId: "sku-104", productName: "Everyday Backpack",
  quantity: 1, price: 79.00, cartValue: 79.00, currency: "USD"
});

NextGo.commerce.checkoutStarted({
  cartId: "cart-8fe2", itemCount: 2, cartValue: 128.00, currency: "USD"
});

NextGo.commerce.purchaseCompleted({
  orderId: "order-1842", revenue: 128.00, currency: "USD", itemCount: 2
});
```

Supported canonical events are `product_viewed`, `added_to_cart`, `removed_from_cart`, `cart_viewed`, `checkout_started`, `checkout_step_completed`, and `purchase_completed`.

Cart abandonment means a session emitted `added_to_cart` but did not emit `purchase_completed` within the selected reporting range. Checkout abandonment means it emitted `checkout_started` but not `purchase_completed`. These are behavioral estimates, not proof that a person intended to buy. For more accurate cross-session recovery, call `NextGo.identify` only after explicit identified consent.

Do not send names, email addresses, phone numbers, postal addresses, payment data or authentication credentials inside commerce properties. Use stable product, cart and order identifiers instead.
