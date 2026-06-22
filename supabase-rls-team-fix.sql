-- ============================================================
-- SpottedOF — CORRECTION RLS équipes (référence circulaire)
-- À exécuter dans Supabase > SQL Editor
-- ============================================================

-- ── TEAMS ──────────────────────────────────────────────────

DROP POLICY IF EXISTS "teams_owner"  ON teams;
DROP POLICY IF EXISTS "teams_member" ON teams;

-- Propriétaire voit ses équipes (pas de sous-requête = pas de récursion)
CREATE POLICY "teams_owner" ON teams
  FOR ALL USING (auth.uid() = owner_id);

-- Membre voit l'équipe dont il fait partie
-- La sous-requête sur team_members utilise uniquement user_id = auth.uid()
-- ce qui est résolu sans récursion grâce à la politique tm_self ci-dessous
CREATE POLICY "teams_member" ON teams
  FOR SELECT USING (
    id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- ── TEAM_MEMBERS ────────────────────────────────────────────

DROP POLICY IF EXISTS "tm_owner"  ON team_members;
DROP POLICY IF EXISTS "tm_self"   ON team_members;
DROP POLICY IF EXISTS "tm_member" ON team_members;

-- Cas de base sans récursion : un utilisateur voit sa propre ligne
CREATE POLICY "tm_self" ON team_members
  FOR SELECT USING (user_id = auth.uid());

-- Propriétaire de l'équipe voit et gère tous ses membres
-- Utilise teams directement (owner_id = auth.uid() sans sous-requête)
CREATE POLICY "tm_owner" ON team_members
  FOR ALL USING (
    team_id IN (
      SELECT id FROM teams WHERE owner_id = auth.uid()
    )
  );

-- ── TEAM_INVITES ────────────────────────────────────────────

DROP POLICY IF EXISTS "ti_owner" ON team_invites;
DROP POLICY IF EXISTS "ti_token" ON team_invites;

CREATE POLICY "ti_owner" ON team_invites
  FOR ALL USING (
    team_id IN (SELECT id FROM teams WHERE owner_id = auth.uid())
  );

CREATE POLICY "ti_token" ON team_invites
  FOR SELECT USING (true);

-- ── TEAM_ACTIVITY ───────────────────────────────────────────

DROP POLICY IF EXISTS "ta_team"   ON team_activity;
DROP POLICY IF EXISTS "ta_insert" ON team_activity;

CREATE POLICY "ta_team" ON team_activity
  FOR SELECT USING (
    team_id IN (SELECT id FROM teams WHERE owner_id = auth.uid())
    OR
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

CREATE POLICY "ta_insert" ON team_activity
  FOR INSERT WITH CHECK (
    team_id IN (SELECT id FROM teams WHERE owner_id = auth.uid())
    OR
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );
