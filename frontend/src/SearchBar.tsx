import { useEffect, useRef, useState, type FormEvent } from 'react';
import { providerName } from './providerName';

export type NetworkEntity = {
  kind: 'network' | 'asn'; asn: number; name: string; prefixes: string[];
  prefix?: string; prefix_count?: number; origin_asns?: number[];
  resolved_address?: string; source_url: string;
};
type SearchResponse = { query: string; results: NetworkEntity[]; notice: string };
export const entityName = (entity: NetworkEntity) => providerName(entity.asn, [{ asn: entity.asn, name: entity.name, role: '' }]);

export default function SearchBar({ onExplore, resource }: { resource: string; onExplore: (entity: NetworkEntity, prefix: string) => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => { request.current?.abort(); setQuery(''); setOpen(false); setBusy(false); }, [resource]);
  async function search(value: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setOpen(true); setError(''); setResult(undefined);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(value)}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || 'Search is unavailable');
      if (!controller.signal.aborted) setResult(body);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Search failed');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (query.trim()) void search(query); }
  function choose(entity: NetworkEntity, prefix: string) {
    onExplore(entity, prefix); setQuery(entityName(entity)); setOpen(false);
  }
  return <div className="search-shell">
    <form role="search" onSubmit={submit}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
      <input aria-label="Search the Internet" placeholder="Search IP, ASN, company or domain" value={query}
        onChange={e => setQuery(e.target.value)} onFocus={() => setOpen(true)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}/>
      <button type="submit" disabled={!query.trim() || busy}>{busy ? 'Searching…' : 'Search'}</button>
    </form>
    {open && <div className="search-results" role="region" aria-label="Search results">
      <div className="search-results-heading"><strong>Search the Internet</strong><button className="icon-button" aria-label="Close search results" onClick={() => setOpen(false)}>×</button></div>
      {!result && !busy && !error && <><p>Find a network by address, name, ASN or domain.</p><div className="search-examples">{['1.1.1.1', 'AS13335', 'Cloudflare', 'google.com', '8.8.8.8'].map(example => <button key={example} onClick={() => { setQuery(example); void search(example); }}>{example}</button>)}</div></>}
      {busy && <p role="status">Looking up public routing records…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {result && <><p className="search-notice">{result.notice}</p>{result.results.length === 0 && <p>No matching networks found. Try an ASN or public IP address.</p>}
        <div className="search-list">{result.results.map(entity => <div className="search-entity" key={`${entity.asn}-${entity.prefix ?? 'network'}`}>
          {entity.kind === 'asn' ? <button className="network-result" onClick={() => void search(`AS${entity.asn}`)}><strong>{entityName(entity)}</strong><span>AS{entity.asn} · Choose a destination →</span></button> : <>
            <div className="result-label"><a href={entity.source_url} target="_blank" rel="noreferrer">RIPEstat source ↗</a><strong>{entityName(entity)}</strong><span>AS{entity.asn}{entity.resolved_address ? ` · DNS address ${entity.resolved_address}` : ''}</span></div>
            {entity.prefixes.length ? <div className="prefix-results">{entity.prefixes.map(prefix => <button key={prefix} onClick={() => choose(entity, prefix)}><span>{prefix}</span><span>Explore →</span></button>)}</div> : <p>No currently observed prefixes available for this network.</p>}
            {entity.prefix_count !== undefined && <small>{entity.prefix_count.toLocaleString()} prefixes in the source's latest snapshot · showing up to 30</small>}
          </>}
        </div>)}</div>
      </>}
    </div>}
  </div>;
}
