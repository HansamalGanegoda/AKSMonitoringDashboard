# Monitor AKS (MERN)

<img width="2558" height="1265" alt="Screenshot 2025-09-08 114727" src="https://github.com/user-attachments/assets/333efb5a-ce56-4d3c-ab61-e02ee9da555f" />
<img width="2557" height="1271" alt="Screenshot 2025-09-08 114739" src="https://github.com/user-attachments/assets/685f8498-a043-4313-af78-4e0620167a68" />



A MERN stack application to authenticate with Azure using a service principal and view AKS cluster health (clusters, nodes, pods, deployments).

## Features (current)
- Service Principal credential form (Client ID, Secret, Tenant, Subscription)
- List AKS clusters in subscription
- View per-cluster: nodes, deployments, pods

## Planned / Next
- Auto-refresh & polling
- Historical metrics storage (MongoDB)
- Auth hardening & secret storage via env vars
- Filtering, namespaces, pod logs, events
- Cluster metrics (CPU/memory) via Metrics API

## Prerequisites
- Node.js 18+ (using v24 OK)
- Azure AD App Registration (Client ID / Secret) with permission to read AKS
- Contributor or Reader on subscription (list clusters) + user creds for cluster access

## Run (development)
Open two terminals in project root:

Terminal 1 (server):
```
cd server
npm start
```
Terminal 2 (client):
```
cd client
npm start
```
React dev server runs at http://localhost:3000 proxied to backend http://localhost:5000.

## Environment Variables (recommended)
Instead of entering secrets each time, you can create `server/.env` later:
```
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_TENANT_ID=...
AZURE_SUBSCRIPTION_ID=...
```
(Then adjust server code to read from process.env if fields omitted.)

## Security Notes
- Do NOT commit real credentials.
- Add rate limiting and proper session management before production.

## License
MIT (add file separately if needed)


