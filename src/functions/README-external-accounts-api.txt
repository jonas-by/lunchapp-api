Cafe Kiosk external accounts API

CRUD:
GET    /api/kiosk/external-accounts
GET    /api/kiosk/external-accounts?includeInactive=true
GET    /api/kiosk/external-accounts?accountMode=Prepaid
GET    /api/kiosk/external-accounts/{id}
POST   /api/kiosk/external-accounts
PUT    /api/kiosk/external-accounts/{id}
DELETE /api/kiosk/external-accounts/{id}

Ledger:
GET    /api/kiosk/external-accounts/{id}/ledger
GET    /api/kiosk/external-accounts/{id}/ledger?dateFrom=2026-10-01&dateTo=2026-10-31&limit=200
POST   /api/kiosk/external-accounts/{id}/deposit
POST   /api/kiosk/external-accounts/{id}/payment
POST   /api/kiosk/external-accounts/{id}/adjustment

Create prepaid account:
{
  "displayName": "Supplier visitors",
  "companyName": "Supplier Oy",
  "accountMode": "Prepaid",
  "externalReference": "SUP-001",
  "contactName": "Contact Person",
  "contactEmail": "contact@example.com",
  "isActive": true,
  "validFrom": "2026-10-01",
  "validUntil": "2026-12-31",
  "openingBalanceCents": 5000,
  "createdBy": "Kitchen"
}

Create invoice account:
{
  "displayName": "Leasing workers",
  "companyName": "Leasing Company Oy",
  "accountMode": "Invoice",
  "invoiceReference": "PO-12345",
  "creditLimitCents": 50000,
  "isActive": true
}

Deposit:
{
  "amountCents": 2000,
  "createdBy": "Kitchen",
  "description": "Cash prepayment",
  "settlementReference": "RECEIPT-1001"
}

Payment:
{
  "amountCents": 5000,
  "createdBy": "FINA",
  "description": "Post-payment received",
  "settlementReference": "BANK-2026-1001",
  "invoiceNumber": "INV-1001"
}

Adjustment or credit:
{
  "entryType": "Adjustment",
  "amountCents": -250,
  "createdBy": "Kitchen",
  "description": "Corrected accidental over-credit",
  "settlementReference": "ADJ-1001"
}

Sign convention:
Positive values add value or reduce debt.
Negative values consume value or increase debt.
