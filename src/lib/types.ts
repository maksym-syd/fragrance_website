import type { Tier } from './overlap';

export type { Tier };
export type Concentration = 'EDT' | 'EDP' | 'Parfum' | 'Extrait';
export const CONCENTRATIONS: Concentration[] = ['EDT', 'EDP', 'Parfum', 'Extrait'];

export interface Room {
  id: string;
  code: string;
  name: string;
  owner_id: string;
  join_by_code: boolean;
  created_at: string;
}

export interface Member {
  id: string;
  room_id: string;
  user_id: string;
  email: string;
  display_name: string;
  joined_at: string;
}

export interface Invite {
  room_id: string;
  email: string;
  created_at: string;
}

export interface Fragrance {
  id: string;
  room_id: string;
  name: string;
  house: string;
  concentration: Concentration | null;
  /** Flat list that the overlap math reads: the pyramid plus any notes with no known position. */
  notes: string[];
  perfumers: string[];
  accords: string[];
  notes_top: string[];
  notes_heart: string[];
  notes_base: string[];
  release_year: number | null;
  added_by: string | null;
  created_at: string;
}

export interface Ranking {
  room_id: string;
  member_id: string;
  fragrance_id: string;
  tier: Tier;
  updated_at: string;
}

export interface NewFragrance {
  name: string;
  house: string;
  concentration: Concentration | null;
  notes: string[];
  perfumers?: string[];
  accords?: string[];
  notes_top?: string[];
  notes_heart?: string[];
  notes_base?: string[];
  release_year?: number | null;
}

/** Everything the edit form saves. Only these columns have an UPDATE grant. */
export type FragrancePatch = Required<NewFragrance>;
