/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate after every migration with:
 *   npm run db:types
 *
 * If this file and `supabase/migrations/` disagree, the migrations are the
 * truth and this file is stale.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      briefs: {
        Row: {
          body: string
          created_at: string
          entry_id: number
          gw: number
          model: string
        }
        Insert: {
          body: string
          entry_id: number
          created_at?: string
          gw: number
          model: string
        }
        Update: {
          body?: string
          created_at?: string
          entry_id?: number
          gw?: number
          model?: string
        }
        Relationships: []
      }
      decisions: {
        Row: {
          alternatives: Json
          created_at: string
          entry_id: number
          gw: number
          id: string
          kind: string
          player_in: number | null
          player_out: number | null
          predicted_ep: number | null
          rationale: string | null
          source: string
        }
        Insert: {
          alternatives?: Json
          created_at?: string
          entry_id: number
          gw: number
          id?: string
          kind: string
          player_in?: number | null
          player_out?: number | null
          predicted_ep?: number | null
          rationale?: string | null
          source: string
        }
        Update: {
          alternatives?: Json
          created_at?: string
          entry_id?: number
          gw?: number
          id?: string
          kind?: string
          player_in?: number | null
          player_out?: number | null
          predicted_ep?: number | null
          rationale?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "decisions_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_player_in_fkey"
            columns: ["player_in"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_player_out_fkey"
            columns: ["player_out"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      entries: {
        Row: {
          created_at: string
          id: number
          last_synced_at: string
          manager_name: string
          name: string
        }
        Insert: {
          created_at?: string
          id: number
          last_synced_at?: string
          manager_name: string
          name: string
        }
        Update: {
          created_at?: string
          id?: number
          last_synced_at?: string
          manager_name?: string
          name?: string
        }
        Relationships: []
      }
      fixtures: {
        Row: {
          away_difficulty: number
          away_score: number | null
          away_team: number
          finished: boolean
          gw: number | null
          home_difficulty: number
          home_score: number | null
          home_team: number
          id: number
          kickoff: string | null
          started: boolean
          updated_at: string
        }
        Insert: {
          away_difficulty: number
          away_score?: number | null
          away_team: number
          finished?: boolean
          gw?: number | null
          home_difficulty: number
          home_score?: number | null
          home_team: number
          id: number
          kickoff?: string | null
          started?: boolean
          updated_at?: string
        }
        Update: {
          away_difficulty?: number
          away_score?: number | null
          away_team?: number
          finished?: boolean
          gw?: number | null
          home_difficulty?: number
          home_score?: number | null
          home_team?: number
          id?: number
          kickoff?: string | null
          started?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fixtures_away_team_fkey"
            columns: ["away_team"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixtures_home_team_fkey"
            columns: ["home_team"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      league_memberships: {
        Row: {
          entry_id: number
          entry_last_rank: number | null
          entry_rank: number | null
          league_id: number
          updated_at: string
        }
        Insert: {
          entry_id: number
          entry_last_rank?: number | null
          entry_rank?: number | null
          league_id: number
          updated_at?: string
        }
        Update: {
          entry_id?: number
          entry_last_rank?: number | null
          entry_rank?: number | null
          league_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_memberships_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_memberships_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      leagues: {
        Row: {
          id: number
          league_type: string
          name: string
          scoring: string
          start_event: number | null
          updated_at: string
        }
        Insert: {
          id: number
          league_type: string
          name: string
          scoring: string
          start_event?: number | null
          updated_at?: string
        }
        Update: {
          id?: number
          league_type?: string
          name?: string
          scoring?: string
          start_event?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      llm_usage: {
        Row: {
          cached_tokens: number
          created_at: string
          entry_id: number | null
          gw: number | null
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          purpose: string
        }
        Insert: {
          cached_tokens?: number
          created_at?: string
          entry_id?: number | null
          gw?: number | null
          id?: string
          input_tokens: number
          model: string
          output_tokens: number
          purpose: string
        }
        Update: {
          cached_tokens?: number
          created_at?: string
          entry_id?: number | null
          gw?: number | null
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          purpose?: string
        }
        Relationships: []
      }
      outcomes: {
        Row: {
          actual_points: number
          best_alternative_points: number
          decision_id: string
          delta: number
          resolved_at: string
        }
        Insert: {
          actual_points: number
          best_alternative_points: number
          decision_id: string
          delta: number
          resolved_at?: string
        }
        Update: {
          actual_points?: number
          best_alternative_points?: number
          decision_id?: string
          delta?: number
          resolved_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcomes_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: true
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      player_gw_stats: {
        Row: {
          assists: number
          bonus: number
          bps: number
          clean_sheets: number
          defensive_contribution: number
          expected_assists: number
          expected_goals: number
          expected_goals_conceded: number
          fixture_id: number
          goals: number
          goals_conceded: number
          gw: number
          minutes: number
          opponent_team: number
          player_id: number
          red_cards: number
          starts: number
          total_points: number
          value: number
          was_home: boolean
          yellow_cards: number
        }
        Insert: {
          assists?: number
          bonus?: number
          bps?: number
          clean_sheets?: number
          defensive_contribution?: number
          expected_assists?: number
          expected_goals?: number
          expected_goals_conceded?: number
          fixture_id: number
          goals?: number
          goals_conceded?: number
          gw: number
          minutes?: number
          opponent_team: number
          player_id: number
          red_cards?: number
          starts?: number
          total_points?: number
          value?: number
          was_home: boolean
          yellow_cards?: number
        }
        Update: {
          assists?: number
          bonus?: number
          bps?: number
          clean_sheets?: number
          defensive_contribution?: number
          expected_assists?: number
          expected_goals?: number
          expected_goals_conceded?: number
          fixture_id?: number
          goals?: number
          goals_conceded?: number
          gw?: number
          minutes?: number
          opponent_team?: number
          player_id?: number
          red_cards?: number
          starts?: number
          total_points?: number
          value?: number
          was_home?: boolean
          yellow_cards?: number
        }
        Relationships: [
          {
            foreignKeyName: "player_gw_stats_fixture_id_fkey"
            columns: ["fixture_id"]
            isOneToOne: false
            referencedRelation: "fixtures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_gw_stats_opponent_team_fkey"
            columns: ["opponent_team"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_gw_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      game_state: {
        Row: {
          id: boolean
          total_players: number
          updated_at: string
        }
        Insert: {
          id?: boolean
          total_players: number
          updated_at?: string
        }
        Update: {
          id?: boolean
          total_players?: number
          updated_at?: string
        }
        Relationships: []
      }
      player_season_history: {
        Row: {
          assists: number
          bonus: number
          clean_sheets: number
          defensive_contribution: number
          expected_assists: number | null
          expected_goals: number | null
          goals_conceded: number
          goals_scored: number
          minutes: number
          player_code: number
          season_name: string
          starts: number
          total_points: number
          updated_at: string
        }
        Insert: {
          assists?: number
          bonus?: number
          clean_sheets?: number
          defensive_contribution?: number
          expected_assists?: number | null
          expected_goals?: number | null
          goals_conceded?: number
          goals_scored?: number
          minutes?: number
          player_code: number
          season_name: string
          starts?: number
          total_points?: number
          updated_at?: string
        }
        Update: {
          assists?: number
          bonus?: number
          clean_sheets?: number
          defensive_contribution?: number
          expected_assists?: number | null
          expected_goals?: number | null
          goals_conceded?: number
          goals_scored?: number
          minutes?: number
          player_code?: number
          season_name?: string
          starts?: number
          total_points?: number
          updated_at?: string
        }
        Relationships: []
      }
      player_transfer_snapshots: {
        Row: {
          captured_on: string
          gw: number | null
          now_cost: number
          player_id: number
          selected_by_percent: number
          transfers_in: number
          transfers_out: number
        }
        Insert: {
          captured_on: string
          gw?: number | null
          now_cost: number
          player_id: number
          selected_by_percent?: number
          transfers_in: number
          transfers_out: number
        }
        Update: {
          captured_on?: string
          gw?: number | null
          now_cost?: number
          player_id?: number
          selected_by_percent?: number
          transfers_in?: number
          transfers_out?: number
        }
        Relationships: [
          {
            foreignKeyName: "player_transfer_snapshots_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          chance_of_playing_next_round: number | null
          code: number
          corners_order: number | null
          direct_freekicks_order: number | null
          first_name: string
          id: number
          news: string
          now_cost: number
          penalties_order: number | null
          position: number
          second_name: string
          selected_by_percent: number
          status: string
          team_id: number
          updated_at: string
          web_name: string
        }
        Insert: {
          chance_of_playing_next_round?: number | null
          code: number
          corners_order?: number | null
          direct_freekicks_order?: number | null
          first_name: string
          id: number
          news?: string
          now_cost: number
          penalties_order?: number | null
          position: number
          second_name: string
          selected_by_percent?: number
          status: string
          team_id: number
          updated_at?: string
          web_name: string
        }
        Update: {
          chance_of_playing_next_round?: number | null
          code?: number
          corners_order?: number | null
          direct_freekicks_order?: number | null
          first_name?: string
          id?: number
          news?: string
          now_cost?: number
          penalties_order?: number | null
          position?: number
          second_name?: string
          selected_by_percent?: number
          status?: string
          team_id?: number
          updated_at?: string
          web_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      price_history: {
        Row: {
          cost: number
          player_id: number
          recorded_at: string
        }
        Insert: {
          cost: number
          player_id: number
          recorded_at?: string
        }
        Update: {
          cost?: number
          player_id?: number
          recorded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_history_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      squad_picks: {
        Row: {
          is_captain: boolean
          is_vice: boolean
          player_id: number
          position: number
          squad_id: string
        }
        Insert: {
          is_captain?: boolean
          is_vice?: boolean
          player_id: number
          position: number
          squad_id: string
        }
        Update: {
          is_captain?: boolean
          is_vice?: boolean
          player_id?: number
          position?: number
          squad_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "squad_picks_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "squad_picks_squad_id_fkey"
            columns: ["squad_id"]
            isOneToOne: false
            referencedRelation: "squads"
            referencedColumns: ["id"]
          },
        ]
      }
      squads: {
        Row: {
          bank: number
          captain_id: number | null
          chip_played: string | null
          created_at: string
          entry_id: number
          free_transfers: number
          gw: number
          id: string
          team_value: number
          vice_captain_id: number | null
        }
        Insert: {
          bank?: number
          captain_id?: number | null
          chip_played?: string | null
          created_at?: string
          entry_id: number
          free_transfers?: number
          gw: number
          id?: string
          team_value?: number
          vice_captain_id?: number | null
        }
        Update: {
          bank?: number
          captain_id?: number | null
          chip_played?: string | null
          created_at?: string
          entry_id?: number
          free_transfers?: number
          gw?: number
          id?: string
          team_value?: number
          vice_captain_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "squads_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "squads_captain_id_fkey"
            columns: ["captain_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "squads_vice_captain_id_fkey"
            columns: ["vice_captain_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          id: number
          name: string
          short_name: string
          strength: number | null
          strength_attack_away: number
          strength_attack_home: number
          strength_defence_away: number
          strength_defence_home: number
          strength_overall_away: number
          strength_overall_home: number
          updated_at: string
        }
        Insert: {
          id: number
          name: string
          short_name: string
          strength?: number | null
          strength_attack_away?: number
          strength_attack_home?: number
          strength_defence_away?: number
          strength_defence_home?: number
          strength_overall_away?: number
          strength_overall_home?: number
          updated_at?: string
        }
        Update: {
          id?: number
          name?: string
          short_name?: string
          strength?: number | null
          strength_attack_away?: number
          strength_attack_home?: number
          strength_defence_away?: number
          strength_defence_home?: number
          strength_overall_away?: number
          strength_overall_home?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  Name extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"]),
> = (DefaultSchema["Tables"] & DefaultSchema["Views"])[Name] extends {
  Row: infer R
}
  ? R
  : never

export type TablesInsert<Name extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][Name] extends { Insert: infer I } ? I : never

export type TablesUpdate<Name extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][Name] extends { Update: infer U } ? U : never
