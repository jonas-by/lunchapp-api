# Lunch App API

## Purpose

This repository contains the Azure Functions backend for the Lunch App.

The API provides the controlled layer between the browser-based frontend and Azure SQL Database.

## Local path

```text
C:\lunchapp\lunchapp-api
```

## Azure resources

| Setting | Value |
|---|---|
| Resource group | `lunchapp` |
| Function App | `lunchapp-api-dev` |
| Region | Sweden Central |
| Hosting | Serverless consumption-based plan |
| Runtime | Node.js / Azure Functions v4 programming model |
| Monitoring | Application Insights enabled |
| SQL server | `lunchappsql.database.windows.net` |
| Development database | `lunchappdb-dev` |

## Current endpoint

```text
GET /api/employees
```

Azure URL:

```text
https://lunchapp-api-dev-bxf8hff5hmb7g5dv.swedencentral-01.azurewebsites.net/api/employees
```

The endpoint reads `dbo.Employees` and returns JSON.

## Local development

Install dependencies:

```powershell
npm install
```

Start the Functions host:

```powershell
func start
```

Local endpoints are normally available under:

```text
http://localhost:7071/api
```

## Configuration

Local configuration belongs in:

```text
local.settings.json
```

The file is excluded by `.gitignore` and must never be committed.

Required setting:

```text
SqlConnectionString
```

The Azure Function App has the same setting under:

```text
Function App
  -> Settings
  -> Environment variables
  -> App settings
```

Code reads it using:

```javascript
process.env.SqlConnectionString
```

## Deployment

Manual deployment currently works with:

```powershell
func azure functionapp publish lunchapp-api-dev
```

The source code is also stored in GitHub. Automatic API deployment can be added later after the local-to-Azure path remains stable.

## CORS

Allowed frontend origin:

```text
https://black-bay-0c822f703.3.azurestaticapps.net
```

Do not use `*` in production unless the API is intentionally public to every website.

## Current project conventions

- Use the Azure Functions Node.js v4 programming model.
- Register HTTP functions with `app.http(...)`.
- Return JSON with `jsonBody`.
- Keep database credentials in environment variables.
- Keep SQL access in the backend, never in the frontend.
- Test locally before publishing to Azure.

## Planned endpoints

Suggested sequence:

```text
GET  /api/meals
GET  /api/kioskproducts
GET  /api/employees/{employeeNo}
GET  /api/employees/card/{cardNumber}
GET  /api/menu/{date-or-week}
POST /api/orders
GET  /api/orders/{employeeNo}
POST /api/kiosktransactions
GET  /api/balances/{employeeNo}
```

Endpoint names and request models should be finalized before production use.

## Security improvements before production

1. Replace SQL administrator credentials with a restricted application identity.
2. Prefer managed identity for Azure SQL access if practical.
3. Add authentication and authorization for administrative endpoints.
4. Validate all request bodies and route parameters.
5. Avoid returning internal exception details to clients.
6. Add structured logging and request correlation.
7. Restrict CORS to approved frontend origins.
8. Review public network access and private networking requirements.
