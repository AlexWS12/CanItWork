import type { FC } from 'react';
import { Box, Crowd, FINISH, Person, Smoke, mat } from '../../scene/kit';
import { Packed, Piece } from '../../scene/Model';
import { PROPS, loadOf, type PropProps } from './props';

// Network models built from Kenney's CC0 packs. Each is a drop-in for the code-built model of the same kind, which shows while
// the pack models load and stays if they can't. Kinds whose code model moves in ways a static pack model can't (turning
// turbines, welding arms, taxiing planes) keep the code model.

const coded = (key: keyof typeof PROPS) => PROPS[key];

/** Wraps a pack-built model so the code-built one of the same kind shows until it is ready. */
const pack =
  (key: keyof typeof PROPS, Built: FC<PropProps>): FC<PropProps> =>
  (props) => {
    const Code = coded(key);
    return (
      <Packed fallback={<Code {...props} />}>
        <Built {...props} />
      </Packed>
    );
  };

export const PACKED: Partial<Record<keyof typeof PROPS, FC<PropProps>>> = {
  ambulance: pack('ambulance', () => (
    <group>
      <Box size={[3, 0.04, 2.4]} at={[0, 0.02, 0]} m={FINISH.asphalt()} shadow={false} />
      <Piece id="vehicles/ambulance" width={1.9} position={[-0.1, 0, -0.6]} rotation={Math.PI / 2} />
      <Piece id="vehicles/ambulance" width={1.9} position={[0.25, 0, 0.6]} rotation={Math.PI / 2} />
    </group>
  )),
  beds: pack('beds', ({ tint }) => (
    <group>
      {[-1, 0, 1].map((i) => (
        <group key={i} position={[i * 1.05, 0, 0]}>
          <Piece id="furniture/bedSingle" width={1.3} rotation={Math.PI} />
          {i < 1 && <Box size={[0.03, 1.3, 1.3]} at={[0.52, 0.65, 0]} m={mat('#a9c3d6', { opacity: 0.45, rough: 0.9 })} shadow={false} />}
        </group>
      ))}
      <Box size={[3.2, 0.03, 0.12]} at={[0, 0.01, 0.75]} m={mat(tint)} shadow={false} />
    </group>
  )),
  triage: pack('triage', () => (
    <group>
      <Piece id="furniture/desk" width={1.6} position={[0, 0, -0.3]} />
      {[-0.4, 0.4].map((x, i) => (
        <group key={x}>
          <Piece id="furniture/computerScreen" width={0.45} position={[x, 0.58, -0.4]} />
          <Piece id="furniture/chairDesk" width={0.55} position={[x, 0, -0.85]} rotation={Math.PI} />
          <Person at={[x, 0, -0.95]} seed={i + 3} />
        </group>
      ))}
      <Crowd count={3} radius={0.6} at={[0, 0, 0.8]} seed={4} />
    </group>
  )),
  desks: pack('desks', () => (
    <group>
      {[-0.75, 0.75].flatMap((x) =>
        [-0.6, 0.65].map((z, j) => (
          <group key={`${x}${z}`} position={[x, 0, z]}>
            <Piece id="furniture/desk" width={1.2} />
            <Piece id="furniture/computerScreen" width={0.42} position={[0, 0.58, -0.1]} />
            <Piece id="furniture/chairDesk" width={0.5} position={[0, 0, 0.42]} rotation={Math.PI} />
            <Person at={[0, 0, 0.5]} seed={j + x * 4 + 5} headset />
          </group>
        )),
      )}
    </group>
  )),
  coal: pack('coal', ({ id }) => (
    <group>
      <Piece id="industrial/building-c" width={2.2} position={[-0.45, 0, 0.15]} />
      {[-0.5, 0.5].map((z) => (
        <group key={z}>
          <Piece id="industrial/chimney-large" height={3.2} position={[1.1, 0, z]} />
          <Smoke at={[1.1, 3.2, z]} tint="#c4c9d1" rate={() => loadOf(id)} />
        </group>
      ))}
    </group>
  )),
  gas: pack('gas', ({ id }) => (
    <group>
      <Piece id="industrial/building-a" width={2.2} position={[-0.3, 0, 0.2]} />
      <Piece id="industrial/chimney-medium" height={2.6} position={[1.15, 0, -0.5]} />
      <Smoke at={[1.15, 2.6, -0.5]} tint="#d9dde3" rate={() => loadOf(id)} />
      <Piece id="industrial/detail-tank" width={0.9} position={[0.9, 0, 0.9]} />
    </group>
  )),
  solar: pack('solar', () => (
    <group>
      <Piece id="industrial/solar-panel-landscape-group" width={3.2} position={[0, 0, -0.6]} />
      <Piece id="industrial/solar-panel-landscape-group" width={3.2} position={[0, 0, 0.8]} />
    </group>
  )),
  industry: pack('industry', ({ id }) => (
    <group>
      <Piece id="industrial/building-d" width={2.6} position={[-0.3, 0, 0]} />
      <Piece id="industrial/chimney-medium" height={2.4} position={[1.3, 0, -0.6]} />
      <Smoke at={[1.3, 2.4, -0.6]} tint="#c4c9d1" rate={() => loadOf(id)} />
    </group>
  )),
  houses: pack('houses', () => (
    <group>
      <Piece id="suburban/building-type-a" width={1.25} position={[-0.85, 0, -0.75]} />
      <Piece id="suburban/building-type-c" width={1.2} position={[0.75, 0, -0.85]} />
      <Piece id="suburban/building-type-e" width={1.25} position={[-0.95, 0, 0.75]} />
      <Piece id="suburban/building-type-g" width={1.2} position={[0.85, 0, 0.8]} />
      <Piece id="suburban/tree-small" height={0.9} position={[0, 0, 0]} />
    </group>
  )),
  city: pack('city', () => (
    <group>
      <Piece id="commercial/building-skyscraper-a" height={3} position={[0.2, 0, -0.4]} />
      <Piece id="commercial/building-c" width={1.2} position={[-1, 0, -0.6]} />
      <Piece id="suburban/building-type-b" width={1.2} position={[-0.9, 0, 0.85]} />
      <Piece id="suburban/building-type-d" width={1.2} position={[0.9, 0, 0.95]} />
    </group>
  )),
  waterTower: pack('waterTower', () => (
    <group>
      <Piece id="industrial/water-tower" height={3.2} />
    </group>
  )),
  port: pack('port', ({ tint }) => (
    <group>
      <mesh position={[0.4, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} material={FINISH.water()} receiveShadow>
        <planeGeometry args={[1.9, 3.4]} />
      </mesh>
      <Box size={[1.3, 0.2, 3.4]} at={[-1, 0.1, 0]} m={FINISH.concrete()} />
      <Piece id="watercraft/ship-cargo-a" width={3} position={[0.5, 0, 0]} rotation={Math.PI / 2} />
      <Piece id="industrial/shipping-container-a" width={0.7} position={[-1.05, 0.2, -1.1]} />
      <Piece id="industrial/shipping-container-b" width={0.7} position={[-1.05, 0.2, -0.2]} />
      <Piece id="industrial/shipping-container-c" width={0.7} position={[-1.05, 0.2, 0.7]} />
      <Box size={[0.1, 2.3, 0.1]} at={[-1.3, 1.15, -1.5]} m={mat(tint, { metal: 0.5, rough: 0.4 })} />
      <Box size={[0.1, 2.3, 0.1]} at={[-1.3, 1.15, 1.5]} m={mat(tint, { metal: 0.5, rough: 0.4 })} />
      <Box size={[0.18, 0.14, 3.1]} at={[-1.3, 2.3, 0]} m={mat(tint, { metal: 0.5, rough: 0.4 })} />
    </group>
  )),
  distribution: pack('distribution', () => (
    <group>
      <Piece id="industrial/building-e" width={2.6} position={[0, 0, -0.5]} />
      <Piece id="vehicles/truck" width={1.6} position={[-0.6, 0, 1.1]} rotation={Math.PI / 2} />
      <Piece id="vehicles/delivery" width={1.4} position={[0.8, 0, 1.1]} rotation={Math.PI / 2} />
    </group>
  )),
  store: pack('store', () => (
    <group>
      <Piece id="commercial/building-a" width={1.5} position={[-0.8, 0, -0.3]} />
      <Piece id="commercial/building-b" width={1.5} position={[0.85, 0, 0.1]} />
      <Crowd count={3} radius={0.5} at={[0, 0, 1.3]} seed={3} />
    </group>
  )),
  pallets: pack('pallets', () => (
    <group>
      <Piece id="factory/box-large" width={1} position={[-0.8, 0, -0.6]} />
      <Piece id="factory/box-large" width={1} position={[0.4, 0, -0.6]} />
      <Piece id="factory/box-small" width={0.7} position={[-0.7, 0, 0.6]} />
      <Piece id="furniture/cardboardBoxClosed" width={0.6} position={[0.5, 0, 0.6]} />
    </group>
  )),
  machine: pack('machine', () => (
    <group>
      <Piece id="factory/machine" width={1.4} position={[-0.8, 0, 0]} />
      <Piece id="factory/machine-window" width={1.4} position={[0.8, 0, 0]} />
    </group>
  )),
  inspection: pack('inspection', () => (
    <group>
      <Piece id="factory/conveyor-long" width={3} />
      <Piece id="factory/scanner-high" width={1.4} />
      <Piece id="vehicles/sedan" width={1.2} position={[0.9, 0.3, 0]} rotation={Math.PI / 2} />
    </group>
  )),
  packing: pack('packing', () => (
    <group>
      <Piece id="factory/conveyor-long" width={2.6} position={[-0.3, 0, 0]} />
      <Piece id="factory/box-small" width={0.45} position={[-0.8, 0.35, 0]} />
      <Piece id="factory/box-small" width={0.45} position={[0.1, 0.35, 0]} />
      <Piece id="factory/hopper-round" width={1} position={[1.35, 0, 0]} />
    </group>
  )),
  shipping: pack('shipping', () => (
    <group>
      <Box size={[2.8, 0.5, 1]} at={[0, 0.25, -0.9]} m={FINISH.concrete()} />
      <Piece id="furniture/cardboardBoxClosed" width={0.55} position={[-0.8, 0.5, -0.95]} />
      <Piece id="furniture/cardboardBoxClosed" width={0.55} position={[0.2, 0.5, -0.95]} />
      <Piece id="vehicles/delivery" width={1.7} position={[0.2, 0, 0.6]} />
    </group>
  )),
};
