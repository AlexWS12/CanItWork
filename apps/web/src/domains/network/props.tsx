import { useFrame } from '@react-three/fiber';
import type { NetRun } from '@tv/core';
import { useMemo, useRef, type FC } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { Blink, Box, Crowd, Cyl, FINISH, Gable, Person, Plane, Smoke, Spinner, Truck, Windows, mat } from '../../scene/kit';

// One recognisable model per kind of node, for the seven flow-network domains (power, water, supply, hospital, factory, airport,
// call centre). Each fits a footprint about 3.4 units across, stands on y = 0, takes the kind's tint for its accents, and reads its
// node's live state: turbines turn with output, stacks smoke harder under load, beacons blink, and a node that is down goes dark.

// The current run if it is a flow network; while the view switches kinds of system, the runner may already hold another
const net = () => {
  const run = runner.run as NetRun | null;
  return run && 'links' in run && 'states' in run ? run : null;
};

export interface PropProps {
  id: string;
  tint: string;
}

/** How hard the node is working, 0 when idle or down, about 1 at capacity. */
export const loadOf = (id: string) => {
  const state = net()?.states?.get(id);
  return !state || state.down ? 0 : Math.min(1.5, state.utilization);
};
const upOf = (id: string) => !net()?.states?.get(id)?.down;

// ---- Power -------------------------------------------------------------------------------------------------------

const CoalPlant: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Box size={[2, 1.2, 1.6]} at={[-0.4, 0.6, 0.1]} m={FINISH.concrete()} />
    <Box size={[2.05, 0.12, 1.65]} at={[-0.4, 1.26, 0.1]} m={FINISH.roof()} />
    <Windows w={1.6} cols={5} at={[-0.4, 0.75, 0.91]} />
    {[-0.45, 0.45].map((z) => (
      <group key={z}>
        <Cyl r={0.3} r2={0.22} h={3} at={[1.05, 1.5, z]} m={FINISH.plaster()} />
        <Cyl r={0.23} h={0.25} at={[1.05, 2.8, z]} m={mat(tint)} />
        <Smoke at={[1.05, 3.05, z]} tint="#c4c9d1" rate={() => loadOf(id)} />
      </group>
    ))}
    <mesh position={[-1.2, 0.28, -0.95]} material={mat('#24262b', { rough: 1 })} castShadow>
      <coneGeometry args={[0.55, 0.56, 14]} />
    </mesh>
  </group>
);

const GasPlant: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Box size={[2.2, 1, 1.4]} at={[-0.2, 0.5, 0]} m={FINISH.steel()} />
    <Box size={[2.25, 0.08, 1.45]} at={[-0.2, 1.04, 0]} m={mat(tint, { metal: 0.4, rough: 0.4 })} />
    <Windows w={1.8} cols={6} at={[-0.2, 0.6, 0.71]} />
    <Cyl r={0.16} r2={0.13} h={2.6} at={[1.15, 1.3, -0.3]} m={FINISH.steel()} />
    <Smoke at={[1.15, 2.6, -0.3]} tint="#d9dde3" rate={() => loadOf(id)} />
    {[-0.5, 0.15].map((x) => (
      <Cyl key={x} r={0.3} h={1} at={[x, 0.32, -1.15]} rot={[0, 0, Math.PI / 2]} m={FINISH.white()} />
    ))}
  </group>
);

function coolingTower() {
  const points = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    points.push(new THREE.Vector2(0.95 - 0.38 * Math.sin(t * Math.PI * 0.85) + 0.05 * t, t * 2.6));
  }
  return new THREE.LatheGeometry(points, 28);
}

