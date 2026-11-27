# Consented no-login identification

Load the analytics SDK first, then the consent component:

```html
<script src="https://YOUR-NEXTGO-DOMAIN/nextgo.js"></script>
<script src="https://YOUR-NEXTGO-DOMAIN/nextgo-consent.js"></script>
<script>
  NextGo.init({ key: "ng_live_...", endpoint: "https://YOUR-NEXTGO-DOMAIN" });
  NextGoConsent.show({
    privacyUrl: "/privacy",
    consentVersion: "cart-recovery-v1"
  });
</script>
```

The visitor can choose personalized recovery, anonymous analytics, or reject optional tracking. Personal fields are requested only after personalized recovery is selected. At least an email address or phone number is required; name is optional.

The component records a stable random visitor ID, consent version, timestamp and purposes. It never reads payment-card data, CVV, passwords or hidden form fields. `NextGoConsent.withdraw()` stops further tracking and clears the local visitor identifier. The merchant should also call the protected privacy deletion API when a user requests erasure of already stored data.
