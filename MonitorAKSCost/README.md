# Monitor AKS Cost

Minimal MERN style split (React client + Express server) to view approximate AKS related subscription usage items using Azure Consumption API.

## Run
1. In `server` set env vars or use form: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
2. Install deps:
```
cd MonitorAKSCost/server && npm install
cd ../client && npm install
```
3. Start:
```
cd MonitorAKSCost/server && npm start
cd MonitorAKSCost/client && npm start
```

## Endpoints
- POST `/api/auth`  body: { clientId, clientSecret, tenantId, subscriptionId }
- GET  `/api/costs?days=30` aggregated usage lines (simple grouping)

## Notes
- This uses usageDetails (raw line items). Real AKS cost attribution may need filtering to AKS resource group or tags.
- Enhance by adding: Daily trend, namespace cost (needs Azure Monitor / Prometheus metrics), export to CSV.