const NuclearPlant: FC<PropProps> = ({ id, tint }) => {
  const tower = useMemo(coolingTower, []);
  return (
    <group>
      <mesh geometry={tower} position={[-0.55, 0, 0]} material={FINISH.plaster()} castShadow receiveShadow />
      <Smoke at={[-0.55, 2.6, 0]} tint="#eef0f3" rate={() => loadOf(id)} />
      <Cyl r={0.5} h={0.8} at={[0.95, 0.4, 0.3]} m={FINISH.concrete()} />
      <mesh position={[0.95, 0.8, 0.3]} material={mat(tint, { rough: 0.5 })} castShadow>
        <sphereGeometry args={[0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      <Box size={[0.9, 0.6, 0.6]} at={[0.9, 0.3, -0.75]} m={FINISH.concrete()} />
    </group>
  );
};

const SolarFarm: FC<PropProps> = () => (
  <group>
    {[-1, 0, 1].flatMap((x) =>
      [-0.75, 0.55].map((z) => (
        <group key={`${x}:${z}`} position={[x * 1.05, 0, z]}>
          <Cyl r={0.04} h={0.45} at={[0, 0.22, 0]} m={FINISH.steel()} seg={8} />
          <mesh position={[0, 0.5, 0]} rotation={[-0.55, 0, 0]} castShadow receiveShadow material={mat('#1c3561', { metal: 0.6, rough: 0.2 })}>
            <boxGeometry args={[0.95, 0.04, 0.95]} />
          </mesh>
          <mesh position={[0, 0.5, 0.005]} rotation={[-0.55, 0, 0]} material={FINISH.steel()}>
            <boxGeometry args={[0.98, 0.03, 0.98]} />
          </mesh>
        </group>
      )),
    )}
  </group>
);

function Turbine({ at, id, height = 3 }: { at: [number, number, number]; id: string; height?: number }) {
  return (
    <group position={at}>
      <Cyl r={0.1} r2={0.06} h={height} at={[0, height / 2, 0]} m={FINISH.white()} seg={12} />
      <Box size={[0.35, 0.16, 0.16]} at={[0, height, 0]} m={FINISH.white()} />
      <Spinner at={[0.2, height, 0]} axis="x" speed={() => 0.6 + loadOf(id) * 3}>
        {[0, 1, 2].map((i) => (
          <group key={i} rotation={[(i * Math.PI * 2) / 3, 0, 0]}>
            <mesh position={[0, 0.6, 0]} material={FINISH.white()} castShadow>
              <boxGeometry args={[0.04, 1.2, 0.12]} />
            </mesh>
          </group>
        ))}
      </Spinner>
    </group>
  );
}

function TurbineFarm({ id }: PropProps) {
  return (
    <group>
      {(
        [
          [-0.9, -0.6],
          [0.7, -0.9],
          [0.2, 0.8],
        ] as const
      ).map(([x, z], i) => (
        <Turbine key={i} at={[x, 0, z]} id={id} height={2.6 + i * 0.3} />
      ))}
    </group>
  );
}

function Pylon({ at = [0, 0, 0] as [number, number, number], height = 3 }) {
  const steel = FINISH.steel();
  return (
    <group position={at}>
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * 0.22, height / 2, sz * 0.22]} rotation={[sz * 0.09, 0, -sx * 0.09]} material={steel} castShadow>
          <boxGeometry args={[0.05, height, 0.05]} />
        </mesh>
      ))}
      {[0.55, 0.78].map((f, i) => (
        <Box key={i} size={[1.5 - i * 0.4, 0.05, 0.06]} at={[0, height * f, 0]} m={steel} />
      ))}
      {[-0.65, 0.65, -0.45, 0.45].map((x, i) => (
        <Cyl key={i} r={0.04} h={0.22} at={[x, height * (i < 2 ? 0.55 : 0.78) - 0.12, 0]} m={mat('#a9c7d8', { rough: 0.3 })} seg={8} />
      ))}
    </group>
  );
}

const Substation: FC<PropProps> = ({ tint }) => (
  <group>
    {[
      [0, -1.3, 2.6, 0.05],
      [0, 1.3, 2.6, 0.05],
      [-1.3, 0, 0.05, 2.6],
      [1.3, 0, 0.05, 2.6],
    ].map(([x, z, w, d], i) => (
      <Box key={i} size={[w, 0.45, d]} at={[x, 0.22, z]} m={mat('#7d848f', { metal: 0.5, rough: 0.5, opacity: 0.55 })} shadow={false} />
    ))}
    {[-0.55, 0.55].map((x) => (
      <group key={x} position={[x, 0, 0.35]}>
        <Box size={[0.75, 0.75, 0.55]} at={[0, 0.38, 0]} m={mat(tint, { metal: 0.4, rough: 0.5 })} />
        {[-0.2, 0, 0.2].map((ix) => (
          <Cyl key={ix} r={0.04} h={0.35} at={[ix, 0.92, 0]} m={mat('#b9cfdc', { rough: 0.3 })} seg={8} />
        ))}
      </group>
    ))}
    <Pylon at={[0, 0, -0.6]} height={1.9} />
  </group>
);

const Feeder: FC<PropProps> = () => (
  <group>
    <Pylon at={[0, 0, 0]} height={3.1} />
  </group>
);

/** Houses, and in a city a couple of taller blocks; windows glow with the demand the node is drawing. */
function Neighbourhood({ id, tint, city = false }: PropProps & { city?: boolean }) {
  const houses: Array<[number, number, number]> = [
    [-1, -0.8, 0.9],
    [0.15, -0.95, 0.8],
    [-1.1, 0.55, 0.85],
    [1.05, 0.7, 0.9],
  ];
  return (
    <group>
      {houses.map(([x, z, s], i) => (
        <group key={i} position={[x, 0, z]} scale={s}>
          <Box size={[0.9, 0.6, 0.75]} at={[0, 0.3, 0]} m={i % 2 ? FINISH.plaster() : mat('#d8c7a8', { rough: 0.85 })} />
          <Gable w={0.95} d={0.82} h={0.42} at={[0, 0.6, 0]} m={mat(tint, { rough: 0.8 })} />
          <Windows w={0.7} cols={2} at={[0, 0.32, 0.38]} />
        </group>
      ))}
      {city && (
        <>
          <Box size={[0.8, 2.4, 0.8]} at={[0.35, 1.2, 0.05]} m={FINISH.glass()} />
          <Windows w={0.7} rows={6} cols={3} at={[0.35, 0.35, 0.46]} />
          <Box size={[0.7, 1.6, 0.7]} at={[-0.15, 0.8, 1.05]} m={FINISH.concrete()} />
          <Windows w={0.6} rows={4} cols={3} at={[-0.15, 0.35, 1.41]} />
        </>
      )}
      <WindowGlow id={id} />
    </group>
  );
}

