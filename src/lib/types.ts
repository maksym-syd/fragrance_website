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
  notes: string[];
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
}
