import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Tag } from '../domains/shared';
import { reducedMotion } from '../motion';
import { LOOK } from './look';

// What a part looks like when the views have no model for it: a glassy volume of its size, outlined in dashes, labelled as a placeholder.
// It reads as deliberate rather than broken, and it still takes clicks, drags and fault rings like any drawn part.

const fill = new THREE.MeshStandardMaterial({ color: '#2b3038', transparent: true, opacity: 0.32, roughness: 0.2, metalness: 0.1, depthWrite: false });

interface UnknownProps {
  /** Width, height and depth of the volume, standing on the floor. */
  size?: [number, number, number];
  /** What the part is called, shown with "placeholder". */
  label?: string;
  /** Hides the label where the view already names the part. */
  quiet?: boolean;
}

export function Unknown({ size = [1.6, 1.2, 1.4], label, quiet = false }: UnknownProps) {
  const [w, h, d] = size;
  const edges = useMemo(() => {
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const material = new THREE.LineDashedMaterial({ color: LOOK.accent, dashSize: Math.max(0.08, w / 10), gapSize: Math.max(0.05, w / 16), transparent: true });
    const lines = new THREE.LineSegments(geometry, material);
    lines.computeLineDistances();
    return lines;
  }, [w, h, d]);
  const time = useRef(0);
  useFrame((_, dt) => {
    time.current += dt;
    const material = edges.material as THREE.LineDashedMaterial;
    material.opacity = reducedMotion() ? 0.9 : 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(time.current * 2.2));
  });
  return (
    <group position={[0, h / 2, 0]}>
      <mesh material={fill}>
        <boxGeometry args={[w, h, d]} />
      </mesh>
      <primitive object={edges} />
      {/* A small marker on top, so a placeholder reads as one at any distance */}
      <mesh position={[0, h / 2 + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[Math.min(w, d) * 0.16, Math.min(w, d) * 0.22, 24]} />
        <meshBasicMaterial color={LOOK.accent} transparent opacity={0.85} />
      </mesh>
      {label && !quiet && <Tag text={`${label} · placeholder`} tint={LOOK.accent} y={h / 2 + 0.6} />}
    </group>
  );
}
