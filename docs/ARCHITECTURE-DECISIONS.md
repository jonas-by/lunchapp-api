# Lunch App Architecture Decisions

## Decision summary

This document records the main technical choices made during the initial Azure backend build.

## 1. Separate frontend and backend repositories

### Decision

Use two repositories:

```text
lunchappDEV
lunchapp-api
```

### Reasoning

The frontend and API have different runtimes, deployment targets, dependencies, and release concerns. Separate repositories keep deployment and troubleshooting straightforward during the development phase.

### Revisit when

Consider a monorepo only if shared tooling, coordinated releases, or duplicated configuration becomes burdensome.

## 2. Azure Static Web Apps for the frontend

### Decision

Continue using Azure Static Web Apps for the browser frontend.

### Reasoning

- Existing deployment from GitHub already works.
- The application is primarily static HTML, CSS, and JavaScript.
- The service provides HTTPS and straightforward GitHub-based deployment.

## 3. Azure Functions for the API

### Decision

Use a separate Azure Function App named `lunchapp-api-dev`.

### Reasoning

- Serverless hosting fits the low and intermittent workload.
- No virtual machine or IIS maintenance is required.
- HTTP-triggered functions provide an incremental migration path from local JSON files.
- Application Insights is available for diagnostics.

## 4. Node.js and Azure Functions programming model v4

### Decision

Use Node.js with the Azure Functions v4 programming model.

### Reasoning

- The frontend already uses JavaScript.
- The programming model supports code-centric registration through `app.http(...)`.
- The development and deployment tooling works locally through VS Code and Azure Functions Core Tools.

### Important constraint

Do not mix the older `module.exports` and `function.json` v3 model with v4 functions in the same application.

## 5. Azure SQL Database, serverless free offer

### Decision

Use Azure SQL Database with the free General Purpose Serverless offer for development.

### Configuration

```text
SQL server: lunchappsql
Database: lunchappdb-dev
Region: Sweden Central
Compute: Gen5, 2 vCores, serverless
Overage billing: Disabled
```

### Reasoning

- The expected application workload is small.
- Relational data fits employees, meals, menus, orders, products, transactions, and balances.
- SQL skills and administration tools are already familiar.
- The free allowance is appropriate for development and initial testing.
- Disabling overage billing avoids surprise development costs.

## 6. One logical SQL server, separate databases

### Decision

Plan for development and production databases on the same logical SQL server initially:

```text
lunchappsql
├── lunchappdb-dev
└── lunchappdb-prod
```

### Reasoning

Serverless compute is configured per database. A shared logical server reduces administrative overhead while retaining data separation.

### Revisit when

Use separate logical servers if production requires different administrators, networking, regions, policies, security boundaries, or lifecycle management.

## 7. Keep department data out of the initial schema

### Decision

Do not add departments yet.

### Reasoning

Department data is not currently necessary for the first working backend. Adding a nullable column or normalized department table later is straightforward. The initial schema should focus on confirmed requirements.

## 8. Use an API layer between browser and SQL

### Decision

The browser must never connect directly to Azure SQL.

### Architecture

```text
Browser
    -> Azure Static Web App
    -> Azure Function App
    -> Azure SQL Database
```

### Reasoning

The API protects SQL credentials, enforces validation and authorization, centralizes business rules, and prevents arbitrary database access from browser code.

## 9. Use a connection string during development

### Decision

Store the SQL connection string in:

```text
local.settings.json
```

for local development, and in Function App environment variables for Azure.

### Reasoning

This is the simplest working configuration for the initial backend proof.

### Security boundary

- `local.settings.json` must remain excluded from Git.
- Connection strings must never be placed in frontend code.
- The current SQL administrator credential is temporary development plumbing.

### Planned improvement

Replace SQL administrator access with a restricted database principal or Function App managed identity before production.

## 10. Public endpoints during development

### Decision

Use public endpoints for the Function App and Azure SQL during development, with SQL firewall rules and Function App CORS restrictions.

### Reasoning

This avoids introducing VNet integration, private endpoints, and private DNS before the basic application architecture is proven.

### Planned improvement

Review network isolation once application requirements, on-premises integration needs, and production security expectations are known.

## 11. Restrict CORS to the deployed frontend

### Decision

Allow this origin:

```text
https://black-bay-0c822f703.3.azurestaticapps.net
```

Do not retain `*` as the production setting.

### Reasoning

Only the approved frontend should make browser-based cross-origin calls to the API.

## 12. Migrate read-only data before write operations

### Decision

Implement endpoints in this general order:

```text
Employees smoke test
Meals
Kiosk products
Employee/card lookup
Menus
Orders
Kiosk transactions
Balances
```

### Reasoning

Read-only endpoints prove data contracts and frontend integration without immediately introducing duplicate handling, validation, transactional writes, or business-critical side effects.

## 13. Keep schema changes in Git

### Decision

Store the initial schema and future changes as SQL scripts.

Suggested structure:

```text
database/
├── 001_create_tables.sql
├── 002_add_constraints_and_indexes.sql
└── 003_next_change.sql
```

### Reasoning

Version-controlled schema scripts provide reproducibility, review history, and a practical route for creating or updating the production database.

## Production readiness decision tree

```text
Is the endpoint read-only?
├── Yes
│   ├── Does it expose sensitive employee or financial data?
│   │   ├── Yes -> Add authentication and authorization first
│   │   └── No  -> Implement, validate output, restrict CORS, log failures
│   └── Cache only if actual performance data justifies it
└── No, it writes data
    ├── Define request model and validation
    ├── Define authorization rules
    ├── Define duplicate and retry behavior
    ├── Use transactions where multiple changes must succeed together
    ├── Return controlled errors without internal details
    └── Add audit fields and logging

Does the API need SQL access?
├── Development
│   └── Environment-based connection string is acceptable temporarily
└── Production
    ├── Prefer managed identity or restricted database credentials
    ├── Grant only required permissions
    └── Review SQL public access, firewall, and private networking

Does a schema change affect existing data?
├── No
│   └── Add a numbered migration script and test against dev
└── Yes
    ├── Back up or export affected data
    ├── Write forward and rollback steps
    ├── Test migration using representative data
    └── Schedule and document the production change
```
