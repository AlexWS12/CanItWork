import { z } from 'zod';

const PART_TYPES = ['arduino', 'battery', 'resistor', 'capacitor', 'led', 'button', 'motor', 'motor_driver', 'ultrasonic', 'buzzer', 'custom'] as const;
export type PartType = (typeof PART_TYPES)[number];

const SupplySchema = z.object({ pos: z.string(), neg: z.string(), minVolts: z.number().nonnegative(), maxVolts: z.number().positive() });

export const SensorSchema = z.object({
  quantity: z.string().min(1).max(30),
  unit: z.string().max(10).default(''),
  min: z.number(),
  max: z.number(),
  value: z.number().optional(),
  pin: z.string().optional(),
});

export const ActuatorSchema = z.object({
  quantity: z.enum(['angle', 'speed', 'brightness', 'text']),
  pin: z.string().optional(),
  min: z.number().default(0),
  max: z.number().default(180),
});

export const CustomPartSchema = z.object({
  label: z.string().min(1).max(40),
  pins: z.array(z.string().min(1)).min(1).max(40),
  paths: z.array(z.object({ a: z.string(), b: z.string(), ohms: z.number().positive() })).default([]),
  switches: z
    .array(
      z.object({
        a: z.string(),
        b: z.string(),
        ohms: z.number().positive().default(0.1),
        when: z.string(),
        ref: z.string(),
        aboveVolts: z.number().nonnegative(),
      }),
    )
    .default([]),
  drivers: z
    .array(
      z.object({
        pin: z.string(),
        high: z.string(),
        low: z.string(),
        when: z.string(),
        ref: z.string(),
        aboveVolts: z.number().nonnegative(),
        ohms: z.number().positive().default(1),
        invert: z.boolean().default(false),
      }),
    )
    .default([]),
  sources: z
    .array(
      z.object({
        pos: z.string(),
        neg: z.string(),
        volts: z.number().positive().max(60),
        ohms: z.number().positive().default(1),
        from: z.string().optional(),
        dropout: z.number().nonnegative().optional(),
      }),
    )
    .default([]),
  gpio: z.array(z.string()).default([]),
  gpioVolts: z.number().positive().max(12).optional(),
  supply: SupplySchema.optional(),
  maxAmps: z.number().positive().optional(),
  output: z.boolean().default(false),
  sensor: SensorSchema.optional(),
  actuator: ActuatorSchema.optional(),
  visual: z
    .array(
      z.object({
        shape: z.enum(['box', 'cylinder', 'sphere']),
        size: z.array(z.number().positive().max(8)).length(3),
        at: z.array(z.number().min(-5).max(5)).length(3).default([0, 0.3, 0]),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        moves: z.boolean().optional(),
      }),
    )
    .max(16)
    .default([]),
});
export type CustomPart = z.infer<typeof CustomPartSchema>;

export const PartSchema = z.object({
  id: z.string().min(1),
  type: z.enum(PART_TYPES),
  ohms: z.number().positive().optional(),
  volts: z.number().positive().max(48).optional(),
  maxAmps: z.number().positive().max(100).optional(),
  farads: z.number().positive().max(10).optional(),
  usb: z.boolean().optional(),
  color: z.enum(['red', 'yellow', 'green', 'blue', 'white']).optional(),
  custom: CustomPartSchema.optional(),
});
export type Part = z.infer<typeof PartSchema>;

const ExprSchema = z.union([z.number(), z.string().min(1).max(200)]);
const VARIABLE = /^[A-Za-z_]\w*$/;

