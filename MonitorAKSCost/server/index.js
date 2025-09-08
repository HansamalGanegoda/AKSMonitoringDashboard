import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { ClientSecretCredential } from '@azure/identity';
import { ContainerServiceClient } from '@azure/arm-containerservice';
import { SubscriptionClient } from '@azure/arm-subscriptions';
import { ConsumptionManagementClient } from '@azure/arm-consumption';

const app = express();
app.use(bodyParser.json());

let sp = null; // { clientId, clientSecret, tenantId, subscriptionId }

app.post('/api/auth', async (req,res) => {
  const clientId = req.body.clientId || process.env.AZURE_CLIENT_ID;
  const clientSecret = req.body.clientSecret || process.env.AZURE_CLIENT_SECRET;
  const tenantId = req.body.tenantId || process.env.AZURE_TENANT_ID;
  const subscriptionIdInput = req.body.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID; // optional now
  if (!clientId || !clientSecret || !tenantId) return res.status(400).json({ success:false, error:'Missing creds (need clientId, clientSecret, tenantId)' });
  try {
    const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const clusters = [];
    async function collectForSub(subId){
      const aks = new ContainerServiceClient(cred, subId);
      for await (const c of aks.managedClusters.list()) {
        clusters.push({
          subscriptionId: subId,
            name: c.name,
            location: c.location,
            kubernetesVersion: c.kubernetesVersion,
            resourceGroup: c.id?.split('/')?.[4] || 'unknown',
            nodeResourceGroup: c.nodeResourceGroup
        });
      }
    }
    if (subscriptionIdInput) {
      await collectForSub(subscriptionIdInput);
    } else {
      // enumerate all accessible subscriptions
      const subsClient = new SubscriptionClient(cred);
      for await (const s of subsClient.subscriptions.list()) {
        if (s.subscriptionId) await collectForSub(s.subscriptionId);
      }
    }
    sp = { clientId, clientSecret, tenantId, subscriptionId: subscriptionIdInput || null };
    res.json({ success:true, clusters });
  } catch(e){ res.status(401).json({ success:false, error:e.message }); }
});

app.get('/api/costs', async (req,res)=>{
  if(!sp) return res.status(401).json({ error:'Not authenticated' });
  const days = Math.min(90, Math.max(1, parseInt(req.query.days||'30',10)));
  const { clientId, clientSecret, tenantId, subscriptionId } = sp;
  try {
    const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const consumption = new ConsumptionManagementClient(cred, subscriptionId);
    const end = new Date();
    const start = new Date(Date.now() - days*24*60*60*1000);
    const timeRange = `${start.toISOString()}/${end.toISOString()}`;
    // Build OData filter for date range
    const filter = `properties/usageStart ge '${start.toISOString()}' AND properties/usageEnd le '${end.toISOString()}'`;
    const result = [];
    let total = 0;
    const scope = `/subscriptions/${subscriptionId}`; // required scope string
    for await (const item of consumption.usageDetails.list(scope, { expand: 'properties/meterDetails', filter })) {
      const p = item.properties || {};
      const md = p.meterDetails || {};
      if (!md.meterCategory) continue;
      const cost = p.pretaxCost || 0;
      total += cost;
      result.push({
        name: p.instanceName || md.meterName || 'unknown',
        meterCategory: md.meterCategory,
        cost
      });
    }
    // aggregate by name+category
    const map = new Map();
    for(const r of result){
      const key = r.name+'|'+r.meterCategory;
      if(!map.has(key)) map.set(key,{...r}); else map.get(key).cost += r.cost;
    }
    const items = Array.from(map.values()).sort((a,b)=> b.cost - a.cost);
    res.json({ range: timeRange, total, items });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// Enhance error guidance for insufficient permissions
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = err.message || '';
  if (err.statusCode === 403 || /AuthorizationFailed|does not have authorization|403/.test(msg)) {
    return res.status(403).json({
      error: 'AuthorizationFailed',
      guidance: 'Grant the service principal Cost Management Reader (or Reader) at subscription scope and ensure provider Microsoft.Consumption is registered.',
      cli: 'az role assignment create --assignee <APP_ID> --role "Cost Management Reader" --scope /subscriptions/<SUB_ID>'
    });
  }
  return res.status(500).json({ error: msg || 'Server error' });
});

app.listen(5500, ()=> console.log('Cost server on 5500'));
