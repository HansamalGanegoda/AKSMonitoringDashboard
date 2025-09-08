import React, { useState, useEffect, useRef, useMemo } from 'react';
import './styles.css';
import axios from 'axios';

function App() {
  const [credentials, setCredentials] = useState({ clientId: '', clientSecret: '', tenantId: '', subscriptionId: '' });
  const [authenticated, setAuthenticated] = useState(() => {
    // restore session flag from localStorage
    try { return localStorage.getItem('aksAuth') === '1'; } catch { return false; }
  });
  const [aksData, setAksData] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [clusterDetail, setClusterDetail] = useState(null);
  const [loadingCluster, setLoadingCluster] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [adminMode, setAdminMode] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem('refreshIntervalMs'), 10);
      if (!isNaN(stored) && stored >= 100) return stored;
    } catch {}
    return 30000;
  }); // ms
  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [logState, setLogState] = useState({ open:false, loading:false, lines:[], pod:null, container:null, namespace:null });
  const [logAutoRefresh, setLogAutoRefresh] = useState(false);
  const [showAllPods, setShowAllPods] = useState(false);
  const [podSearch, setPodSearch] = useState('');
  const refreshTimer = useRef(null);
  const logTimer = useRef(null);

  const handleChange = (e) => {
    setCredentials({ ...credentials, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await axios.post('/api/auth', credentials);
      if (res.data.success) {
        setAuthenticated(true);
        try { localStorage.setItem('aksAuth','1'); } catch {}
        // persist (shallow) credentials for reload convenience (without secret) - avoid storing secret for security
        try { localStorage.setItem('aksSub', credentials.subscriptionId || ''); } catch {}
        fetchAksHealth();
      }
    } catch (err) {
      alert('Authentication failed');
    }
  };

  const fetchAksHealth = async () => {
    try {
      const res = await axios.get('/api/aks-health');
      setAksData(res.data);
    } catch (e) {
      setErrorMsg(e.message || 'Failed to load clusters');
    }
  };

  const fetchClusterDetail = async (cluster, opts = {}) => {
    if (!cluster) return;
    setLoadingCluster(true);
    setErrorMsg(null);
    try {
      const res = await axios.get(`/api/cluster/${cluster.resourceGroup}/${cluster.name}${(opts.admin ?? adminMode) ? '?admin=1' : ''}`);
      setClusterDetail(res.data);
    } catch (e) {
      setClusterDetail(null);
      setErrorMsg(e.response?.data?.error || e.message || 'Failed to load cluster detail');
    } finally {
      setLoadingCluster(false);
    }
  };

  // Derived namespaces
  const namespaces = useMemo(() => {
    if (!clusterDetail?.pods?.items) return [];
    const set = new Set(clusterDetail.pods.items.map(p => p.metadata?.namespace).filter(Boolean));
    return Array.from(set).sort();
  }, [clusterDetail]);

  const filteredPods = useMemo(() => {
    if (!clusterDetail?.pods?.items) return [];
    return clusterDetail.pods.items.filter(p => (!namespaceFilter || p.metadata?.namespace === namespaceFilter));
  }, [clusterDetail, namespaceFilter]);

  // Group & sort pods by namespace and status importance
  const groupedPods = useMemo(() => {
    const map = new Map();
    function podWeight(p) {
      // crashed/error first, then pending, then running, then others
      const phase = p.status?.phase || 'Unknown';
      const statuses = p.status?.containerStatuses || [];
      let crashed = false;
      for (const cs of statuses) {
        const waitingReason = cs.state?.waiting?.reason || '';
        const termReason = cs.state?.terminated?.reason || '';
        if (/CrashLoopBackOff|Error|ContainerCannotRun|OOMKilled/i.test(waitingReason) || /Error|OOMKilled|ContainerCannotRun/i.test(termReason)) { crashed = true; break; }
      }
      if (crashed || phase === 'Failed') return 0;
      if (phase === 'Pending') return 1;
      if (phase === 'Running' || phase === 'Succeeded') return 2;
      return 3;
    }
    filteredPods.forEach(p => {
      const ns = p.metadata?.namespace || 'default';
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns).push(p);
    });
    const entries = Array.from(map.entries()).map(([ns, pods]) => {
      pods.sort((a,b)=> {
        const w = podWeight(a) - podWeight(b);
        if (w !== 0) return w;
        return (a.metadata?.name||'').localeCompare(b.metadata?.name||'');
      });
      return [ns, pods];
    });
    entries.sort((a,b)=> a[0].localeCompare(b[0]));
    return entries; // [ [namespace, pods[]], ... ]
  }, [filteredPods]);

  const allPods = useMemo(() => clusterDetail?.pods?.items || [], [clusterDetail]);
  const searchedAllPods = useMemo(() => {
    if (!podSearch) return allPods;
    const q = podSearch.toLowerCase();
    return allPods.filter(p => (
      (p.metadata?.name || '').toLowerCase().includes(q) ||
      (p.metadata?.namespace || '').toLowerCase().includes(q)
    ));
  }, [allPods, podSearch]);

  function podRestarts(p) {
    const statuses = p.status?.containerStatuses || [];
    return statuses.reduce((sum, cs) => sum + (cs.restartCount || 0), 0);
  }
  function podAge(p) {
    const ts = p.metadata?.creationTimestamp;
    if (!ts) return '-';
    const diffMs = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diffMs/60000);
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins/60);
    if (hrs < 24) return hrs + 'h';
    const days = Math.floor(hrs/24); return days + 'd';
  }

  function podPhaseBadge(p) {
    const phase = p.status?.phase || 'Unknown';
    let crashed = false;
    const statuses = p.status?.containerStatuses || [];
    for (const cs of statuses) {
      const waitingReason = cs.state?.waiting?.reason || '';
      const termReason = cs.state?.terminated?.reason || '';
      if (/CrashLoopBackOff|Error|ContainerCannotRun/i.test(waitingReason) || /Error|OOMKilled|ContainerCannotRun/i.test(termReason)) {
        crashed = true; break;
      }
    }
    let cls = 'badge phase-unknown';
    if (crashed || phase === 'Failed') cls = 'badge phase-failed';
    else if (phase === 'Running') cls = 'badge phase-running';
    else if (phase === 'Pending') cls = 'badge phase-pending';
    else if (phase === 'Succeeded') cls = 'badge phase-running'; // treat succeeded as green
    return <span className={cls} style={{ marginLeft:4 }}>{crashed ? 'CrashLoop' : phase}</span>;
  }

  const filteredDeployments = useMemo(() => {
    if (!clusterDetail?.deploymentSummaries) return [];
    return clusterDetail.deploymentSummaries.filter(d => !namespaceFilter || d.namespace === namespaceFilter);
  }, [clusterDetail, namespaceFilter]);

  const openLogs = async (pod) => {
    const ns = pod.metadata.namespace;
    const podName = pod.metadata.name;
    const containerName = (pod.spec?.containers?.[0]?.name) || null;
    setLogState({ open:true, loading:true, lines:[], pod:podName, container:containerName, namespace:ns });
    await fetchLogs(ns, podName, containerName);
  };

  const fetchLogs = async (ns, podName, containerName, opts={}) => {
    try {
      setLogState(ls => ({ ...ls, loading:true }));
      const params = new URLSearchParams();
      if (adminMode) params.set('admin','1');
      if (containerName) params.set('container', containerName);
      if (opts.tailLines) params.set('tailLines', String(opts.tailLines));
      const res = await axios.get(`/api/cluster/${selectedCluster.resourceGroup}/${selectedCluster.name}/pod/${ns}/${podName}/logs?${params.toString()}`);
      setLogState(ls => ({ ...ls, loading:false, lines:res.data.lines || [], container:res.data.container || containerName }));
    } catch (e) {
      setLogState(ls => ({ ...ls, loading:false, lines:[`ERROR: ${e.response?.data?.error || e.message}`] }));
    }
  };

  useEffect(() => {
    if (logAutoRefresh && logState.open && logState.pod) {
      logTimer.current = setInterval(() => fetchLogs(logState.namespace, logState.pod, logState.container), 15000);
    } else if (logTimer.current) {
      clearInterval(logTimer.current);
      logTimer.current = null;
    }
    return () => { if (logTimer.current) clearInterval(logTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logAutoRefresh, logState.open, logState.pod, adminMode]);

  // Auto refresh cluster detail
  useEffect(() => {
    if (autoRefresh && selectedCluster) {
      const interval = Math.max(100, refreshInterval); // hard floor 100ms
      refreshTimer.current = setInterval(() => fetchClusterDetail(selectedCluster), interval);
    } else if (refreshTimer.current) {
      clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selectedCluster, adminMode, refreshInterval]);

  // Persist chosen interval
  useEffect(() => {
    try { localStorage.setItem('refreshIntervalMs', String(refreshInterval)); } catch {}
  }, [refreshInterval]);

  const handleOpenCluster = async (c) => {
    setSelectedCluster(c);
    setClusterDetail(null);
    await fetchClusterDetail(c);
  };

  const logout = async () => {
    try { await axios.post('/api/logout'); } catch { /* ignore */ }
    setAuthenticated(false);
    try { localStorage.removeItem('aksAuth'); } catch {}
    setAksData(null);
    setSelectedCluster(null);
    setClusterDetail(null);
    setAdminMode(false);
    setAutoRefresh(false);
    setErrorMsg(null);
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-wrap">
          <img src="/logo.png" alt="Logo" className="logo" />
          <h1>AKS Health Dashboard</h1>
        </div>
        {authenticated && (
          <div className="header-actions">
            <button onClick={fetchAksHealth}>Refresh Clusters</button>
            <button onClick={logout}>Logout</button>
          </div>
        )}
      </header>
      {!authenticated ? (
        <form onSubmit={handleSubmit}>
          <h2 style={{ marginTop: '1rem' }}>Enter AKS Credentials</h2>
          <input name="clientId" placeholder="Client ID" onChange={handleChange} required />
          <input name="clientSecret" placeholder="Client Secret" type="password" onChange={handleChange} required />
          <input name="tenantId" placeholder="Tenant ID" onChange={handleChange} required />
          <input name="subscriptionId" placeholder="Subscription ID" onChange={handleChange} required />
          <button type="submit">Authenticate</button>
        </form>
      ) : (
        <div className="content-area">
          {errorMsg && <div style={{ color:'red', marginTop:'0.5rem' }}>{errorMsg}</div>}
          {aksData && aksData.clusters && (
            <table border="1" cellPadding="4" style={{ marginTop: '1rem' }}>
              <thead>
                <tr>
                  <th>Name</th><th>RG</th><th>Version</th><th>State</th><th>Location</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {aksData.clusters.map(c => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.resourceGroup}</td>
                    <td>{c.kubernetesVersion}</td>
                    <td>{c.provisioningState}</td>
                    <td>{c.location}</td>
                    <td>
                      <button onClick={() => handleOpenCluster(c)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {selectedCluster && (
            <div style={{ marginTop: '2rem' }} className="cluster-section">
              <h3>Cluster: {selectedCluster.name}</h3>
              <div style={{ display:'flex', gap:'1rem', alignItems:'center' }}>
                <label>
                  <input
                    type="checkbox"
                    checked={adminMode}
                    onChange={e => { setAdminMode(e.target.checked); fetchClusterDetail(selectedCluster, { admin: e.target.checked }); }}
                  /> Admin
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={e => setAutoRefresh(e.target.checked)}
                  />
                  <span>Auto Refresh</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={(refreshInterval/1000).toString()}
                    onChange={e => {
                      const v = parseFloat(e.target.value || '0');
                      if (!isNaN(v)) setRefreshInterval(v*1000);
                    }}
                    style={{ width:60 }}
                    title="Seconds between refreshes"
                    disabled={!autoRefresh}
                  />
                  <span style={{ fontSize:12, color: (refreshInterval < 5000 ? '#f59e0b':'var(--muted)') }}>{(refreshInterval/1000).toFixed(1)}s</span>
                  <div style={{ display:'flex', gap:4 }}>
                    {[0.5,1,5,30].map(s => (
                      <button key={s} type="button" disabled={!autoRefresh || (refreshInterval/1000)===s} onClick={()=> setRefreshInterval(s*1000)} style={{ padding:'2px 6px' }}>{s}</button>
                    ))}
                  </div>
                </label>
        <button disabled={loadingCluster} onClick={() => fetchClusterDetail(selectedCluster)}>Reload Detail</button>
        <button onClick={()=> setShowAllPods(s => !s)}>{showAllPods ? 'Hide All Pods View' : 'All Pods View'}</button>
                {loadingCluster && <span>Loading...</span>}
                {autoRefresh && refreshInterval < 2000 && <span style={{ fontSize:11, color:'#f59e0b' }}>High frequency may increase API cost/load</span>}
              </div>
              {clusterDetail?.summary && (
                <div className="summary-card">
                  <div style={{ fontSize:'0.75rem', letterSpacing:'1px', textTransform:'uppercase', color:'var(--muted)' }}>Summary</div>
                  <div className="summary-grid">
                    <div><span className="badge phase-running">Nodes</span> {clusterDetail.summary.readyNodes}/{clusterDetail.summary.nodeCount}</div>
                    <div><span className="badge">Deployments</span> {clusterDetail.summary.deployments}</div>
                    <div><span className="badge">Phases</span> {Object.entries(clusterDetail.summary.podPhases).map(([k,v])=>`${k}:${v}`).join(' | ')}</div>
                    <div><span className="badge">Cred</span> {clusterDetail.usedCredentialType}</div>
                    {clusterDetail.summary.agentPools?.length ? <div><span className="badge">Pools</span> {clusterDetail.summary.agentPools.map(p=>`${p.name}:${p.count}`).join(', ')}</div> : null}
                  </div>
                </div>
              )}
              {clusterDetail?.errors?.length > 0 && (
                <div style={{ marginTop:'0.5rem', color:'#b34700' }}>
                  <strong>Partial Errors:</strong>
                  <ul>
                    {clusterDetail.errors.map((er,i)=>(
                      <li key={i}>{er.resource}: {er.detail.status || er.detail.message || 'error'}</li>
                    ))}
                  </ul>
                </div>
              )}
              {clusterDetail ? (
                <div className="cluster-panels">
                  <div className="panel-card">
                    <h4>Nodes</h4>
                    <ul>
                      {(clusterDetail.nodes.items || []).map(n => <li key={n.metadata.name}>{n.metadata.name}</li>)}
                    </ul>
                  </div>
                  <div className="panel-card">
                    <h4>Deployments</h4>
                    <ul>
                      {filteredDeployments.map(d => <li key={d.namespace + d.name}>{d.namespace}/{d.name} - {d.available}/{d.desired}</li>)}
                    </ul>
                  </div>
                  <div className="panel-card">
                    <h4>Pods</h4>
                    <div style={{ marginBottom:'0.6rem', display:'flex', gap:'0.5rem', alignItems:'center' }}>
                      <select value={namespaceFilter} onChange={e => setNamespaceFilter(e.target.value)}>
                        <option value="">All Namespaces</option>
                        {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                      </select>
                      <span style={{ fontSize:'0.65rem', color:'var(--muted)' }}>{filteredPods.length} pods</span>
                    </div>
                    <div className="pod-groups">
                      {groupedPods.length === 0 && <div style={{ fontSize:'0.7rem', color:'var(--muted)' }}>No pods</div>}
                      {groupedPods.map(([ns, pods]) => (
                        <div className="pod-namespace" key={ns}>
                          <div className="pod-namespace-header">{ns} <span className="badge" style={{ marginLeft:6 }}>{pods.length}</span></div>
                          <ul className="pod-list">
                            {pods.map(p => {
                              const statuses = p.status?.containerStatuses || [];
                              let crashed = false;
                              for (const cs of statuses) {
                                const waitingReason = cs.state?.waiting?.reason || '';
                                const termReason = cs.state?.terminated?.reason || '';
                                if (/CrashLoopBackOff|Error|ContainerCannotRun|OOMKilled/i.test(waitingReason) || /Error|OOMKilled|ContainerCannotRun/i.test(termReason)) { crashed = true; break; }
                              }
                              const phase = p.status?.phase || 'Unknown';
                              const liClass = 'pod-item ' + (crashed || phase==='Failed' ? 'problem' : (phase==='Running'||phase==='Succeeded') ? 'running' : '');
                              return (
                                <li key={p.metadata.uid} className={liClass}>
                                  <button onClick={() => openLogs(p)} style={{ marginRight:2 }}>Logs</button>
                                  <span style={{ flex:1 }}>{p.metadata.name}</span>
                                  {podPhaseBadge(p)}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : <p>Loading cluster details...</p>}
              {showAllPods && (
                <div className="all-pods-modal">
                  <div className="all-pods-header">
                    <strong>All Pods ({searchedAllPods.length})</strong>
                    <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
                      <input
                        type="text"
                        placeholder="Search namespace or name"
                        value={podSearch}
                        onChange={e=>setPodSearch(e.target.value)}
                        style={{ padding:'4px' }}
                      />
                      <button onClick={()=> setPodSearch('')}>Clear</button>
                      <button onClick={()=> setShowAllPods(false)}>Close</button>
                    </div>
                  </div>
                  <div className="all-pods-table-wrap">
                    <table className="pods-table">
                      <thead>
                        <tr>
                          <th>Namespace</th>
                          <th>Name</th>
                          <th>Phase</th>
                          <th>Restarts</th>
                          <th>Age</th>
                          <th>Logs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchedAllPods.map(p => (
                          <tr key={p.metadata.uid}>
                            <td>{p.metadata.namespace}</td>
                            <td>{p.metadata.name}</td>
                            <td>{podPhaseBadge(p)}</td>
                            <td>{podRestarts(p)}</td>
                            <td>{podAge(p)}</td>
                            <td><button onClick={()=> openLogs(p)}>Logs</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {logState.open && (
            <div style={{ position:'fixed', right:10, bottom:10, width:'40%', height:'50%', background:'#1e1e1e', color:'#ddd', border:'1px solid #444', display:'flex', flexDirection:'column' }}>
              <div style={{ padding:'4px 8px', background:'#333', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <strong>Logs: {logState.namespace}/{logState.pod}{logState.container?` (${logState.container})`:''}</strong>
                <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
                  <label style={{ fontSize:12 }}>
                    <input type="checkbox" checked={logAutoRefresh} onChange={e=>setLogAutoRefresh(e.target.checked)} /> Auto 15s
                  </label>
                  <button onClick={()=> fetchLogs(logState.namespace, logState.pod, logState.container)} disabled={logState.loading}>Reload</button>
                  <button onClick={()=> setLogState({ open:false, loading:false, lines:[], pod:null, container:null, namespace:null })}>Close</button>
                </div>
              </div>
              <pre style={{ flex:1, margin:0, padding:8, overflow:'auto', fontSize:12, background:'#000' }}>
                {logState.loading ? 'Loading logs...' : (logState.lines || []).join('\n')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
