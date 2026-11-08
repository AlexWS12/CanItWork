import type { WarehouseRun, World } from '@tv/core';
import { runner } from '../../runner';

export const ROBOT_COLORS = ['#2fd4c2', '#a58bff', '#ff7ac6', '#a3e635', '#4cc3ff', '#e879f9', '#34d399', '#93c5fd', '#fda4af', '#bef264', '#67e8f9', '#c4b5fd'];

export const robotColor = (index: number) => ROBOT_COLORS[index % ROBOT_COLORS.length];

export const COLORS = {
  floor: '#1a1c21',
  steel: '#596170',
  steelLight: '#7a8392',
  cargo: '#ffb347',
  crate: '#a47a50',
  danger: '#ff3b4e',
  energy: '#5dffb1',
  outside: '#0a0f19',
  wall: '#33415c',
};

export const ZONE_TINTS = ['#4cc3ff', '#ff7ac6', '#a3e635', '#ffb347', '#a58bff', '#67e8f9'];

export const warehouseSim = () => (runner.run as WarehouseRun | null)?.sim ?? null;

export function toScene(world: World, cell: { x: number; y: number }, y = 0): [number, number, number] {
  return [cell.x - world.cols / 2 + 0.5, y, cell.y - world.rows / 2 + 0.5];
}