// Windows across the scene share one material; a neighbourhood's demand brightens it a little
function WindowGlow({ id }: { id: string }) {
  useFrame(() => {
    const m = FINISH.window();
    m.emissiveIntensity = upOf(id) ? 0.9 + Math.min(1, loadOf(id)) * 0.7 : 0.15;
  });
  return null;
}

const Industry: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Box size={[2.4, 0.9, 1.6]} at={[-0.2, 0.45, 0]} m={FINISH.concrete()} />
    {[-0.9, -0.2, 0.5].map((x) => (
      <Gable key={`r${x}`} w={1.6} d={0.7} h={0.38} at={[x, 0.9, 0]} m={mat(tint, { rough: 0.7 })} />
    ))}
    <Windows w={2} cols={6} at={[-0.2, 0.5, 0.81]} />
    <Cyl r={0.17} r2={0.13} h={2.4} at={[1.25, 1.2, -0.5]} m={FINISH.concrete()} />
    <Smoke at={[1.25, 2.4, -0.5]} tint="#c4c9d1" rate={() => loadOf(id)} />
  </group>
);

// ---- Water ---------------------------------------------------------------------------------------------------------

function Water({ r, at, id }: { r: number; at: [number, number, number]; id?: string }) {
  const surface = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const level = id ? 0.75 + 0.2 * Math.min(1, loadOf(id)) : 0.85;
    surface.current.position.y = at[1] * level + Math.sin(clock.elapsedTime * 0.8) * 0.01;
  });
  return (
    <mesh ref={surface} position={at} rotation={[-Math.PI / 2, 0, 0]} material={FINISH.water()} receiveShadow>
      <circleGeometry args={[r, 32]} />
    </mesh>
  );
}

const Reservoir: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Cyl r={1.6} r2={1.55} h={0.45} at={[0, 0.22, 0]} m={mat('#6f6a5e', { rough: 1 })} open seg={36} />
    <Water r={1.56} at={[0, 0.4, 0]} id={id} />
    <Cyl r={0.2} h={0.9} at={[1.1, 0.45, -0.8]} m={mat(tint, { rough: 0.6 })} />
  </group>
);

const Well: FC<PropProps> = ({ id, tint }) => {
  const arm = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    arm.current.rotation.z = upOf(id) && runner.running ? Math.sin(clock.elapsedTime * (1 + loadOf(id) * 2)) * 0.25 : 0;
  });
  return (
    <group>
      <Box size={[0.9, 0.6, 0.8]} at={[-0.8, 0.3, 0.4]} m={FINISH.plaster()} />
      <Gable w={0.95} d={0.85} h={0.35} at={[-0.8, 0.6, 0.4]} m={mat(tint)} />
      <Box size={[0.25, 1, 0.25]} at={[0.5, 0.5, -0.2]} m={FINISH.darkSteel()} />
      <group ref={arm} position={[0.5, 1.05, -0.2]}>
        <Box size={[1.6, 0.14, 0.14]} at={[0, 0, 0]} m={mat(tint, { metal: 0.4 })} />
        <Box size={[0.2, 0.35, 0.2]} at={[0.8, -0.1, 0]} m={FINISH.darkSteel()} />
      </group>
      <Cyl r={0.08} h={0.8} at={[1.3, 0.4, -0.2]} m={FINISH.steel()} seg={10} />
    </group>
  );
};

const Treatment: FC<PropProps> = ({ id }) => (
  <group>
    {[-0.75, 0.85].map((x) => (
      <group key={x} position={[x, 0, x > 0 ? 0.55 : -0.45]}>
        <Cyl r={0.75} h={0.35} at={[0, 0.17, 0]} m={FINISH.concrete()} open seg={28} />
        <Water r={0.72} at={[0, 0.3, 0]} />
        <Spinner at={[0, 0.38, 0]} axis="y" speed={() => (upOf(id) ? 0.5 : 0)}>
          <Box size={[1.4, 0.06, 0.08]} m={FINISH.steel()} />
        </Spinner>
      </group>
    ))}
    <Box size={[0.9, 0.7, 0.7]} at={[-0.4, 0.35, 1.05]} m={FINISH.plaster()} />
    <Box size={[0.95, 0.08, 0.75]} at={[-0.4, 0.74, 1.05]} m={FINISH.roof()} />
  </group>
);

const PumpHouse: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Box size={[1.4, 0.9, 1.1]} at={[-0.3, 0.45, 0]} m={FINISH.plaster()} />
    <Box size={[1.5, 0.1, 1.2]} at={[-0.3, 0.95, 0]} m={mat(tint, { rough: 0.6 })} />
    <Windows w={1} cols={3} at={[-0.3, 0.55, 0.56]} />
    {[-0.35, 0.35].map((z) => (
      <Cyl key={z} r={0.13} h={1.6} at={[0.9, 0.25, z]} rot={[0, 0, Math.PI / 2]} m={mat('#2f6f9f', { metal: 0.5, rough: 0.35 })} />
    ))}
    <Spinner at={[0.55, 0.55, 0]} axis="x" speed={() => loadOf(id) * 6}>
      <Cyl r={0.2} h={0.25} rot={[0, 0, Math.PI / 2]} m={FINISH.darkSteel()} seg={6} />
    </Spinner>
  </group>
);