export const ActionSchema = z.union([
  z.object({
    pin: z.string(),
    mode: z.enum(['high', 'low', 'blink', 'pwm', 'angle']),
    value: ExprSchema.optional(),
    period: z.number().int().min(2).max(200).optional(),
  }),
  z.object({ show: z.string(), text: z.string().max(80) }),
  z.object({ set: z.string().regex(VARIABLE), to: ExprSchema }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const RuleSchema = z.object({
  every: z.number().positive().max(3600).optional(),
  when: z.string().min(1).max(200).optional(),
  if: z.object({ read: z.string(), op: z.enum(['<', '>', '<=', '>=', '==', '!=']), value: z.number() }).optional(),
  then: z.array(ActionSchema).min(1).max(8),
  else: z.array(ActionSchema).max(8).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const CircuitSpecSchema = z.object({
  parts: z.array(PartSchema).min(1).max(30),
  wires: z.array(z.object({ from: z.string(), to: z.string() })).max(80),
  drive: z
    .array(
      z.object({
        pin: z.string(),
        mode: z.enum(['high', 'low', 'blink', 'pwm', 'angle']),
        value: z.number().optional(),
        period: z.number().int().min(2).max(200).optional(),
      }),
    )
    .default([]),
  program: z.array(RuleSchema).max(20).optional(),
  vars: z.record(z.string().regex(VARIABLE), z.number()).optional(),
});
export type CircuitSpec = z.infer<typeof CircuitSpecSchema>;

const DIGITAL = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'];
const ANALOG = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];

export const GPIO = [...DIGITAL, ...ANALOG];

export const PINS: Record<PartType, string[]> = {
  arduino: ['5V', '3V3', 'GND', 'VIN', ...GPIO],
  battery: ['pos', 'neg'],
  resistor: ['a', 'b'],
  capacitor: ['a', 'b'],
  led: ['anode', 'cathode'],
  button: ['a', 'b'],
  motor: ['a', 'b'],
  motor_driver: ['VS', 'VCC', 'GND', 'ENA', 'IN1', 'IN2', 'OUT1', 'OUT2', 'ENB', 'IN3', 'IN4', 'OUT3', 'OUT4'],
  ultrasonic: ['VCC', 'TRIG', 'ECHO', 'GND'],
  buzzer: ['pos', 'neg'],
  custom: [],
};

export const pinsOf = (part: Part) => (part.type === 'custom' ? (part.custom?.pins ?? []) : PINS[part.type]);

export interface SensorInfo {
  label: string;
  quantity: string;
  unit: string;
  min: number;
  max: number;
  value?: number;
  pin?: string;
  outputs: string[];
}

const POWER_PIN = /^(GND|VCC|VDD|VSS|VIN|V\+|3V3|5V)$/i;

export function sensorOf(part: Part): SensorInfo | null {
  const custom = part.custom;
  if (custom?.sensor) {
    const power = new Set(custom.supply ? [custom.supply.pos, custom.supply.neg] : []);
    return { label: custom.label, ...custom.sensor, outputs: custom.pins.filter((pin) => !power.has(pin) && !POWER_PIN.test(pin)) };
  }
  if (part.type === 'button') return { label: 'Button', quantity: 'pressed', unit: '', min: 0, max: 1, value: 0, outputs: [] };
  if (part.type === 'ultrasonic') return { label: 'Ultrasonic sensor', quantity: 'distance', unit: 'cm', min: 2, max: 400, value: 100, outputs: ['ECHO'] };
  return null;
}

export const withUnit = (value: number, unit: string) => `${Math.round(value * 10) / 10}${!unit || /^[%°]/.test(unit) ? '' : ' '}${unit}`;

export const FORWARD_VOLTS = { red: 1.9, yellow: 2.0, green: 2.2, blue: 3.0, white: 3.0 };

const OUTPUTS: PartType[] = ['led', 'motor', 'buzzer', 'ultrasonic'];

export const isOutput = (part: Part) => OUTPUTS.includes(part.type) || Boolean(part.custom?.output || part.custom?.actuator);

export const LIMITS: Partial<Record<PartType, { rated: number; burn: number }>> = {
  battery: { rated: 1, burn: 2.5 },
  led: { rated: 0.02, burn: 0.04 },
  motor: { rated: 1.2, burn: 2.5 },
  buzzer: { rated: 0.05, burn: 0.1 },
  motor_driver: { rated: 2, burn: 3 },
};

export const PIN_LIMIT = { rated: 0.02, burn: 0.04 };
export const RAIL_LIMIT = { rated: 0.5, burn: 1 };
export const RESISTOR_WATTS = { rated: 0.25, burn: 0.75 };
