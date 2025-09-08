import React, { useState } from 'react';
import axios from 'axios';
import './styles.css';
import { loginInteractive, acquireArmToken, logout } from './auth';

export default function App(){
  const [auth, setAuth] = useState(false);
  const [clusters, setClusters] = useState([]);
  const [token, setToken] = useState(null);
  const [costs, setCosts] = useState(null);
  const [range, setRange] = useState('30');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function authenticate(){
    try {
      setError(null);
      await loginInteractive();
      const t = await acquireArmToken();
      setToken(t);
      const res = await axios.post('/api/auth', {}, { headers:{ Authorization: `Bearer ${t}` } });
      if(res.data.success){ setAuth(true); setClusters(res.data.clusters||[]); }
    } catch(e){ setError(e.message); }
  }

  async function loadCosts(){
    setLoading(true); setError(null);
    try {
      const res = await axios.get(`/api/costs?days=${range}`);
      setCosts(res.data);
    } catch(e){ setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="app">
      <h1>AKS Cost Dashboard</h1>
      {!auth && (
        <div className="panel">
          <h3>Authenticate (Azure AD SSO)</h3>
          <button onClick={authenticate}>Sign In with Microsoft</button>
          {error && <div className="error">{error}</div>}
        </div>
      )}
      {auth && (
        <div className="panel">
          <h3>Clusters ({clusters.length})</h3>
          <ul>
            {clusters.map(c => <li key={c.name}>{c.name} ({c.location})</li>)}
          </ul>
          <div style={{ marginTop:12 }}>
            <label>Lookback Days: <input type="number" value={range} min="1" max="90" onChange={e=>setRange(e.target.value)}/></label>
            <button disabled={loading} onClick={loadCosts} style={{ marginLeft:8 }}>Load Cost</button>
            <button style={{ marginLeft:8 }} onClick={()=>{ logout(); setAuth(false); setToken(null); setClusters([]); }}>Logout</button>
          </div>
          {loading && <div>Loading...</div>}
          {error && <div className="error">{error}</div>}
        </div>
      )}
      {costs && (
        <div className="panel">
          <h3>Cost (USD)</h3>
          <div className="cost-grid">
            {costs.items.map(i => (
              <div className="cost-item" key={i.name+ i.meterCategory}>
                <strong>{i.name}</strong>
                <div>{i.meterCategory}</div>
                <div>${i.cost.toFixed(2)}</div>
              </div>
            ))}
          </div>
          <div className="total">Total: ${costs.total.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}
