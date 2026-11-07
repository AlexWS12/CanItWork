import type { Domain, DomainId } from '../domain';
import { database } from './database';
import { electronics } from './electronics';
import { software } from './software';
import { warehouse } from './warehouse';

export const DOMAINS: Record<DomainId, Domain> = { electronics, software, database, warehouse };

export const domainList = () => Object.values(DOMAINS);
