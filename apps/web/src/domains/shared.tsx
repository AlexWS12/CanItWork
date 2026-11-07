import type { Finding } from '@tv/core';
import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { select, useStore } from '../store';

export const pick = (id: string) => (e: ThreeEvent<MouseEvent>) => {
  e.stopPropagation();
  select(id);
};

export function Tag({ text, tint, y = 1.1 }: { text: string; tint: string; y?: number }) {
  return (
    <Html position={[0, y, 0]} center zIndexRange={[10, 0]}>
      <div className="scene-tag" style={{ ['--tag' as string]: tint }}>
        {text}
      </div>
    </Html>
  );
}

const MAX_PINS = 3;

// The part a claim is about: "orders.email" is the orders table, "api->db" starts at api
const targetOf = (finding: Finding) => finding.incident.target?.split(/->|\./)[0];
const projected = new THREE.Vector3();

/** Pins the Red Team's claim about this part over it in the scene, if there is one */
export function ClaimPin({ id, position = [0, 0, 0] }: { id: string; position?: [number, number, number] }) {
  const anchor = useRef<THREE.Group>(null);
  const pin = useRef<HTMLDivElement>(null);
  // Cards on the right half of the screen open leftwards, so they stay clear of the right panel
  useFrame(({ camera }) => {
    if (!anchor.current || !pin.current) return;
    anchor.current.getWorldPosition(projected).project(camera);
    const side = projected.x > 0 ? 'left' : 'right';
    if (pin.current.dataset.side !== side) pin.current.dataset.side = side;
  });
  const findings = useStore((s) => s.findings);
  const sheetOpen = useStore((s) => Boolean(s.report) && s.reportOpen);
  const pinned = findings.filter(targetOf).slice(0, MAX_PINS);
  const index = pinned.findIndex((f) => targetOf(f) === id);
  if (index < 0 || sheetOpen) return null;
  const finding = pinned[index];
  const confirmed = finding.verdict === 'confirmed';
  return (
    <group ref={anchor} position={position}>
      <Html zIndexRange={[20, 11]} pointerEvents="none">
        <div ref={pin} className="claim-pin" data-verdict={finding.verdict}>
          <button className="claim-card" onClick={() => select(id)}>
            <span className="claim-kicker">Red Team · {confirmed ? 'Confirmed' : 'Refuted'}</span>
            <span>
              {finding.claim} {finding.evidence}
            </span>
          </button>
          <span className="claim-leader" aria-hidden />
          <span className="claim-dot" aria-hidden />
        </div>
      </Html>
    </group>
  );
}
