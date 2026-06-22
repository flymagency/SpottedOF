-- ============================================================
-- SpottedOF — CORRECTION RLS (à appliquer dans Supabase SQL Editor)
-- Supprime la politique récursive sur profiles qui bloquait la lecture
-- ============================================================

-- Supprimer la politique admin récursive qui causait le bug
DROP POLICY IF EXISTS "profiles_admin_all" ON profiles;

-- S'assurer que la politique de base est bien là
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;

CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = id);
