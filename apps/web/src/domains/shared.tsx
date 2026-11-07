import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { select } from '../store';

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