const WaterTower: FC<PropProps> = ({ id, tint }) => (
  <group>
    {[
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].map(([sx, sz], i) => (
      <Cyl key={i} r={0.06} h={2.2} at={[sx * 0.45, 1.1, sz * 0.45]} m={FINISH.steel()} seg={8} />
    ))}
    <Cyl r={0.75} h={0.9} at={[0, 2.5, 0]} m={FINISH.white()} />
    <Cyl r={0.76} h={0.18} at={[0, 2.4, 0]} m={mat(tint, { rough: 0.5 })} />
    <mesh position={[0, 2.95, 0]} material={FINISH.white()} castShadow>
      <coneGeometry args={[0.78, 0.35, 20]} />
    </mesh>
    <Blink at={[0, 3.2, 0]} color="#ff4b3e" rate={0.6} on={() => upOf(id)} />
  </group>
);

// ---- Supply chain ----------------------------------------------------------------------------------------------------

const Port: FC<PropProps> = ({ tint }) => {
  const containers = ['#c9472f', '#2f6fc9', '#c9a42f', '#3f9f5f', '#8f4fc9'];
  return (
    <group>
      <mesh position={[0.4, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} material={FINISH.water()} receiveShadow>
        <planeGeometry args={[1.9, 3.2]} />
      </mesh>
      <Box size={[1.3, 0.2, 3.2]} at={[-1, 0.1, 0]} m={FINISH.concrete()} />
      {/* Ship */}
      <Box size={[0.9, 0.45, 2.6]} at={[0.55, 0.25, 0]} m={mat('#2c3440', { metal: 0.3, rough: 0.6 })} />
      <Box size={[0.6, 0.6, 0.4]} at={[0.55, 0.75, 1.05]} m={FINISH.white()} />
      {containers.map((c, i) => (
        <Box key={i} size={[0.7, 0.28, 0.42]} at={[0.55, 0.62 + (i % 2) * 0.28, -1 + Math.floor(i / 2) * 0.48]} m={mat(c, { rough: 0.7 })} />
      ))}
      {/* Gantry crane */}
      {[-0.7, 0.7].map((z) => (
        <Box key={z} size={[0.1, 2.2, 0.1]} at={[-1.25, 1.1, z]} m={mat(tint, { metal: 0.5, rough: 0.4 })} />
      ))}
      <Box size={[2.4, 0.14, 0.18]} at={[-0.35, 2.2, 0]} m={mat(tint, { metal: 0.5, rough: 0.4 })} />
      <Box size={[0.12, 0.6, 0.12]} at={[0.3, 1.85, 0]} m={FINISH.darkSteel()} />
      {/* Stacks on the quay */}
      {[0, 1, 2].map((i) => (
        <Box key={`q${i}`} size={[0.42, 0.28, 0.7]} at={[-1.1, 0.34 + i * 0.28, -1.15]} m={mat(containers[(i + 2) % 5], { rough: 0.7 })} />
      ))}
    </group>
  );
};

const Distribution: FC<PropProps> = ({ tint }) => (
  <group>
    <Box size={[2.6, 1.1, 1.6]} at={[0, 0.55, -0.45]} m={FINISH.plaster()} />
    <Box size={[2.65, 0.1, 1.65]} at={[0, 1.12, -0.45]} m={mat(tint, { rough: 0.6 })} />
    {[-0.8, 0, 0.8].map((x) => (
      <Box key={x} size={[0.55, 0.6, 0.04]} at={[x, 0.3, 0.37]} m={FINISH.darkSteel()} />
    ))}
    <Truck at={[-0.4, 0, 1.15]} rot={Math.PI / 2} />
    <Truck at={[0.75, 0, 1.15]} rot={Math.PI / 2} tint="#d8dbe0" />
  </group>
);

const Store: FC<PropProps> = ({ tint }) => (
  <group>
    {[-0.85, 0.85].map((x, i) => (
      <group key={x} position={[x, 0, i ? 0.4 : -0.3]}>
        <Box size={[1.4, 1, 1.1]} at={[0, 0.5, 0]} m={i ? FINISH.plaster() : mat('#cdb99a', { rough: 0.8 })} />
        <Box size={[1.45, 0.1, 1.15]} at={[0, 1.05, 0]} m={FINISH.roof()} />
        <Box size={[1.1, 0.5, 0.04]} at={[0, 0.35, 0.56]} m={FINISH.window()} />
        <mesh position={[0, 0.72, 0.68]} rotation={[0.5, 0, 0]} material={mat(tint, { rough: 0.7 })} castShadow>
          <boxGeometry args={[1.3, 0.04, 0.35]} />
        </mesh>
      </group>
    ))}
    <Crowd count={3} radius={0.5} at={[0, 0, 1.3]} seed={3} />
  </group>
);

// ---- Hospital --------------------------------------------------------------------------------------------------------

function Ambulance({ at, rot = 0, id }: { at: [number, number, number]; rot?: number; id: string }) {
  return (
    <group position={at} rotation={[0, rot, 0]}>
      <Box size={[1.5, 0.75, 0.7]} at={[-0.1, 0.55, 0]} m={FINISH.white()} />
      <Box size={[0.4, 0.5, 0.68]} at={[0.8, 0.42, 0]} m={FINISH.white()} />
      <Box size={[0.04, 0.24, 0.55]} at={[1.0, 0.55, 0]} m={FINISH.glass()} />
      <Box size={[1.52, 0.1, 0.72]} at={[-0.1, 0.45, 0]} m={mat('#d43c3c', { rough: 0.5 })} />
      <Box size={[0.3, 0.06, 0.3]} at={[0.5, 0.95, 0]} m={FINISH.darkSteel()} />
      <Blink at={[0.45, 1.01, 0.08]} color="#ff3b3b" rate={2.5} on={() => upOf(id)} />
      <Blink at={[0.55, 1.01, -0.08]} color="#3b7bff" rate={2.5} on={() => upOf(id)} />
      {[-0.65, 0.65].map((x) => [-0.36, 0.36].map((z) => <Cyl key={`${x}${z}`} r={0.16} h={0.1} at={[x, 0.16, z]} rot={[Math.PI / 2, 0, 0]} m={FINISH.rubber()} seg={14} />))}
    </group>
  );
}

const AmbulanceBay: FC<PropProps> = ({ id }) => (
  <group>
    <Box size={[3, 0.04, 2.4]} at={[0, 0.02, 0]} m={FINISH.asphalt()} shadow={false} />
    <Ambulance at={[-0.1, 0, -0.6]} id={id} />
    <Ambulance at={[0.2, 0, 0.6]} id={id} />
  </group>
);

const Entrance: FC<PropProps & { exit?: boolean }> = ({ tint, exit }) => (
  <group>
    {[-0.8, 0.8].map((x) => (
      <Box key={x} size={[0.15, 1.6, 0.15]} at={[x, 0.8, -0.8]} m={FINISH.steel()} />
    ))}
    <Box size={[1.8, 0.2, 0.25]} at={[0, 1.65, -0.8]} m={mat(exit ? '#3f9f5f' : tint, { rough: 0.5 })} />
    <Crowd count={exit ? 4 : 6} radius={1} at={[0, 0, 0.35]} seed={exit ? 9 : 1} />
  </group>
);

const Triage: FC<PropProps> = ({ tint }) => (
  <group>
    <Box size={[1.6, 0.55, 0.5]} at={[0, 0.28, -0.3]} m={mat(tint, { rough: 0.6 })} />
    <Box size={[1.7, 0.05, 0.6]} at={[0, 0.58, -0.3]} m={FINISH.white()} />
    {[-0.45, 0.45].map((x) => (
      <group key={x}>
        <Box size={[0.36, 0.25, 0.03]} at={[x, 0.78, -0.42]} m={FINISH.screen()} />
        <Person at={[x, 0, -0.8]} coat="#4f86c6" seed={x > 0 ? 1 : 2} />
      </group>
    ))}
    <Crowd count={3} radius={0.6} at={[0, 0, 0.75]} seed={4} />
  </group>
);

function Beds({ tint, monitors = false, id }: PropProps & { monitors?: boolean }) {
  return (
    <group>
      {[-1, 0, 1].map((i) => (
        <group key={i} position={[i * 1.05, 0, 0]}>
          <Box size={[0.55, 0.3, 1.2]} at={[0, 0.2, 0]} m={FINISH.steel()} />
          <Box size={[0.52, 0.12, 1.15]} at={[0, 0.41, 0]} m={FINISH.white()} />
          <Box size={[0.4, 0.08, 0.25]} at={[0, 0.5, -0.42]} m={FINISH.white()} />
          <Box size={[0.5, 0.06, 0.6]} at={[0, 0.49, 0.2]} m={mat(tint, { rough: 0.8 })} />
          {i < 1 && <Box size={[0.03, 1.3, 1.3]} at={[0.52, 0.65, 0]} m={mat('#a9c3d6', { opacity: 0.45, rough: 0.9 })} shadow={false} />}
          {monitors && (
            <group position={[-0.32, 0, -0.55]}>
              <Cyl r={0.025} h={1.1} at={[0, 0.55, 0]} m={FINISH.steel()} seg={8} />
              <Box size={[0.26, 0.2, 0.04]} at={[0, 1.1, 0]} m={FINISH.screen()} />
              <Blink at={[0.08, 1.1, 0.03]} color="#5bd88a" size={0.025} rate={1.2} on={() => upOf(id)} />
            </group>
          )}
        </group>
      ))}
    </group>
  );
}

const Scanner: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Box size={[2.4, 0.04, 2]} at={[0, 0.02, 0]} m={FINISH.white()} shadow={false} />
    <mesh position={[0, 0.85, 0]} material={FINISH.white()} castShadow>
      <torusGeometry args={[0.65, 0.3, 16, 36]} />
    </mesh>
    <mesh position={[0, 0.85, 0.02]} material={mat(tint, { rough: 0.4 })}>
      <torusGeometry args={[0.66, 0.06, 8, 36]} />
    </mesh>
    <Box size={[0.5, 0.35, 1.8]} at={[0, 0.4, 0.4]} m={FINISH.steel()} rot={[0, Math.PI / 2, 0]} />
    <Blink at={[0, 1.55, 0.25]} color="#5bd88a" size={0.04} rate={0.8} on={() => upOf(id)} />
  </group>
);

