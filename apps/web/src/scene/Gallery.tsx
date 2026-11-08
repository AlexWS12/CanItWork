import { useThree } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import type { OrbitControls as Controls } from 'three-stdlib';
import { Tag } from '../domains/shared';
import { Model, type ModelId } from './Model';

// Development only: every pack model in a labelled grid, each fitted to the same footprint, to judge them side by side.
// Open the app at #gallery; `npm run capture -w @tv/web -- <label> --gallery` pictures it.

const COLUMNS = 10;
const GAP = 4;

export function Gallery() {
  const [ids, setIds] = useState<ModelId[]>([]);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as Controls | null;
  useEffect(() => {
    void fetch('/models/manifest.json')
      .then((r) => r.json())
      .then(setIds);
  }, []);
  const rows = Math.ceil(ids.length / COLUMNS);
  useEffect(() => {
    camera.position.set(0, rows * GAP * 0.95, rows * GAP * 0.75);
    camera.lookAt(0, 0, 0);
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [rows, camera, controls]);
  return (
    <group>
      {ids.map((id, i) => {
        const x = ((i % COLUMNS) - (COLUMNS - 1) / 2) * GAP;
        const z = (Math.floor(i / COLUMNS) - (rows - 1) / 2) * GAP;
        return (
          <group key={id} position={[x, 0, z]}>
            <Model id={id} width={2.6} play={id.startsWith('characters/') ? 'idle' : undefined} />
            <Tag text={id.split('/')[1]} tint="#c9d2dc" y={-0.2} />
          </group>
        );
      })}
    </group>
  );
}
