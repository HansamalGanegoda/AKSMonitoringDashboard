require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { ClientSecretCredential } = require('@azure/identity');
const { ContainerServiceClient } = require('@azure/arm-containerservice');
const https = require('https');
const axios = require('axios');
const YAML = require('yaml');

const app = express();
app.use(bodyParser.json());

let aksCredentials = null;
let cachedClusters = [];

// Helper: obtain kube API server + token (user/admin)
async function getKubeAccess(resourceGroup, name, useAdmin) {
  const { clientId, clientSecret, tenantId, subscriptionId } = aksCredentials;
  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const client = new ContainerServiceClient(credential, subscriptionId);
  const creds = useAdmin
    ? await client.managedClusters.listClusterAdminCredentials(resourceGroup, name)
    : await client.managedClusters.listClusterUserCredentials(resourceGroup, name);
  if (!creds.kubeconfigs || !creds.kubeconfigs[0]) throw new Error('No kubeconfig returned');
  const raw = Buffer.from(creds.kubeconfigs[0].value, 'base64').toString();
  let parsed;
  try { parsed = YAML.parse(raw); } catch { /* ignore parse error */ }
  let server, token;
  if (parsed?.clusters?.[0]) server = parsed.clusters[0].cluster?.server;
  if (parsed?.users?.[0]) {
    token = parsed.users[0].user?.token || parsed.users[0].user?.['access-token'] || parsed.users[0].user?.['auth-provider']?.config?.['access-token'];
  }
  if (!server || !token) {
    const serverMatch = raw.match(/server: (.*)/);
    const tokenMatch = raw.match(/token: (.*)/);
    server = server || (serverMatch ? serverMatch[1].trim() : null);
    token = token || (tokenMatch ? tokenMatch[1].trim() : null);
  }
  if (!server || !token) throw new Error('Could not parse kubeconfig');
  return { server, token };
}