// ---- Factory -------------------------------------------------------------------------------------------------------

const Pallets: FC<PropProps> = ({ tint }) => (
  <group>
    {[-0.8, 0.3].flatMap((x) =>
      [-0.7, 0.5].map((z, j) => (
        <group key={`${x}${z}`} position={[x, 0, z]}>
          <Box size={[0.9, 0.12, 0.9]} at={[0, 0.06, 0]} m={FINISH.wood()} />
          {[0, 1, 2].slice(0, 2 + j).map((k) => (
            <Box key={k} size={[0.8, 0.3, 0.8]} at={[0, 0.27 + k * 0.31, 0]} m={k % 2 ? mat('#b48a5c', { rough: 0.9 }) : mat(tint, { rough: 0.9 })} />
          ))}
        </group>
      )),
    )}
  </group>
);

const Machine: FC<PropProps> = ({ id, tint }) => (
  <group>
    {[-0.75, 0.75].map((x) => (
      <group key={x} position={[x, 0, 0]}>
        <Box size={[1.2, 1.1, 1.1]} at={[0, 0.55, 0]} m={FINISH.white()} />
        <Box size={[1.22, 0.18, 1.12]} at={[0, 1.02, 0]} m={mat(tint, { rough: 0.5 })} />
        <Box size={[0.7, 0.45, 0.02]} at={[-0.1, 0.62, 0.56]} m={mat('#1d2a38', { emissive: '#8fd3ff', glow: 0.6, metal: 0.3, rough: 0.1 })} />
        <Box size={[0.2, 0.3, 0.06]} at={[0.42, 0.62, 0.58]} m={FINISH.darkSteel()} />
        <Blink at={[0.42, 0.85, 0.62]} color="#5bd88a" size={0.03} rate={1} on={() => upOf(id) && loadOf(id) > 0.05} />
      </group>
    ))}
  </group>
);

