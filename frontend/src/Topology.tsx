import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, Position, useNodesState, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import { providerName } from './providerName';
import { compactPath, pathLinks } from './routeChanges';
import type { Metadata, Route, Selection } from './types';

export default function Topology({ routes, meta, selection, onSelect, technical, change }: {
  routes: Route[]; meta: Metadata; selection: Selection; onSelect: (selection: Selection) => void;
  technical: boolean; change?: Route;
}) {
  const [vertical, setVertical] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setVertical(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const flow = useRef<ReactFlowInstance | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const paths = useMemo(() => {
    const values = routes.map(route => route.as_path);
    if (change?.previous_path?.length) values.push(change.previous_path);
    return values;
  }, [routes, change]);
  const layout = useMemo(() => {
    const layers = new Map<number, number>();
    const lanes = new Map<number, Set<number>>();
    paths.forEach((fullPath, lane) => compactPath(fullPath).forEach((asn, index) => {
      layers.set(asn, Math.max(layers.get(asn) ?? 0, index));
      if (!lanes.has(asn)) lanes.set(asn, new Set());
      lanes.get(asn)!.add(lane);
    }));
    const origins = new Set(paths.map(path => path.at(-1)));
    const liveNodes = new Set(routes.flatMap(route => route.as_path));
    const occupiedY = new Map<number, number>();
    return [...layers].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([asn, column]) => {
      const values = [...lanes.get(asn)!];
      const row = values.reduce((sum, lane) => sum + lane, 0) / values.length;
      const desired = liveNodes.has(asn) ? row : routes.length + 1;
      const gap = vertical ? 220 : 140;
      const cross = Math.max(desired * (vertical ? 240 : 160), (occupiedY.get(column) ?? -gap) + gap);
      occupiedY.set(column, cross);
      const owner = meta.asns.find(network => network.asn === asn)?.name ?? `AS${asn}`;
      const name = providerName(asn, meta.asns);
      return {
        id: String(asn), width: 196, height: 94,
        position: vertical ? { x: cross, y: column * 150 } : { x: column * 290, y: cross },
        sourcePosition: vertical ? Position.Bottom : Position.Right, targetPosition: vertical ? Position.Top : Position.Left,
        className: `${origins.has(asn) ? 'origin-node ' : ''}${!liveNodes.has(asn) ? 'past-node ' : ''}`,
        data: { label: <><span className="node-role">{!liveNodes.has(asn) ? 'Previous path' : origins.has(asn) ? 'Destination network' : 'Observed network'}</span><strong title={owner}>{technical ? `AS${asn}` : name}</strong><span className="node-secondary">{technical ? name : `AS${asn}`}</span></> },
      };
    });
  }, [paths, routes, meta.asns, technical, vertical]);
  useEffect(() => {
    setNodes(current => layout.map(node => ({ ...current.find(n => n.id === node.id), ...node,
      className: `${node.className}${selection.kind === 'asn' && selection.asn === Number(node.id) ? 'chosen' : ''}`,
    })));
  }, [layout, selection, setNodes]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void flow.current?.fitView({ padding: .23, duration: 200 }); });
    return () => window.cancelAnimationFrame(frame);
  }, [layout]);
  const edges = useMemo(() => {
    const result = new Map<string, Edge>();
    const before = pathLinks(change?.previous_path ?? []);
    const after = pathLinks(change?.as_path ?? []);
    const changed = (id: string) => change && !before.has(id) && after.has(id);
    for (const route of routes) for (const id of pathLinks(route.as_path)) {
      const [source, target] = id.split('-');
      result.set(id, { id, source, target, style: { stroke: changed(id) ? '#69e3b0' : '#668db5', strokeWidth: changed(id) ? 3 : 2 }, ariaLabel: `Observed path from AS${source} to AS${target}` });
    }
    for (const id of before) if (!after.has(id)) {
      const [source, target] = id.split('-');
      // An old adjacency can still exist in another peer's current route.
      if (result.has(id)) continue;
      result.set(id, { id, source, target, style: { stroke: '#e6b775', strokeWidth: 2, strokeDasharray: '6 5' }, ariaLabel: `Previous observed path from AS${source} to AS${target}` });
    }
    return [...result.values()];
  }, [routes, change]);
  return <div className="graph">
    {!paths.some(path => path.length) && <div className="graph-empty">No route is advertised by the selected viewpoints at this time.<span>Choose another viewpoint or move the timeline.</span></div>}
    <ReactFlow onInit={instance => { flow.current = instance; }} nodes={nodes} onNodesChange={onNodesChange} edges={edges} fitView fitViewOptions={{ padding: .23 }}
      minZoom={0.12} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
      onNodeClick={(_, node) => onSelect({ kind: 'asn', asn: Number(node.id) })}>
      <Background color="#243244" gap={26} size={1}/><Controls position="bottom-right" showInteractive={false}/>
    </ReactFlow>
  </div>;
}
