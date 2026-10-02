# Café Kiosk Reporting API

## Deploy

Deploy `kiosk-reports.js` to the existing Azure Function App.

The first version uses `authLevel: anonymous` to match the current API project. Before exposing payroll or invoicing reports outside the current controlled development environment, protect the reporting routes with Microsoft Entra ID and role-based access.

## Endpoints

```text
GET /api/kiosk/reports/overview
GET /api/kiosk/reports/transactions
GET /api/kiosk/reports/payroll
GET /api/kiosk/reports/external-invoicing
GET /api/kiosk/reports/export
```

## Common parameters

```text
from=2026-09-01
&to=2026-09-30
```

Dates are Finnish local calendar dates. The API converts stored UTC sale timestamps using SQL Server's `FLE Standard Time` zone.

The default period is the current calendar month through today. Maximum range is 370 days.

## Overview

```text
GET /api/kiosk/reports/overview?from=2026-09-01&to=2026-09-30&groupBy=week
```

`groupBy` supports `day`, `week`, and `month`.

Returns summary totals, employee/external split, trend points, and top 20 products.

## Transactions

```text
GET /api/kiosk/reports/transactions?from=2026-09-01&to=2026-09-30&page=1&pageSize=50
```

Optional filters:

```text
ownerType=employee|external
status=Completed|Voided
```

Maximum page size is 200. Sale lines are included in each row.

## Payroll

```text
GET /api/kiosk/reports/payroll?from=2026-09-01&to=2026-09-30
```

Returns one row per employee with employee number, name, transaction count, and total cents. Only completed employee sales are included.

## External invoicing

```text
GET /api/kiosk/reports/external-invoicing?from=2026-09-01&to=2026-09-30
```

The default account mode is `Invoice`.

Optional examples:

```text
accountMode=Invoice
accountMode=Postpaid
accountMode=Invoice,Postpaid
```

The current schema supplies external account ID, display name, company name, account mode, transaction count, and total. Business ID, billing address, billing email, and billing reference are intentionally not queried until those columns are added to `dbo.ExternalAccounts`.

## CSV exports

```text
GET /api/kiosk/reports/export?type=payroll&from=2026-09-01&to=2026-09-30
GET /api/kiosk/reports/export?type=external-summary&from=2026-09-01&to=2026-09-30
GET /api/kiosk/reports/export?type=external-details&from=2026-09-01&to=2026-09-30
```

CSV format:

- UTF-8 with BOM
- Semicolon delimiter
- Quoted cells
- CRLF row endings
- Decimal comma
- `yyyy-MM-dd` periods

This is intended to behave sensibly in Finnish Excel and FINA's CSV workflow.

## Scheduling

Scheduling is deliberately not included in the first API package. The next stage should extract the report queries into a shared service and call that service from both this HTTP Function and weekly/monthly Timer Trigger Functions. Validate report totals first, then automate delivery.