app.post('/api/auth', async (req, res) => {
  // Allow fallback to environment variables if any field omitted
  const clientId = req.body.clientId || process.env.AZURE_CLIENT_ID;
  const clientSecret = req.body.clientSecret || process.env.AZURE_CLIENT_SECRET;
  const tenantId = req.body.tenantId || process.env.AZURE_TENANT_ID;
  const subscriptionId = req.body.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID;
  if (!clientId || !clientSecret || !tenantId || !subscriptionId) {
    return res.status(400).json({ success: false, error: 'Missing credentials (provide fields or set env vars).' });
  }
  try {
    aksCredentials = { clientId, clientSecret, tenantId, subscriptionId };
    // Test credentials by listing AKS clusters
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const client = new ContainerServiceClient(credential, subscriptionId);
    const clusters = [];
    for await (const c of client.managedClusters.list()) {
      clusters.push(c);
    }
    cachedClusters = clusters;
    res.json({ success: true, clusters });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/api/aks-health', async (req, res) => {
  if (!aksCredentials) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { clientId, clientSecret, tenantId, subscriptionId } = aksCredentials;
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const client = new ContainerServiceClient(credential, subscriptionId);
    const clusters = [];
    for await (const c of client.managedClusters.list()) {
      clusters.push({
        name: c.name,
        resourceGroup: c.id.split('/')[4],
        location: c.location,
        provisioningState: c.provisioningState,
        kubernetesVersion: c.kubernetesVersion,
        nodeResourceGroup: c.nodeResourceGroup,
        fqdn: c.fqdn
      });
    }
    res.json({ clusters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get cluster detail including workloads; use user or admin credentials based on query param ?admin=1
app.get('/api/cluster/:resourceGroup/:name', async (req, res) => {
  if (!aksCredentials) return res.status(401).json({ error: 'Not authenticated' });
  const { resourceGroup, name } = req.params;
  try {
    const useAdmin = req.query.admin === '1';
    let credentialType = useAdmin ? 'admin' : 'user';
    let server, token;
    try {
      ({ server, token } = await getKubeAccess(resourceGroup, name, useAdmin));
    } catch (e) {
      if (!useAdmin) {
        ({ server, token } = await getKubeAccess(resourceGroup, name, true));
        credentialType = 'admin-fallback';
      } else throw e;
    }

    const agent = new https.Agent({ rejectUnauthorized: false });
    // Minimal direct calls instead of full kubernetes client to avoid extra config parsing
    async function kget(path) {
      const url = server + path;
      try {
        const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, httpsAgent: agent, timeout: 10000, validateStatus: ()=>true });
        if (r.status < 200 || r.status >= 300) return { error: true, status: r.status, path, body: r.data };
        return r.data;
      } catch (e) {
        return { error: true, path, message: e.message };
      }
    }
    const [nodes, pods, deployments] = await Promise.all([
      kget('/api/v1/nodes'),
      kget('/api/v1/pods'),
      kget('/apis/apps/v1/deployments')
    ]);
    const errors = [];
    if (nodes?.error) errors.push({ resource: 'nodes', detail: nodes });
    if (pods?.error) errors.push({ resource: 'pods', detail: pods });
    if (deployments?.error) errors.push({ resource: 'deployments', detail: deployments });
    // Fallback: if nodes failed, try management plane agent pools to at least get counts
    let agentPools = [];
    if (nodes?.error) {
      try {
        const { clientId, clientSecret, tenantId, subscriptionId } = aksCredentials;
        const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        const client = new ContainerServiceClient(credential, subscriptionId);
        for await (const ap of client.agentPools.list(resourceGroup, name)) {
          agentPools.push({ name: ap.name, count: ap.count, osType: ap.osType, provisioningState: ap.provisioningState });
        }
      } catch (e) {
        errors.push({ resource: 'agentPools', detail: { message: e.message } });
      }
    }
    // Build summary
  const nodeItems = nodes?.items || [];
    const podItems = pods?.items || [];
    const deploymentItems = deployments?.items || [];
    const nodeCount = nodeItems.length;
    const readyNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True')).length;
    const podPhases = podItems.reduce((acc,p)=>{ const phase = p.status?.phase || 'Unknown'; acc[phase]=(acc[phase]||0)+1; return acc; },{});
    const deploymentSummaries = deploymentItems.map(d => {
      const desired = d.spec?.replicas ?? 0;
      const available = d.status?.availableReplicas ?? 0;
      return { name: d.metadata?.name, namespace: d.metadata?.namespace, desired, available };
    });
  const summary = { nodeCount, readyNodes, podPhases, deployments: deploymentSummaries.length, agentPools };
  res.json({ server, summary, nodes, pods, deployments, deploymentSummaries, errors, usedCredentialType: credentialType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pod logs endpoint
app.get('/api/cluster/:resourceGroup/:name/pod/:namespace/:pod/logs', async (req, res) => {
  if (!aksCredentials) return res.status(401).json({ error: 'Not authenticated' });
  const { resourceGroup, name, namespace, pod } = req.params;
  const container = req.query.container;
  const tail = req.query.tailLines || '200';
  const useAdmin = req.query.admin === '1';
  try {
    const { server, token } = await getKubeAccess(resourceGroup, name, useAdmin);
    const agent = new https.Agent({ rejectUnauthorized: false });
    const qs = new URLSearchParams();
    if (container) qs.set('container', container);
    if (tail) qs.set('tailLines', tail);
    qs.set('timestamps', 'true');
    const url = `${server}/api/v1/namespaces/${namespace}/pods/${pod}/log?${qs.toString()}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, agent });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'Log fetch failed', status: r.status, body: text });
    res.json({ namespace, pod, container: container || null, lines: text.split('\n') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cluster events endpoint
app.get('/api/cluster/:resourceGroup/:name/events', async (req, res) => {
  if (!aksCredentials) return res.status(401).json({ error: 'Not authenticated' });
  const { resourceGroup, name } = req.params;
  const useAdmin = req.query.admin === '1';
  try {
    const { server, token } = await getKubeAccess(resourceGroup, name, useAdmin);
    const agent = new https.Agent({ rejectUnauthorized: false });
    const r = await fetch(server + '/api/v1/events', { headers: { Authorization: `Bearer ${token}` }, agent });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) return res.status(r.status).json({ error: 'Event fetch failed', status: r.status, body: json });
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logout / clear credentials
app.post('/api/logout', (req, res) => {
  aksCredentials = null;
  cachedClusters = [];
  res.json({ success: true });
});

app.listen(5000, () => console.log('Server running on port 5000'));
