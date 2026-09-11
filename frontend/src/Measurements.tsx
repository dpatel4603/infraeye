import { useEffect, useState } from 'react';

type Sample = { timestamp: number; median_rtt: number | null; packet_loss: number | null; samples: number[] };
type Probe = { id: number; asn: number | null; country: string | null };
type Result = { target: string; probe: Probe | null; probes: Probe[]; measurement_id: number | null; samples: Sample[]; notice: string; trace_error?: string; traceroute: null | { measurement_id: number; timestamp: number; hops: { hop: number; replies: { ip?: string; rtt?: number }[] }[] } };
const stamp = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const value = (n: number | null, unit: string) => n === null ? 'Unavailable' : `${n.toFixed(1)} ${unit}`;
const link = (id: number) => `https://atlas.ripe.net/measurements/${id}/`;

export default function Measurements({ destination, at, asn, technical }: { destination: string; at: number; asn?: number; technical: boolean }) {
  const [configure, setConfigure] = useState(false);
  const [draft, setDraft] = useState(destination);
  const [target, setTarget] = useState(destination);
  const [probeId, setProbeId] = useState<number>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setDraft(destination); setTarget(destination); setProbeId(undefined); setResult(undefined); }, [destination]);
  useEffect(() => {
    setResult(undefined); setError('');
    if (!target) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ target, at: String(at) });
      if (asn) params.set('asn', String(asn));
      if (probeId) params.set('probe_id', String(probeId));
      fetch(`/api/atlas?${params}`, { signal: controller.signal }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || 'Atlas request failed');
        return body as Result;
      }).then(body => { setResult(body); if (body.probe && !probeId) setProbeId(body.probe.id); })
        .catch(err => { if (!controller.signal.aborted) setError(err.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [target, at, asn, probeId, reload]);
  const latest = result?.samples.at(-1);
  const first = result?.samples.find(s => s.median_rtt !== null);
  const delta = latest?.median_rtt != null && first?.median_rtt != null && first.timestamp !== latest.timestamp ? latest.median_rtt - first.median_rtt : null;
  return <section className="measurement-panel" aria-label="RIPE Atlas measurements">
    <div className="history-heading"><div><span className="eyebrow">MEASURED SEPARATELY · RIPE ATLAS</span><h2>What did the measurement probe experience?</h2></div><span className="observed-tag">Public measurements</span></div>
    <p>BGP paths do not measure latency. Atlas measures round-trip time from a specific probe to an exact IP.</p>
    {!technical && <button aria-expanded={configure} onClick={() => setConfigure(v => !v)}>{configure ? 'Hide measurement controls' : 'Choose measurement viewpoint'}</button>}
    {(technical || configure) && <form className="measurement-controls" onSubmit={e => { e.preventDefault(); setTarget(draft.trim()); setProbeId(undefined); setReload(n => n + 1); }}><label>Destination IP<input aria-label="Measurement destination IP" placeholder="e.g. 8.8.8.8" value={draft} onChange={e => setDraft(e.target.value)}/></label><button type="submit">Find measurements</button></form>}
    <p className="muted">One hour ending {stamp(at)} · BGP viewpoint {asn ? `AS${asn}` : 'not selected'}. Only existing public results are retrieved.</p>
    {!target && <p>Choose an exact destination IP to look for performance measurements. A whole address range cannot be pinged.</p>}
    {loading && <p role="status">Finding Atlas observations…</p>}{error && <p role="alert">{error}</p>}
    {result && <>
      {(technical || configure) && <label className="viewpoint-label">Measurement probe<select aria-label="Measurement probe" value={probeId ?? ''} onChange={e => setProbeId(e.target.value ? Number(e.target.value) : undefined)}><option value="">Select a probe</option>{result.probes.map(p => <option key={p.id} value={p.id}>#{p.id} · {p.asn ? `AS${p.asn}` : 'ASN unknown'} · {p.country ?? 'country unknown'}{p.asn === asn ? ' · ASN matches' : ''}</option>)}</select></label>}
      {!result.probe && <p><strong>Performance is not established for this routing viewpoint.</strong> No matching probe was selected. You can choose another probe to inspect its separate measurements.</p>}
      {(technical || configure) && <p className="muted">{result.notice}</p>}
      {result.probe && <>
        <p><a href={`https://atlas.ripe.net/probes/${result.probe.id}/`} target="_blank" rel="noreferrer">Probe #{result.probe.id} ↗</a> · AS{result.probe.asn ?? '?'} · {result.probe.country ?? 'Unknown country'} · {result.probe.asn === asn ? 'ASN matches BGP viewpoint; probe is a different observer.' : 'Different or unknown ASN — these measurements are not the selected BGP observer’s latency.'}</p>
        {latest ? <><div className="measurement-metrics"><div><strong>{value(latest.median_rtt, 'ms')}</strong><span>median RTT · last ping</span></div><div><strong>{value(latest.packet_loss, '%')}</strong><span>packet loss · last ping</span></div><div><strong>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} ms`}</strong><span>first → last valid RTT</span></div></div><p>Measured {stamp(latest.timestamp)} · {Math.max(0, Math.round((at - latest.timestamp) / 60))} min before replay time.</p>
          <details><summary>RTT over time · {result.samples.length} ping results</summary><div className="measurement-table"><table><thead><tr><th>Time (UTC)</th><th>Median RTT</th><th>Loss</th></tr></thead><tbody>{result.samples.map((s, i) => <tr key={`${s.timestamp}-${i}`}><td>{stamp(s.timestamp)}</td><td>{value(s.median_rtt, 'ms')}</td><td>{value(s.packet_loss, '%')}</td></tr>)}</tbody></table></div></details></> : <p>No ping results for this probe and IP in the hour before this replay time.</p>}
        {result.measurement_id && <a href={link(result.measurement_id)} target="_blank" rel="noreferrer">Original ping measurement #{result.measurement_id} ↗</a>}
        {result.traceroute ? <details><summary>Traceroute · {stamp(result.traceroute.timestamp)}</summary><p>Hop RTTs are round trips to each replying router, not per-link delays. Missing replies and slow replies can reflect filtering or low probe priority.</p><ol>{result.traceroute.hops.map(h => <li key={h.hop} value={h.hop}>{h.replies.map((r, i) => <span key={i}>{r.ip ?? '*'} {r.rtt == null ? '(no RTT)' : `${r.rtt.toFixed(1)} ms`}{' · '}</span>)}</li>)}</ol><a href={link(result.traceroute.measurement_id)} target="_blank" rel="noreferrer">Original traceroute ↗</a></details> : <p>{result.trace_error ?? 'No matching traceroute found for this probe and hour in the first three ongoing public measurements.'}</p>}
      </>}
    </>}
    <p className="muted">Anycast can reach different sites from different probes. Compare the same probe and destination over time. RTT is not one-way delay; coincident route and RTT changes do not prove causation.</p>
  </section>;
}
