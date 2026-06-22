-- ============================================================
-- SpottedOF — Politiques RLS (Row Level Security)
-- À exécuter dans Supabase > SQL Editor
-- ============================================================

-- ── ACTIVER RLS SUR TOUTES LES TABLES ──────────────────────
ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams          ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invites   ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_activity  ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE replies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_tags  ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- TABLE : profiles
-- ============================================================
-- Chaque utilisateur voit et modifie uniquement son propre profil
-- L'admin (superadmin) peut tout voir

DROP POLICY IF EXISTS "profiles_select_own"  ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"  ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"   ON profiles;

-- Chaque utilisateur lit/modifie uniquement son propre profil
-- La page admin utilise la service key (bypass RLS) donc pas besoin de politique admin ici
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- ============================================================
-- TABLE : tickets
-- ============================================================
-- Un utilisateur voit uniquement ses propres tickets
-- L'admin voit tout

DROP POLICY IF EXISTS "tickets_select_own"  ON tickets;
DROP POLICY IF EXISTS "tickets_insert_own"  ON tickets;
DROP POLICY IF EXISTS "tickets_admin_all"   ON tickets;

CREATE POLICY "tickets_select_own" ON tickets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "tickets_insert_own" ON tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tickets_admin_all" ON tickets
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
      AND p.plan IN ('admin', 'superadmin')
    )
  );

-- ============================================================
-- TABLE : teams
-- ============================================================
-- Le propriétaire de l'équipe peut tout faire
-- Les membres peuvent lire leur équipe

DROP POLICY IF EXISTS "teams_owner"   ON teams;
DROP POLICY IF EXISTS "teams_member"  ON teams;

CREATE POLICY "teams_owner" ON teams
  FOR ALL USING (auth.uid() = owner_id);

CREATE POLICY "teams_member" ON teams
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = teams.id
      AND tm.user_id = auth.uid()
    )
  );

-- ============================================================
-- TABLE : team_members
-- ============================================================
-- Le propriétaire de l'équipe peut gérer les membres
-- Un membre peut se voir lui-même

DROP POLICY IF EXISTS "tm_owner"   ON team_members;
DROP POLICY IF EXISTS "tm_self"    ON team_members;
DROP POLICY IF EXISTS "tm_member"  ON team_members;

CREATE POLICY "tm_owner" ON team_members
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_members.team_id
      AND t.owner_id = auth.uid()
    )
  );

CREATE POLICY "tm_member" ON team_members
  FOR SELECT USING (
    team_id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- TABLE : team_invites
-- ============================================================

DROP POLICY IF EXISTS "ti_owner"  ON team_invites;
DROP POLICY IF EXISTS "ti_token"  ON team_invites;

-- Propriétaire gère les invitations
CREATE POLICY "ti_owner" ON team_invites
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_invites.team_id
      AND t.owner_id = auth.uid()
    )
  );

-- N'importe qui peut lire une invitation par token (pour l'accepter)
CREATE POLICY "ti_token" ON team_invites
  FOR SELECT USING (true);

-- ============================================================
-- TABLE : team_activity
-- ============================================================

DROP POLICY IF EXISTS "ta_team"  ON team_activity;

CREATE POLICY "ta_team" ON team_activity
  FOR SELECT USING (
    team_id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "ta_insert" ON team_activity
  FOR INSERT WITH CHECK (
    team_id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- TABLE : scheduled_scans
-- ============================================================

DROP POLICY IF EXISTS "ss_own"  ON scheduled_scans;

CREATE POLICY "ss_own" ON scheduled_scans
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- TABLE : replies
-- ============================================================

DROP POLICY IF EXISTS "replies_own"  ON replies;

CREATE POLICY "replies_own" ON replies
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- TABLE : prospect_tags
-- ============================================================

DROP POLICY IF EXISTS "tags_own"  ON prospect_tags;

CREATE POLICY "tags_own" ON prospect_tags
  FOR ALL USING (auth.uid() = user_id);
