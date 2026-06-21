# SpottedOF — Instructions permanentes

## Projet
SaaS de scouting multi-réseaux (Instagram, TikTok, Threads…) pour agences OFM.
Stack : HTML/CSS/JS vanilla + Supabase. Hébergé sur GitHub Pages → spottedof.com.
Local : `/Users/robin/SpottedOF/` · Preview : `python3 -m http.server 3457`

## Skills actifs — À utiliser SYSTÉMATIQUEMENT

### 1. UI/UX Pro Max (`ui-ux-pro-max`)
Utilise ce skill pour TOUTE décision de design, animation, couleur, layout, composant.
- Vérifie accessibilité (contraste 4.5:1, reduced-motion)
- Animations : durée 150–300ms, cubic-bezier(0.16,1,0.3,1), toujours `prefers-reduced-motion`
- Style cible : dark mode Linear-inspired, accent cyan `#06B6D4`

### 2. Karpathy Guidelines (`karpathy-guidelines`)
Applique ces règles à CHAQUE modification de code :
- **Pense avant de coder** : exprime tes hypothèses, pose des questions si flou
- **Simplicité** : minimum de code, zéro feature non demandée
- **Changements chirurgicaux** : touche uniquement ce qui est demandé, ne "refactore" pas l'adjacent
- **Critères de succès vérifiables** : définis ce que "ça marche" veut dire avant d'écrire

### 3. Frontend Design (`frontend-design`)
Pour les décisions d'identité visuelle et de DA globale du site.

## Design tokens (ne jamais dévier)
```css
--bg: #060608; --surface: #0C0C0F; --surface2: #111115;
--border: rgba(255,255,255,0.07); --border-light: rgba(255,255,255,0.13);
--accent: #06B6D4; --accent-light: #22D3EE;
--pink: #F0436C; --green: #1ECA6E; --yellow: #F59E0B;
--text: #FFFFFF; --muted: #9898A8; --text-3: #484858;
```
Fonts : Outfit (display) · Inter (body) · Space Mono (labels/mono)

## Fichiers clés
- `index.html` — Landing page
- `app.html` — Dashboard principal
- `login.html` / `register.html` / `reset-password.html` — Auth
- `admin.html` — Panel admin
- `plan.html` — Page mon plan

## Règles absolues
- Jamais de blanc (#fff, white, #f8f9ff…) comme fond — toujours `var(--surface*)` ou `var(--bg)`
- Le "OF" dans le logo est toujours `color: var(--accent)` (cyan)
- Hover violet `#9b7ffd` interdit — remplacer par `var(--accent-light)`
- Déconnexion redirige vers `index.html` (pas `login.html`)
- Toujours tester visuellement sur `localhost:3457` avant de valider
