# Café Kiosk reporting overview fix

Deploy the complete replacement `kiosk-reports.js` to the existing Azure Function App.

The Overview summary query now converts the `date` parameters to `datetime2` before applying `AT TIME ZONE`. No frontend changes are required for this fix.
