# LunchApp API Documentation (Draft v1)

## Overview
This documentation covers the Azure Function APIs currently provided by LunchApp and Café Kiosk.

Endpoint count documented: 22

## Core Lunch APIs

### hello.js
Purpose: Health/test endpoint used for deployment verification.

### current-menu.js
Purpose: Returns the menu currently active for ordering.
Consumers: User frontend, lunch kiosk.

### meals.js
Methods: GET, POST, PUT, DELETE
Purpose: Meal catalogue management.
Features:
- Meal CRUD
- Category validation (Main, Vegetarian, Soup, Salad, Dessert)
- Soft delete by default
- Hard delete protection when referenced by menus or orders
Tables: Meals, DayMeals, Orders, GuestOrders

### menu-cycles.js
Methods: GET, POST, PUT
Purpose: Rotation menu cycle administration.
Features:
- Creates menu cycle structure
- Auto-creates weeks and weekdays
- Publishing validation
- Prevents duplicate start dates
Tables: MenuCycles, MenuWeeks, MenuDays, DayMeals

### menu-week.js
Methods: GET, PUT
Purpose: Configure meals for a specific week inside a menu cycle.
Features:
- Assign meals to weekdays
- Prevent archived meals from being used
- Transactional updates
Tables: MenuCycles, MenuWeeks, MenuDays, DayMeals, Meals

### orders.js
Methods: GET, PUT
Purpose: Employee lunch orders.
Features:
- Returns active orders only
- Cancellation-aware calculations
- Range replacement logic
Tables: Orders, Employees, Meals, OrderCancellations

### guest-orders.js
Purpose: Guest lunch ordering linked to host employees.

### salads.js
Methods: GET, POST, PUT, DELETE
Purpose: Salad master data administration.
Features: Soft-delete model preserving history.
Table: Salads

### salad-orders.js
Methods: GET, PUT
Purpose: Employee salad ordering.
Tables: SaladOrders, Salads

### guest-salad-orders.js
Purpose: Guest salad orders.

## Kitchen APIs

### kitchen-orders.js
Purpose: Kitchen production view for lunch orders.

### kitchen-order-cancellations.js
Purpose: Employee lunch cancellation reporting.

### kitchen-salad-order-cancellations.js
Purpose: Salad cancellation reporting.

### kitchen-weekly-summary.js
Purpose: Weekly kitchen totals and forecasting.

## Employee Administration

### employees.js
Purpose: Employee directory maintenance.
Consumers: Admin UI, ordering APIs.

## Café Kiosk APIs

### kiosk-card-login.js
Purpose: Card authentication.
Features:
- Employee card lookup
- External account card lookup
- Card number normalization support
Returns owner type information consumed by kiosk frontends.

### kiosk-products.js
Purpose: Product catalogue administration.

### kiosk-layouts.js
Purpose: Store kiosk layouts created by layout builder.

### kiosk-cards.js
Purpose: Card management and card assignments.

### kiosk-external-accounts.js
Purpose: External customer account management.

### kiosk-sales.js
Purpose: Transaction processing and sales recording.

### kiosk-reports.js
Purpose: Reporting, exports, KPI summaries and period statistics.

## Security Observations

Current state:
- All reviewed Azure Functions use authLevel: anonymous.
- Security currently relies on application logic rather than Azure Function authentication.
- Suitable for internal pilot/testing only.

Recommended future state:
- Entra ID protection for admin functions
- Role-based authorization
- Separate kiosk authentication flow
- API authorization validation server-side

## Architecture Summary

Lunch Domain:
Employees -> Orders -> Kitchen Reports
Employees -> Salad Orders -> Kitchen Reports
Menu Cycles -> Menu Weeks -> Menu Days -> Meals

Café Domain:
Cards -> Employees/External Accounts -> Sales -> Reports
Products -> Layouts -> Kiosk Frontend

## Documentation Status
Batch 1 and Batch 2 reviewed.
This draft serves as a functional API inventory and architecture reference.
