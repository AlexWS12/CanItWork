import type { Domain, DomainId } from '../domain';
import { airport } from './airport';
import { callcenter } from './callcenter';
import { database } from './database';
import { electronics } from './electronics';
import { factory } from './factory';
import { hospital } from './hospital';
import { power } from './power';
import { fleet } from './fleet';
import { software } from './software';
import { supply } from './supply';
import { warehouse } from './warehouse';
import { water } from './water';

export const DOMAINS: Record<DomainId, Domain> = { electronics, software, database, warehouse, power, water, supply, hospital, factory, airport, callcenter, fleet };

export const domainList = () => Object.values(DOMAINS);
