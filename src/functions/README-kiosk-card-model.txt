Cafe Kiosk card model

Employee cards:
- Stored only in dbo.Employees.CardNumber.
- Managed only through Employee Admin.
- Resolved directly by POST /api/kiosk/card-login.
- No employee rows are created in dbo.KioskCards.

External and temporary cards:
- Stored in dbo.KioskCards.
- Every card must reference dbo.ExternalAccounts.
- Managed through /api/kiosk/cards.

Updated routes:
POST   /api/kiosk/card-login
GET    /api/kiosk/cards
GET    /api/kiosk/cards?includeInactive=true
GET    /api/kiosk/cards/{id}
POST   /api/kiosk/cards
PUT    /api/kiosk/cards/{id}
DELETE /api/kiosk/cards/{id}

External card POST/PUT body:
{
  "cardNumber": "90017",
  "externalAccountId": 8,
  "displayNameOverride": "Supplier visitor card",
  "isActive": true,
  "validFrom": "2026-10-01T00:00:00Z",
  "validUntil": "2026-12-31T23:59:59Z"
}

ownerType and employeeNo are no longer accepted or required by the card administration API.
The API also rejects an external card number that already exists in dbo.Employees.CardNumber.