/** A robot arm whose joints sweep while the cell works; welders throw sparks at the tip. */
function Arm({ at, tint, id, spark = false }: { at: [number, number, number]; tint: string; id: string; spark?: boolean }) {
  const shoulder = useRef<THREE.Group>(null!);
  const elbow = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * (0.8 + loadOf(id));
    const moving = upOf(id) && runner.running ? 1 : 0;
    shoulder.current.rotation.y = Math.sin(t) * 0.6 * moving;
    elbow.current.rotation.z = (-0.6 + Math.sin(t * 1.7) * 0.3) * (moving || 1);
  });
  const paint = mat(tint, { metal: 0.3, rough: 0.45 });
  return (
    <group position={at}>
      <Cyl r={0.3} h={0.25} at={[0, 0.12, 0]} m={FINISH.darkSteel()} />
      <group ref={shoulder} position={[0, 0.25, 0]}>
        <Box size={[0.22, 0.9, 0.22]} at={[0, 0.45, 0]} m={paint} />
        <group ref={elbow} position={[0, 0.9, 0]}>
          <Box size={[0.8, 0.16, 0.16]} at={[0.4, 0, 0]} m={paint} />
          <Cyl r={0.05} h={0.25} at={[0.82, -0.1, 0]} m={FINISH.darkSteel()} seg={8} />
          {spark && <Blink at={[0.82, -0.25, 0]} color="#ffd27a" size={0.07} rate={9} on={() => upOf(id) && loadOf(id) > 0.05} />}
        </group>
      </group>
    </group>
  );
}

const Car = ({ at, tint = '#9aa5b5', bare = false }: { at: [number, number, number]; tint?: string; bare?: boolean }) => (
  <group position={at}>
    <Box size={[1.2, 0.3, 0.55]} at={[0, 0.32, 0]} m={bare ? FINISH.steel() : mat(tint, { metal: 0.5, rough: 0.3 })} />
    {!bare && <Box size={[0.6, 0.22, 0.5]} at={[-0.05, 0.57, 0]} m={FINISH.glass()} />}
    {[-0.4, 0.4].map((x) => [-0.28, 0.28].map((z) => <Cyl key={`${x}${z}`} r={0.12} h={0.08} at={[x, 0.12, z]} rot={[Math.PI / 2, 0, 0]} m={FINISH.rubber()} seg={12} />))}
  </group>
);

