# Lunch App Build Log

## 25 September 2026

### Starting point

The Lunch App already existed as a browser-based proof of concept. The frontend was hosted in Azure Static Web Apps and connected to GitHub, but the application did not yet have a persistent Azure backend.

### Git and frontend deployment verified

- Git identity was configured locally.
- A small change to `index.html` was committed and pushed.
- Azure Static Web Apps deployed the updated frontend successfully.
- The frontend deployment pipeline was therefore proven before backend work began.

### Azure SQL provisioned

Created in resource group `lunchapp`:

```text
Logical SQL server: lunchappsql
Development database: lunchappdb-dev
Region: Sweden Central
Tier: Free, General Purpose, Serverless, Gen5, 2 vCores
Free allowance: 100,000 vCore-seconds per month
Maximum data size: 32 GB
Overage billing: Disabled
```

The database was configured with a public endpoint for the development phase. The current client IP and Azure services were allowed through the SQL firewall.

### Initial database schema created

The initial development schema contains:

```text
Balances
DayMeals
Employees
KioskProducts
KioskTransactions
Meals
MenuDays
MenuWeeks
Orders
```

Primary keys, defaults, and foreign keys were added. A missing relationship from `Orders.OrderedMealID` to `Meals.MealID` was detected and added as `FK_Orders_Meals`.

The reusable schema was exported to:

```text
database/001_create_tables.sql
```

The reusable script contains table definitions rather than a hard-coded `CREATE DATABASE lunchappdb-dev` statement, so it can later be run against a production database.

### SQL connection verified

SSMS connected successfully to:

```text
lunchappsql.database.windows.net
```

A test employee was inserted and queried:

```text
EmployeeNo: 12345
FirstName: Jonas
LastName: Westerlund
Active: true
```

### Azure Function App provisioned

Created in resource group `lunchapp`:

```text
Function App: lunchapp-api-dev
Region: Sweden Central
Runtime: Node.js
Hosting: Serverless consumption-based plan
Public access: Enabled
Virtual network integration: Disabled
Basic authentication for publishing: Disabled
Application Insights: Enabled
```

Azure created supporting storage resources for the Function App.

### Local API project created

Local project:

```text
C:\lunchapp\lunchapp-api
```

Installed and configured:

- Node.js and npm
- Azure Functions Core Tools v4
- Azure CLI
- VS Code Azure Functions extension
- VS Code Azure Resources extension

The project was created using the Node.js v4 programming model.

### First function deployed

A basic `hello` HTTP function was tested locally and then published to the Azure Function App.

This proved:

```text
Browser -> Azure Function App
```

### Employees API implemented

The `mssql` Node.js package was installed.

A new endpoint was created:

```text
GET /api/employees
```

The endpoint uses:

```text
process.env.SqlConnectionString
```

Local SQL configuration is stored in `local.settings.json`, which is excluded from Git. The production development setting was added to the Function App environment variables.

A password typo initially caused the SQL connection to fail. After correction, the endpoint returned the test employee successfully.

This proved:

```text
Browser -> Azure Function App -> Azure SQL Database
```

### Frontend-to-API integration proven

A diagnostic page named `test-employees.html` was added to the frontend repository.

The first call failed due to CORS. The deployed Static Web App origin was added to the Function App CORS configuration without a trailing slash:

```text
https://black-bay-0c822f703.3.azurestaticapps.net
```

The deployed test page successfully fetched employee data from the API.

This proved the complete path:

```text
Azure Static Web App
    -> Azure Function App
    -> Azure SQL Database
    -> JSON response
    -> Browser rendering
```

### Git repositories

Current local structure:

```text
C:\lunchapp
├── lunchappDEV      Frontend repository
└── lunchapp-api     Backend repository
```

Both repositories have been initialized, committed, connected to GitHub, and pushed.

### Current status

Proven and working:

- Git-based frontend deployment
- Azure Static Web Apps hosting
- Azure SQL Serverless database
- SSMS administration
- Version-controlled database schema
- Azure Functions local development
- Manual Function App publishing
- Function App environment variables
- API access to Azure SQL
- CORS-restricted frontend access
- End-to-end frontend/API/database communication

### Next planned work

1. Implement `GET /api/meals`.
2. Implement `GET /api/kioskproducts`.
3. Replace local frontend meal data with API data.
4. Replace local kiosk product data with API data.
5. Design individual employee and card lookup endpoints.
6. Design write endpoints for orders and kiosk transactions.
7. Add authentication, authorization, validation, and restricted database access before production rollout.
