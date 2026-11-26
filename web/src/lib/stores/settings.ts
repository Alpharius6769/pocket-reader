import { writable } from 'svelte/store';
import type { Settings } from '../core/bridge';

/** Null until the bridge has answered getSettings(). */
export const settings = writable<Settings | null>(null);
