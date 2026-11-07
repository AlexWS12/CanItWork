import type { Domain, DomainId } from '../domain';
import { database } from './database';
import { electronics } from './electronics';
import { fleet } from './fleet';
import { software } from './software';
import { warehouse } from './warehouse';

export const DOMAINS: Record<DomainId, Domain> = { electronics, software, database, warehouse, fleet };

export const domainList = () => Object.values(DOMAINS);
