Cafe Kiosk API package

Files:
- kiosk-products.js
- kiosk-card-login.js
- kiosk-cards.js

Routes:
GET    /api/kiosk/products
GET    /api/kiosk/products?includeInactive=true
GET    /api/kiosk/products/{id}
POST   /api/kiosk/products
PUT    /api/kiosk/products/{id}
DELETE /api/kiosk/products/{id}

POST   /api/kiosk/card-login

GET    /api/kiosk/cards
GET    /api/kiosk/cards?includeInactive=true
GET    /api/kiosk/cards/{id}
POST   /api/kiosk/cards
PUT    /api/kiosk/cards/{id}
DELETE /api/kiosk/cards/{id}

Product POST/PUT example:
{
  "nameEn": "Cinnamon bun",
  "nameSv": "Kanelbulle",
  "nameFi": "Korvapuusti",
  "priceCents": 250,
  "imageUrl": null,
  "icon": "🥐",
  "isActive": true,
  "sortOrder": 10
}

Employee card POST/PUT example:
{
  "cardNumber": "10435",
  "ownerType": "Employee",
  "employeeNo": 10435,
  "isActive": true,
  "validFrom": null,
  "validUntil": null
}

External card POST/PUT example:
{
  "cardNumber": "90017",
  "ownerType": "External",
  "externalAccountId": 8,
  "displayNameOverride": "Supplier visitor card",
  "isActive": true,
  "validFrom": "2026-10-01T00:00:00Z",
  "validUntil": "2026-12-31T23:59:59Z"
}

Card login example:
{
  "cardNumber": "90017"
}
