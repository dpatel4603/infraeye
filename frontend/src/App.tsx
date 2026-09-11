import { useEffect, useMemo, useState } from 'react';
import SearchBar, { type NetworkEntity } from './SearchBar';
import Topology from './Topology';
import Measurements from './Measurements';
import { providerName } from './providerName';
import { meaningful, plainChange, routePatterns } from './interpretation';
import { changeLabel, compactPath } from './routeChanges';
import type { Metadata, Route, Selection, Snapshot } from './types';

const favorites = [
  { prefix: '1.1.1.0/24', name: 'Cloudflare DNS' },
  { prefix: '8.8.8.0/24', name: 'Google DNS' },
  { prefix: '9.9.9.0/24', name: 'Quad9 DNS' },
];
const emptyRoutes: Route[] = [];
const dateTime = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
async function get<T,>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

export default function App() {
  const [resource, setResource] = useState(favorites[0].prefix);
  const [entity, setEntity] = useState<NetworkEntity>();
  const [meta, setMeta] = useState<Metadata>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [mode, setMode] = useState<'explore' | 'replay'>('explore');
  const [technical, setTechnical] = useState(false);
  const [allUpdates, setAllUpdates] = useState(false);
  const [individuals, setIndividuals] = useState(false);
  const [showAllPatterns, setShowAllPatterns] = useState(false);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: 'prefix', prefix: favorites[0].prefix });
  const [detailTab, setDetailTab] = useState<'overview' | 'routes' | 'history'>('overview');
  const [routeLimit, setRouteLimit] = useState(2);
  const [focusPeer, setFocusPeer] = useState('');
  const [activeEventId, setActiveEventId] = useState<number>();
  const [filter, setFilter] = useState('');
  const [eventPeer, setEventPeer] = useState('');
  const [historyLimit, setHistoryLimit] = useState(40);
  const [showEvidence, setShowEvidence] = useState(false);
  const [physicalNotice, setPhysicalNotice] = useState(false);
  const [explain, setExplain] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const result = await get<Metadata>(`metadata?resource=${encodeURIComponent(resource)}`, controller.signal);
        setMeta(result);
        setAt(previous => mode === 'explore' ? result.end : Math.max(result.start, Math.min(previous, result.end)));
        setError('');
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to retrieve observations');
      } finally { busy = false; }
    }
    void load();
    const timer = mode === 'explore' ? window.setInterval(load, 60_000) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [resource, mode, reload]);

  useEffect(() => {
    if (!meta || at < meta.start || at > meta.end) return;
    const controller = new AbortController();
    get<Snapshot>(`state?resource=${encodeURIComponent(resource)}&at=${at}&dataset_id=${encodeURIComponent(meta.dataset_id)}`, controller.signal)
      .then(result => { setSnapshot(result); setError(''); })
      .catch(error => { if (!controller.signal.aborted) { setError(error.message); setPlaying(false); } });
    return () => controller.abort();
  }, [resource, meta?.dataset_id, at]);

  useEffect(() => {
    setSelection({ kind: 'prefix', prefix: resource }); setActiveEventId(undefined);
    setPlaying(false); setFocusPeer(''); setRouteLimit(2); setExplain(false);
  }, [resource, meta?.dataset_id]);

  const current = snapshot?.dataset_id === meta?.dataset_id ? snapshot : undefined;
  const routes = current?.routes ?? emptyRoutes;
  const events = current?.events ?? emptyRoutes;
  const ready = current?.timestamp === at;
  const provider = (asn: number) => providerName(asn, meta?.asns ?? (entity ? [{ asn: entity.asn, name: entity.name, role: '' }] : []));
  const originAsns = [...new Set(routes.map(route => route.as_path.at(-1)).filter((asn): asn is number => asn !== undefined))];
  const rootName = favorites.find(f => f.prefix === resource)?.name ?? (originAsns.length ? originAsns.map(provider).join(' / ') : entity ? provider(entity.asn) : resource);
  const timelineEvents = useMemo(() => allUpdates ? events : events.filter(meaningful), [events, allUpdates]);
  const eventTimes = useMemo(() => [...new Set(timelineEvents.map(e => e.timestamp))].sort((a, b) => a - b), [timelineEvents]);
  const patterns = useMemo(() => routePatterns(routes), [routes]);
  const throughNow = events.filter(event => event.timestamp <= at);
  const significant = throughNow.filter(meaningful);
  const lastSignificant = significant.at(-1);
  const reporting = new Set(routes.map(route => route.peer_id)).size;
  const changedObservers = new Set(significant.filter(e => e.type === 'announcement' && e.previous_path?.length).map(e => e.peer_id)).size;
  const withdrawalCount = significant.filter(e => e.type === 'withdrawal').length;
  const next = eventTimes.find(time => time > at);
  const previous = eventTimes.filter(time => time < at).at(-1) ?? meta?.start;
  const latestEvent = throughNow.at(-1);
  const activeChange = mode === 'replay' && ready ? events.find(event => event.id === activeEventId && event.timestamp === at) ?? timelineEvents.filter(event => event.timestamp === at).at(-1) : undefined;

  useEffect(() => {
    if (!playing || !ready) return;
    if (next === undefined) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { setAt(next); setActiveEventId(undefined); }, 1800);
    return () => clearTimeout(timer);
  }, [playing, ready, at, next]);

  const rankedPeers = useMemo(() => {
    const counts = new Map<string, number>();
    events.forEach(event => counts.set(event.peer_id, (counts.get(event.peer_id) ?? 0) + 1));
    return [...(meta?.peers ?? [])].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  }, [events, meta?.peers]);
  const graphRoutes = useMemo(() => {
    const preferred = activeChange?.peer_id || focusPeer;
    const peerOrder = [preferred, ...(individuals ? rankedPeers.map(peer => peer.id) : patterns.map(pattern => pattern.routes[0].peer_id))].filter(Boolean);
    const result: Route[] = [];
    const ids = new Set<string>();
    const nodes = new Set(activeChange?.previous_path ?? []);
    for (const peer of peerOrder) for (const route of routes.filter(route => route.peer_id === peer)) {
      const id = `${route.peer_id}-${route.prefix}`;
      const expanded = new Set([...nodes, ...route.as_path]);
      if (ids.has(id) || expanded.size > 30 || result.length >= routeLimit) continue;
      ids.add(id); route.as_path.forEach(asn => nodes.add(asn)); result.push(route);
    }
    return result;
  }, [routes, rankedPeers, focusPeer, routeLimit, activeChange, individuals, patterns]);
  const selectedAsn = selection.kind === 'asn' ? selection.asn : undefined;
  const selectedRoutes = routes.filter(route => selectedAsn ? route.as_path.includes(selectedAsn) : route.prefix === resource);
  const selectedTitle = selectedAsn ? provider(selectedAsn) : selection.kind === 'event' ? (technical ? changeLabel(selection.event) : plainChange(selection.event)) : rootName;
  const neighbors = [...new Set(selectedRoutes.flatMap(route => route.as_path.flatMap((asn, index) => {
    if (asn !== selectedAsn) return [];
    return [route.as_path[index - 1], route.as_path[index + 1]].filter((other): other is number => other !== undefined && other !== selectedAsn);
  })))];
  const relevantHistory = events.filter(event => event.timestamp <= at && (!selectedAsn || event.as_path.includes(selectedAsn) || event.previous_path?.includes(selectedAsn))).slice().reverse();
  const filteredEvents = timelineEvents.filter(event => event.timestamp <= at && (!eventPeer || event.peer_id === eventPeer)
    && (!filter || (filter === 'path-change' ? changeLabel(event) === 'Path changed' : event.type === filter))).slice().reverse();
  const pathText = (path: number[] | undefined | null) => !path?.length ? 'No advertised route' : (technical ? path : compactPath(path)).map(asn => technical ? `AS${asn}` : provider(asn)).join(' → ');
  const peerName = (id: string) => { const peer = meta?.peers.find(peer => peer.id === id); return peer ? provider(peer.asn) : id; };

  function openResource(prefix: string, nextEntity?: NetworkEntity) {
    setResource(prefix); setEntity(nextEntity); setMeta(undefined); setSnapshot(undefined); setMode('explore');
    setPlaying(false); setError(''); setIndividuals(false); setShowAllPatterns(false); setAllUpdates(false); setFilter(''); setEventPeer(''); setHistoryLimit(40); setDetailTab('overview');
    // Reopening the same resource should still load it.
    setReload(value => value + 1);
  }
  function switchMode(value: 'explore' | 'replay') {
    setMode(value); setPlaying(false); setActiveEventId(undefined);
    if (meta) setAt(value === 'explore' ? meta.end : meta.start);
  }
  function jump(timestamp: number) {
    setMode('replay'); setPlaying(false); setAt(timestamp); setActiveEventId(undefined); setExplain(false);
  }
  function inspect(event: Route) {
    setMode('replay'); setPlaying(false); setAt(event.timestamp); setActiveEventId(event.id);
    setSelection({ kind: 'event', event }); setDetailTab('overview'); setExplain(false);
  }
  function selectNetwork(value: Selection) { setSelection(value); setDetailTab('overview'); setExplain(false); }
  const captionRoute = graphRoutes.find(route => route.peer_id === focusPeer) ?? graphRoutes[0];
  const detailEvent = selection.kind === 'event' ? selection.event : undefined;

  return <div className="app">
    <header className="app-header">
      <a className="brand" href="/" aria-label="InfraEye home"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 16c7-11 17-11 24 0-7 11-17 11-24 0Z"/><circle cx="16" cy="16" r="4"/></svg>InfraEye</a>
      <nav aria-label="Main navigation"><button className={mode === 'explore' ? 'active' : ''} onClick={() => switchMode('explore')}>Explore</button><button className={mode === 'replay' ? 'active' : ''} onClick={() => switchMode('replay')}>Replay</button></nav>
      <SearchBar resource={resource} onExplore={(network, prefix) => openResource(prefix, network)}/>
      <span className="real-data"><i/> Real observations</span>
    </header>
    <main>
      <div className="discovery-strip"><span>Explore a destination</span>{favorites.map(favorite => <button key={favorite.prefix} className={resource === favorite.prefix ? 'selected' : ''} onClick={() => openResource(favorite.prefix)}>{favorite.name}<small>{favorite.prefix}</small></button>)}</div>
      {error && <div className="error" role="alert"><strong>Observations unavailable</strong><span>{error}</span><button onClick={() => setReload(value => value + 1)}>Retry</button></div>}
      {!meta ? <section className="loading-stage"><span className="eyebrow">SEARCH THE INTERNET</span><h1>{error ? 'No observations to show yet.' : 'Finding this network’s routes…'}</h1><p>Retrieving real routing observations for {resource}. The first request can take up to a minute.</p></section> : <>
        <section className="map-panel" aria-label="Internet neighborhood">
          <div className="entity-bar">
            <div className="entity-identity"><span className="entity-symbol">◎</span><div><div className="eyebrow">INTERNET / DESTINATION</div><h1>{rootName}</h1><p>{resource}{originAsns.length > 0 && ` · ${originAsns.map(asn => `AS${asn}`).join(', ')}`}</p></div></div>
            <div className="entity-metrics" hidden={!technical}><div><strong>{routes.length}</strong><span>observed routes</span></div><div><strong>{meta.peers.length}<small> / 1</small></strong><span>peers / collector</span></div><div><strong>{latestEvent ? clock(latestEvent.timestamp) : '—'}</strong><span>last recorded update · UTC</span></div></div>
          </div>
          <div className="routing-summary" aria-label="Routing summary" aria-busy={!ready}>

            <h2>{ready ? `${reporting} of ${meta.peers.length} peers report a route.` : 'Updating the routing summary…'}</h2>
            {ready && <><p>{patterns.length} route patterns at this moment. {changedObservers} observation peers changed paths and {withdrawalCount} route withdrawals recorded since {dateTime(meta.start)}.</p>

            <small>Reported routes do not prove reachability. Performance is measured separately.</small>

            </>}
          </div>
          <div className="map-toolbar">
            <div className="view-switch" aria-label="Graph display"><button aria-pressed={!technical} onClick={() => setTechnical(false)}>Simplified</button><button aria-pressed={technical} onClick={() => setTechnical(true)}>Technical</button><button className="unavailable-view" title="No verified physical-connection data is available" onClick={() => setPhysicalNotice(value => !value)}>Physical <span>Unavailable</span></button></div>
            <div className="map-status"><span className={mode === 'replay' ? 'replay-badge' : 'capture-badge'}>{mode === 'replay' ? 'REPLAY' : 'LATEST AVAILABLE'}</span><time>{dateTime(at)}</time><button className="text-button" onClick={() => setShowEvidence(value => !value)} aria-expanded={showEvidence}>Evidence ↗</button></div>
          </div>
          {physicalNotice && <div className="notice" role="status"><strong>Physical mapping needs more evidence.</strong> These records contain advertised AS paths, not verified facilities, cables or cross-connects. No physical locations are inferred.<button aria-label="Close physical notice" onClick={() => setPhysicalNotice(false)}>×</button></div>}
          {showEvidence && <div className="evidence-panel" role="region" aria-label="Routing evidence"><div><strong>Observed routing</strong><p>RIPE RIS via RIPEstat · {meta.collector}. Edges are consecutive ASNs in observed advertisements. Business relationships, physical links and reachability are not established.</p></div><div><strong>Source coverage</strong><p>{dateTime(meta.start)} — {dateTime(meta.end)}<br/>Retrieved {dateTime(meta.fetched_at)}. Delayed data, not a real-time feed.</p><a href={meta.source_url} target="_blank" rel="noreferrer">Original RIPE response ↗</a></div></div>}
          {meta.retrieval_error && <div className="notice" role="alert">Refresh failed. Retaining the real capture retrieved at {dateTime(meta.fetched_at)}. {meta.retrieval_error}</div>}
          {meta.messages.length > 0 && <div className="notice">Source messages: {JSON.stringify(meta.messages)}</div>}
          <div className="route-workspace"><aside className="pattern-panel"><div className="history-heading"><div><span className="eyebrow">HOW ROUTES ARE STRUCTURED</span><h2>Route patterns <span className="count-badge">{patterns.length}</span></h2></div><button aria-pressed={individuals} onClick={() => setIndividuals(v => !v)}>{individuals ? 'Show route patterns' : 'Show individual observers'}</button></div>
            <p className="muted">Grouped by every network after the observer. Counts describe advertised routes, not traffic share or physical connections.</p>
            <div className="pattern-list">{(showAllPatterns ? patterns : patterns.slice(0, 4)).map(pattern => <button key={pattern.key} className={focusPeer === pattern.routes[0].peer_id ? 'selected' : ''} onClick={() => { setFocusPeer(pattern.routes[0].peer_id); setIndividuals(true); }}><strong title={pattern.via.map(provider).join(' → ')}>{pattern.via.length <= 1 ? 'Direct AS path' : `Via ${pattern.via.slice(0, -1).map(provider).join(' → ')}`}</strong><span>{pattern.routes.length} {pattern.routes.length === 1 ? 'route' : 'routes'} · {Math.round(100 * pattern.routes.length / Math.max(1, routes.length))}%</span><small>{new Set(pattern.routes.map(r => r.peer_id)).size} observation peers · {pattern.routes[0].prefix}</small><progress max={routes.length} value={pattern.routes.length}/></button>)}</div>
            {patterns.length > 4 && <button className="text-button pattern-more" onClick={() => setShowAllPatterns(v => !v)}>{showAllPatterns ? 'Show fewer patterns' : `Show all ${patterns.length} patterns`}</button>}
            <p>{activeChange ? 'Graph focuses on the observer involved in the selected change.' : focusPeer ? 'Graph prioritizes your selected viewpoint.' : individuals ? 'Graph starts with the observers that sent the most updates.' : 'Graph shows one representative from each of the most common patterns, within the display limit.'}</p>
          </aside><div className="graph-column">
          <Topology routes={graphRoutes} meta={meta} selection={selection} onSelect={selectNetwork} technical={technical} change={activeChange}/>
          <div className="map-footer"><div className="graph-key"><span><i/> Observed route</span>{activeChange && <><span><i className="new-line"/> Added adjacency</span><span><i className="old-line"/> Previous adjacency</span></>}</div><div className="expand-routes"><span>{graphRoutes.length} of {routes.length} routes shown · 30-network limit</span><button disabled={routeLimit >= 8 || graphRoutes.length >= routes.length} onClick={() => setRouteLimit(value => Math.min(8, value + 2))}>＋ More viewpoints</button>{routeLimit > 2 && <button onClick={() => setRouteLimit(2)}>Reset</button>}</div></div>
          <div className="route-caption" aria-live="polite">{!ready ? 'Moving to the selected moment…' : <><strong>{graphRoutes.length} representative routes shown.</strong> <span>{graphRoutes.map(route => peerName(route.peer_id)).join(' · ')}. Advertised AS paths, not physical links.</span></>}</div>
          </div></div>
        </section>



        <div className="lower-panels">
          <section className="detail-panel" aria-label="Selected network details">
            <div className="panel-title"><span className="eyebrow">{detailEvent ? 'SELECTED UPDATE' : 'SELECTED NETWORK'}</span><span className="observed-tag">Observed</span></div>
            <h2>{selectedTitle}</h2><p className="selected-subtitle">{selectedAsn ? `AS${selectedAsn}` : detailEvent ? `${clock(detailEvent.timestamp)} UTC · ${peerName(detailEvent.peer_id)}` : resource}</p>
            <div className="detail-tabs" aria-label="Network details">{(['overview', 'routes', 'history'] as const).map(tab => <button key={tab} aria-pressed={detailTab === tab} onClick={() => setDetailTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</div>
            {detailTab === 'overview' && <div className="detail-content">
              {detailEvent ? <>
                <div className="change-path before"><span>BEFORE · THIS PEER</span><p>{pathText(detailEvent.previous_path)}</p></div>
                <div className="change-path after"><span>AFTER · THIS PEER</span><p>{pathText(detailEvent.as_path)}</p></div>
                <button className="explain-button" aria-expanded={explain} onClick={() => setExplain(value => !value)}>Explain this change</button>
                {explain && <div className="explanation"><p>At {dateTime(detailEvent.timestamp)}, {peerName(detailEvent.peer_id)} {detailEvent.type === 'withdrawal' ? 'withdrew its advertised route' : changeLabel(detailEvent) === 'Path changed' ? 'reported a different AS path' : 'sent a route announcement'} for {detailEvent.prefix} to RRC00.</p>{detailEvent.type === 'announcement' && changeLabel(detailEvent) === 'Advertisement updated' && <p>The AS path is unchanged in this update.</p>}<p>This describes a routing observation. This BGP record does not measure latency, traffic delivery or cause. Separate Atlas measurements, when available below, come from a different observer.</p><small>Generated from this record’s before/after paths. No LLM is connected.</small></div>}
                <div className="fact-row"><span>Evidence</span><strong>One reporting peer · RRC00</strong></div>
                <div className="fact-row"><span>Peer identity</span><code>{detailEvent.peer_id}</code></div>
                {technical && <div className="fact-row"><span>Source sequence</span><code>{detailEvent.source_sequence}</code></div>}
              </> : <>
                {selectedAsn && <p className="owner-label">{meta.asns.find(network => network.asn === selectedAsn)?.name ?? 'Owner not supplied by source'}</p>}
                <div className="fact-row"><span>Reported routes in this view</span><strong>{selectedRoutes.length}</strong></div>
                <div className="fact-row"><span>Reported by</span><strong>{new Set(selectedRoutes.map(route => route.peer_id)).size} observation peers{technical ? ' · 1 collector' : ''}</strong></div>
                <div className="detail-section"><h3>{technical ? 'Destination prefixes' : 'Destination address ranges'}</h3>{[...new Set(selectedRoutes.map(route => route.prefix))].map(prefix => <button className="prefix-link" key={prefix} onClick={() => selectNetwork({ kind: 'prefix', prefix })}>{favorites.find(f => f.prefix === prefix)?.name ?? 'Observed destination'}<small>{prefix}</small></button>)}{!selectedRoutes.length && <p>No matching routes at this moment.</p>}</div>
                {selectedAsn && <div className="detail-section"><h3>Adjacent networks <span>{neighbors.length}</span></h3><p className="muted">Consecutive in observed AS paths; not a confirmed business or physical relationship.</p><div className="neighbor-list">{neighbors.map(asn => <button key={asn} onClick={() => selectNetwork({ kind: 'asn', asn })}>{provider(asn)}<small>AS{asn}</small><span>↗</span></button>)}</div></div>}
                {!selectedAsn && <div className="detail-section"><h3>{technical ? 'Origin networks' : 'Networks announcing this destination'}</h3><div className="neighbor-list">{originAsns.map(asn => <button key={asn} onClick={() => selectNetwork({ kind: 'asn', asn })}>{provider(asn)}<small>AS{asn}</small><span>↗</span></button>)}</div></div>}
              </>}
            </div>}
            {detailTab === 'routes' && <div className="detail-content"><label className="viewpoint-label">Focus a viewpoint<select aria-label="Focus viewpoint" value={focusPeer} onChange={e => setFocusPeer(e.target.value)}><option value="">Most active viewpoints</option>{rankedPeers.map(peer => <option key={peer.id} value={peer.id}>{provider(peer.asn)} · {peer.ip}</option>)}</select></label><div className="route-list">{selectedRoutes.map(route => <button className="route-card" key={`${route.peer_id}-${route.prefix}`} onClick={() => setFocusPeer(route.peer_id)}><strong>{peerName(route.peer_id)}</strong><p>{pathText(route.as_path)}</p><small>{route.peer_id} · {route.type === 'snapshot' ? 'Present in initial snapshot' : clock(route.timestamp) + ' UTC'}</small></button>)}</div></div>}
            {detailTab === 'history' && <div className="detail-content"><p>{relevantHistory.length} recorded updates involving this selection through {clock(at)} UTC.</p><div className="selection-history">{relevantHistory.map(event => <button key={event.id} onClick={() => inspect(event)}><span>{changeLabel(event)}</span><small>{dateTime(event.timestamp)} · {peerName(event.peer_id)}</small></button>)}</div></div>}
          </section>

          <section className="history-panel" aria-label="Timeline and events">
            <div className="history-heading"><div><span className="eyebrow">FOLLOW THE CHANGES</span><h2>What changed?</h2></div><button className="text-button" onClick={() => { setMode('explore'); setPlaying(false); setAt(meta.end); setActiveEventId(undefined); }}>Latest available ↗</button></div>
            {lastSignificant && <div className="latest-story"><strong>{peerName(lastSignificant.peer_id)} · {plainChange(lastSignificant).toLowerCase()}</strong><p>Before: {pathText(lastSignificant.previous_path)}<br/>After: {pathText(lastSignificant.as_path)}</p><small>{lastSignificant.type === 'withdrawal' ? 'This observer stopped advertising its route. Other observers may still have routes.' : 'A route is advertised after this update. Packet delivery and performance impact are not established.'}</small><button onClick={() => inspect(lastSignificant)}>Inspect this change →</button></div>}
            <div className="view-switch" aria-label="Timeline scope"><button aria-pressed={!allUpdates} onClick={() => { setAllUpdates(false); setFilter(''); }}>Important events</button><button aria-pressed={allUpdates} onClick={() => setAllUpdates(true)}>All BGP updates</button></div>
            <p>{throughNow.length} raw updates · {significant.length} route-state changes · {throughNow.length - significant.length} updates without a route-state change.</p>
            <p className="muted">Important events change the recorded path or add/remove a route for one observer. This is not an assessment of outage severity.</p>
            <div className="time-controls"><button className="icon-button" aria-label="Previous update" disabled={at <= meta.start} onClick={() => jump(previous ?? meta.start)}>←</button><button className="play-button" disabled={!eventTimes.length} onClick={() => { setMode('replay'); if (next === undefined) setAt(meta.start); setPlaying(value => !value); }}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button><button className="icon-button" aria-label="Next update" disabled={next === undefined} onClick={() => next !== undefined && jump(next)}>→</button><time>{dateTime(at)}</time></div>
            <div className="timeline-track"><input aria-label="Replay time" aria-valuetext={dateTime(at)} type="range" min={0} max={meta.end - meta.start} step={1} value={at - meta.start} onChange={e => jump(meta.start + Number(e.target.value))}/><div className="event-markers" aria-hidden="true">{eventTimes.filter((_, index) => index % Math.max(1, Math.ceil(eventTimes.length / 150)) === 0).map(time => <i key={time} style={{ left: `${100 * (time - meta.start) / Math.max(1, meta.end - meta.start)}%` }}/>)}</div><div className="timeline-labels"><span>{dateTime(meta.start)}</span><span>{dateTime(meta.end)}</span></div></div>
            <p className="timeline-help">Ticks and playback follow the selected event scope; dragging selects any second. This is delayed routing history, not live traffic.</p>
            <div className="event-filters"><h3>{allUpdates ? 'Raw updates' : 'Route-state changes'} <span>{filteredEvents.length}</span></h3><select aria-label="Change type" value={filter} onChange={e => setFilter(e.target.value)}><option value="">All changes</option><option value="path-change">Path changes</option><option value="withdrawal">Withdrawals</option><option value="announcement">Announcements</option></select><select aria-label="Event viewpoint" value={eventPeer} onChange={e => setEventPeer(e.target.value)}><option value="">All viewpoints</option>{rankedPeers.map(peer => <option key={peer.id} value={peer.id}>{provider(peer.asn)} · {peer.ip}</option>)}</select></div>
            <div className="event-stream">{filteredEvents.slice(0, historyLimit).map(event => <button className={`event-row ${event.type} ${activeChange?.id === event.id ? 'selected-event' : ''}`} key={event.id} onClick={() => inspect(event)} aria-label={`Inspect update ${event.id}`}><time>{clock(event.timestamp)}<small>{new Date(event.timestamp * 1000).toISOString().slice(5, 10)}</small></time><i/><div><strong>{technical ? changeLabel(event) : plainChange(event)}</strong><p>{peerName(event.peer_id)} <span>· {event.prefix}</span></p>{technical && <small>{event.peer_id} · {event.as_path.join(' → ') || 'withdrawn'}</small>}</div><span className="event-arrow">↗</span></button>)}{!filteredEvents.length && <div className="empty-state">{at === meta.start ? 'You’re at the initial route snapshot.' : 'No recorded changes match these filters.'}<p>Routes can exist before the first update in this window.</p></div>}</div>
            {filteredEvents.length > historyLimit && <button className="more-events" onClick={() => setHistoryLimit(value => value + 40)}>Show more updates ({filteredEvents.length - historyLimit} remaining)</button>}
          </section>
        </div>

        <Measurements technical={technical} destination={({ '1.1.1.0/24': '1.1.1.1', '8.8.8.0/24': '8.8.8.8', '9.9.9.0/24': '9.9.9.9' } as Record<string, string>)[resource] ?? entity?.resolved_address ?? ''} at={at} asn={meta.peers.find(peer => peer.id === (activeChange?.peer_id || focusPeer || captionRoute?.peer_id))?.asn}/>
        <footer><span><i/> RIPE RIS · RRC00 Amsterdam · Partial routing visibility</span><span>Physical connections and reachability are not measured.</span></footer>
      </>}
    </main>
  </div>;
}
