# Café Kiosk Sales API

## Files

- `kiosk-sales.js`: Azure Functions API endpoint.

## Routes

### Create a sale

`POST /api/kiosk/sales`

```json
{
  "cardNumber": "123456",
  "createdBy": "Kiosk",
  "items": [
    { "productId": 1, "quantity": 1 },
    { "productId": 2, "quantity": 2 }
  ]
}
```

The client must not send prices or totals. The API resolves active products and prices from SQL.

### Read a sale

`GET /api/kiosk/sales/{saleId}`

## Behaviour

- Employee cards are resolved from `dbo.Employees.CardNumber`.
- External cards are resolved from `dbo.KioskCards` and linked to `dbo.ExternalAccounts`.
- Duplicate product rows in the request are combined.
- Inactive or missing products are rejected.
- Prices and totals are calculated server-side.
- Prepaid purchases require sufficient ledger balance.
- Postpaid and Invoice purchases enforce `CreditLimitCents` when a limit is present.
- Sale header, sale lines and external ledger entry are written in one serializable SQL transaction.
- `LineTotalCents` is omitted from inserts because SQL Server computes it.
- The legacy `dbo.KioskTransactions` table is not used.

## Expected ledger convention

- Deposits and payments are positive ledger amounts.
- Purchases are negative ledger amounts with `EntryType = Purchase`.

## Not included yet

- Voiding or reversing a sale.
- Recent-sales listing.
- Idempotency keys for retry-safe kiosk submissions.

Those should be added before production rollout. During initial development, avoid automatically retrying a POST after a network timeout because the first request may already have committed.
