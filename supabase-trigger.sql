-- ============================================================
-- SpottedOF — Trigger création profil automatique à l'inscription
-- À exécuter dans Supabase > SQL Editor
-- ============================================================

-- Fonction appelée à chaque nouvel utilisateur Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER           -- s'exécute avec les droits admin, bypass RLS
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    first_name,
    agency_name,
    plan,
    paid,
    created_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'agency_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'plan', 'starter'),
    false,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email      = EXCLUDED.email,
    first_name = CASE WHEN EXCLUDED.first_name != '' THEN EXCLUDED.first_name ELSE profiles.first_name END,
    agency_name= CASE WHEN EXCLUDED.agency_name != '' THEN EXCLUDED.agency_name ELSE profiles.agency_name END,
    plan       = CASE WHEN EXCLUDED.plan != 'starter' THEN EXCLUDED.plan ELSE profiles.plan END;

  RETURN NEW;
END;
$$;

-- Supprimer l'ancien trigger s'il existe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Créer le trigger sur la table auth.users
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