const Line = ({ length = 3 }: { length?: number }) => (
  <group>
    <Box size={[length, 0.08, 0.8]} at={[0, 0.3, 0]} m={FINISH.darkSteel()} />
    {[-1, 1].map((s) => (
      <Box key={s} size={[length, 0.25, 0.05]} at={[0, 0.2, s * 0.42]} m={FINISH.steel()} />
    ))}
  </group>
);

const WeldingCell: FC<PropProps> = ({ id, tint }) => (
  <group>
    <group position={[0, 0, 0.1]}>
      <Line />
      <Car at={[0, 0.25, 0]} bare />
    </group>
    <Arm at={[-0.6, 0, -0.85]} tint={tint} id={id} spark />
    <Arm at={[0.7, 0, 1.05]} tint={tint} id={id} spark />
  </group>
);

const PaintBooth: FC<PropProps> = ({ tint }) => (
  <group>
    <Box size={[2.6, 1.4, 1.6]} at={[0, 0.7, 0]} m={mat('#c9d2dc', { opacity: 0.35, rough: 0.2 })} shadow={false} />
    <Box size={[2.65, 0.12, 1.65]} at={[0, 1.42, 0]} m={mat(tint, { rough: 0.6 })} />
    <Line length={2.4} />
    <Car at={[0, 0.25, 0]} tint={tint} />
  </group>
);

const Assembly: FC<PropProps> = ({ id, tint }) => (
  <group>
    <Line length={3.2} />
    <Car at={[-0.8, 0.25, 0]} tint="#7f8ea3" />
    <Car at={[0.8, 0.25, 0]} tint={tint} />
    <Person at={[-0.2, 0, -0.75]} coat="#3b6fb6" seed={2} />
    <Person at={[0.3, 0, 0.75]} coat="#3b6fb6" seed={5} />
    <Arm at={[1.2, 0, -0.9]} tint={tint} id={id} />
  </group>
);

const Inspection: FC<PropProps> = ({ id, tint }) => {
  const beam = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    beam.current.position.x = Math.sin(clock.elapsedTime * 1.5) * 0.4;
    beam.current.visible = upOf(id);
  });
  return (
    <group>
      <Line />
      <Car at={[0, 0.25, 0]} tint="#a7b2c2" />
      {[-0.55, 0.55].map((z) => (
        <Box key={z} size={[0.12, 1.4, 0.12]} at={[0, 0.7, z]} m={mat(tint, { metal: 0.3 })} />
      ))}
      <Box size={[0.2, 0.15, 1.25]} at={[0, 1.42, 0]} m={mat(tint, { metal: 0.3 })} />
      <mesh ref={beam} position={[0, 0.8, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.05, 1.1]} />
        <meshBasicMaterial color="#7cf0c4" transparent opacity={0.22} side={THREE.DoubleSide} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
};

const Packing: FC<PropProps> = ({ tint }) => (
  <group>
    <Line length={2.2} />
    {[-0.6, 0.1, 0.8].map((x) => (
      <Box key={x} size={[0.45, 0.35, 0.45]} at={[x, 0.52, 0]} m={mat('#b48a5c', { rough: 0.9 })} />
    ))}
    <Box size={[0.9, 1.2, 1.2]} at={[1.35, 0.6, 0]} m={mat(tint, { rough: 0.5 })} />
    <Pallets id="" tint="#b48a5c" />
  </group>
);

const Shipping: FC<PropProps> = ({ tint }) => (
  <group>
    <Box size={[2.8, 0.5, 1]} at={[0, 0.25, -0.9]} m={FINISH.concrete()} />
    {[-0.8, 0.2].map((x) => (
      <Box key={x} size={[0.6, 0.5, 0.5]} at={[x, 0.75, -0.95]} m={mat('#b48a5c', { rough: 0.9 })} />
    ))}
    <Truck at={[0.2, 0, 0.55]} tint={tint} />
  </group>
);

// ---- Airport ---------------------------------------------------------------------------------------------------------

const ControlTower: FC<PropProps> = ({ id }) => (
  <group>
    <Cyl r={0.35} r2={0.28} h={3} at={[0, 1.5, 0]} m={FINISH.plaster()} seg={16} />
    <Cyl r={0.65} r2={0.55} h={0.6} at={[0, 3.25, 0]} m={FINISH.glass()} seg={16} />
    <Cyl r={0.7} h={0.1} at={[0, 3.6, 0]} m={FINISH.roof()} seg={16} />
    <Spinner at={[0, 3.8, 0]} axis="y" speed={() => (upOf(id) ? 2 : 0)}>
      <Box size={[0.6, 0.08, 0.1]} m={FINISH.white()} />
    </Spinner>
    <Box size={[1.6, 0.7, 1]} at={[0.6, 0.35, 0.8]} m={FINISH.plaster()} />
    <Windows w={1.3} cols={4} at={[0.6, 0.4, 1.31]} />
  </group>
);

