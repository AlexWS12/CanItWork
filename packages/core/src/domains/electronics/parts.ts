import { z } from 'zod';

const PART_TYPES = ['arduino', 'battery', 'resistor', 'led', 'button', 'motor', 'motor_driver', 'ultrasonic', 'buzzer', 'custom'] as const;
export type PartType = (typeof PART_TYPES)[number];

const SupplySchema = z.object({ pos: z.string(), neg: z.string(), minVolts: z.number().nonnegative(), maxVolts: z.number().positive() });

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
      }),
    )
    .default([]),
  gpio: z.array(z.string()).default([]),
  gpioVolts: z.number().positive().max(12).optional(),
  supply: SupplySchema.optional(),
  maxAmps: z.number().positive().optional(),
  output: z.boolean().default(false),
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
  color: z.enum(['red', 'yellow', 'green', 'blue', 'white']).optional(),
  custom: CustomPartSchema.optional(),
});
export type Part = z.infer<typeof PartSchema>;

export const CircuitSpecSchema = z.object({
  parts: z.array(PartSchema).min(1).max(30),
  wires: z.array(z.object({ from: z.string(), to: z.string() })).max(80),
  drive: z
    .array(
      z.object({
        pin: z.string(),
        mode: z.enum(['high', 'low', 'blink']),
        period: z.number().int().min(2).max(200).optional(),
      }),
    )
    .default([]),
});
export type CircuitSpec = z.infer<typeof CircuitSpecSchema>;

const DIGITAL = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'];
const ANALOG = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];

export const GPIO = [...DIGITAL, ...ANALOG];

export const PINS: Record<PartType, string[]> = {
  arduino: ['5V', '3V3', 'GND', 'VIN', ...GPIO],
  battery: ['pos', 'neg'],
  resistor: ['a', 'b'],
  led: ['anode', 'cathode'],
  button: ['a', 'b'],
  motor: ['a', 'b'],
  motor_driver: ['VS', 'VCC', 'GND', 'ENA', 'IN1', 'IN2', 'OUT1', 'OUT2', 'ENB', 'IN3', 'IN4', 'OUT3', 'OUT4'],
  ultrasonic: ['VCC', 'TRIG', 'ECHO', 'GND'],
  buzzer: ['pos', 'neg'],
  custom: [],
};

export const pinsOf = (part: Part) => (part.type === 'custom' ? (part.custom?.pins ?? []) : PINS[part.type]);

export const FORWARD_VOLTS = { red: 1.9, yellow: 2.0, green: 2.2, blue: 3.0, white: 3.0 };

const OUTPUTS: PartType[] = ['led', 'motor', 'buzzer', 'ultrasonic'];

export const isOutput = (part: Part) => OUTPUTS.includes(part.type) || Boolean(part.custom?.output);

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