function Strip({ tint, id, runway = false }: PropProps & { runway?: boolean }) {
  const plane = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * (runway ? 0.25 : 0.12) * (0.3 + loadOf(id))) % 1;
    plane.current.position.x = -1.6 + t * 3.2;
    plane.current.position.y = runway ? Math.max(0, t - 0.6) * 1.6 : 0;
    plane.current.visible = upOf(id) && loadOf(id) > 0.02;
  });
  return (
    <group>
      <Box size={[3.6, 0.04, runway ? 1.1 : 0.8]} at={[0, 0.02, 0]} m={FINISH.asphalt()} shadow={false} />
      {[-1.4, -0.8, -0.2, 0.4, 1, 1.6].map((x) => (
        <Box key={x} size={[0.3, 0.045, 0.05]} at={[x - 0.1, 0.03, 0]} m={runway ? FINISH.white() : mat('#e2b43c')} shadow={false} />
      ))}
      <Box size={[3.6, 0.045, 0.03]} at={[0, 0.03, runway ? 0.5 : 0.36]} m={mat(tint)} shadow={false} />
      <group ref={plane}>
        <Plane scale={0.75} />
      </group>
    </group>
  );
}

const Gates: FC<PropProps> = ({ tint }) => (
  <group>
    <Box size={[3, 0.9, 0.9]} at={[0, 0.45, -1]} m={FINISH.plaster()} />
    <Box size={[3.05, 0.08, 0.95]} at={[0, 0.92, -1]} m={mat(tint, { rough: 0.5 })} />
    <Windows w={2.6} cols={8} at={[0, 0.55, -0.54]} />
    {[-0.8, 0.8].map((x) => (
      <group key={x}>
        <Box size={[0.25, 0.25, 0.8]} at={[x, 0.6, -0.2]} m={FINISH.steel()} />
        <Plane at={[x, 0, 0.75]} rot={Math.PI / 2} scale={0.65} />
      </group>
    ))}
  </group>
);

// ---- Call centre -----------------------------------------------------------------------------------------------------

const ServerRack: FC<PropProps> = ({ id, tint }) => (
  <group>
    {[-0.6, 0.6].map((x) => (
      <group key={x} position={[x, 0, 0]}>
        <Box size={[0.9, 2, 0.8]} at={[0, 1, 0]} m={FINISH.darkSteel()} />
        <Box size={[0.92, 0.1, 0.82]} at={[0, 2.02, 0]} m={mat(tint, { rough: 0.5 })} />
        {[0.35, 0.65, 0.95, 1.25, 1.55, 1.8].map((y, i) => (
          <Blink key={y} at={[-0.3 + (i % 3) * 0.12, y, 0.41]} color={i % 4 ? '#5bd88a' : '#7fb3ff'} size={0.025} rate={1 + i * 0.7} on={() => upOf(id)} />
        ))}
      </group>
    ))}
  </group>
);

const Desks: FC<PropProps> = ({ tint }) => (
  <group>
    {[-0.75, 0.75].flatMap((x) =>
      [-0.6, 0.65].map((z, j) => (
        <group key={`${x}${z}`} position={[x, 0, z]}>
          <Box size={[1.2, 0.05, 0.6]} at={[0, 0.5, 0]} m={FINISH.wood()} />
          {[-0.5, 0.5].map((lx) => (
            <Box key={lx} size={[0.04, 0.5, 0.55]} at={[lx, 0.25, 0]} m={FINISH.darkSteel()} />
          ))}
          <Box size={[0.4, 0.26, 0.03]} at={[0, 0.7, -0.15]} m={FINISH.screen()} />
          <Box size={[0.03, 0.4, 0.6]} at={[0.62, 0.7, 0]} m={mat(tint, { rough: 0.8 })} />
          <Person at={[0, 0, 0.35]} seed={j + x * 4} headset />
        </group>
      )),
    )}
  </group>
);

// ---- The registry --------------------------------------------------------------------------------------------------

export const PROPS = {
  coal: CoalPlant,
  gas: GasPlant,
  nuclear: NuclearPlant,
  solar: SolarFarm,
  wind: TurbineFarm,
  substation: Substation,
  feeder: Feeder,
  city: (p: PropProps) => <Neighbourhood {...p} city />,
  houses: (p: PropProps) => <Neighbourhood {...p} />,
  industry: Industry,
  reservoir: Reservoir,
  well: Well,
  treatment: Treatment,
  pump: PumpHouse,
  waterTower: WaterTower,
  port: Port,
  distribution: Distribution,
  store: Store,
  ambulance: AmbulanceBay,
  entrance: (p: PropProps) => <Entrance {...p} />,
  exit: (p: PropProps) => <Entrance {...p} exit />,
  triage: Triage,
  beds: (p: PropProps) => <Beds {...p} />,
  icu: (p: PropProps) => <Beds {...p} monitors />,
  scanner: Scanner,
  pallets: Pallets,
  machine: Machine,
  welding: WeldingCell,
  paint: PaintBooth,
  assembly: Assembly,
  inspection: Inspection,
  packing: Packing,
  shipping: Shipping,
  controlTower: ControlTower,
  runway: (p: PropProps) => <Strip {...p} runway />,
  taxiway: (p: PropProps) => <Strip {...p} />,
  gates: Gates,
  serverRack: ServerRack,
  desks: Desks,
} satisfies Record<string, FC<PropProps>>;

export type PropId = keyof typeof PROPS;
