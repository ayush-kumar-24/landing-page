# Waitlist → approval → sign-in: go-live checklist

How access to Ally works once everything below is plugged in:

0. join.goxlally.ai is the front door for everyone and shows one of five
   states: **new** (the form), **waiting** ("you're on the approval list"),
   **approved** ("Sign in to Ally" → the platform, email pre-filled),
   **signed in** ("Go to my dashboard") and **signed out** ("Log in"). The
   first three come from the registration id the browser keeps
   (`localStorage`, a random UUID, never the email) checked against
   `/api/waitlist-status`; the last two from the `ally_hint` cookie
   (`in`/`out`, nothing else) that the platform writes on the shared
   `goxlally.ai` domain. A new visitor is never redirected to the platform.
1. A founder registers at join.goxlally.ai → a `beta_users` row (status `NEW`) →
   a confirmation email to them, and a notification email **with an Approve
   button** to `BETA_NOTIFY_EMAIL`.
2. Someone on the team clicks Approve → a confirmation page → **Approve & send
   invite**. The server creates the founder's auth user in the platform's
   Supabase project, sets the row to `INVITED`, and emails them "You're in"
   with a link to `<PLATFORM_URL>/guided/login#email=<their address>`.
3. The founder opens the link, presses "Send me a code", enters the 8-digit
   code Supabase emails, chooses a password, and lands in onboarding. Next
   time it is email + password.
4. Anyone who reaches goxlally.ai without a session (after a silent attempt to
   resume one from the refresh cookie) is sent to join.goxlally.ai. Sign-in
   stays at goxlally.ai/guided/login, reached from the invite email and the
   waitlist site's "Log in". Requesting a code for an unapproved address is
   refused.

Nothing in the code differs between testing and production — only the
environment below. Until it is set, everything runs in the local stand-in mode
described at the end.

## A. Landing site — join.goxlally.ai (Vercel env; every one is server-side)

| Variable | Where it comes from | Required |
|---|---|---|
| `DATABASE_URL` | already set | yes |
| `SMTP_USER`, `SMTP_PASSWORD`, `BETA_FROM_EMAIL` | already set (Hostinger) | yes |
| `BETA_NOTIFY_EMAIL` | the inbox that will approve people — the Approve button arrives here | **yes** (used to be optional) |
| `APPROVAL_SECRET` | `openssl rand -base64 48` | **yes** — without it the notification says approval is disabled |
| `SUPABASE_URL` | platform's Supabase → Project Settings → API → Project URL | **yes** |
| `SUPABASE_SERVICE_ROLE_KEY` | same page → `service_role` (secret) | **yes** — see warning |
| `PLATFORM_URL` | leave unset (defaults to https://goxlally.ai) | no |

⚠️ **service_role key.** It bypasses row-level security on the platform's
production database. Server-side only, never `NEXT_PUBLIC_`, never in git, and
rotate it immediately if it is ever exposed. Hardening for later: an invite
endpoint on api.goxlally.ai so this site never holds the key at all — that is a
change to `app/lib/supabase-admin.ts` only.

Database: **no schema change.** `status` (`NEW → INVITED`) and `updated_at`
already exist in `db/schema.sql`.

Since then one column has been added — `billing`, the personal/business answer
and the GST invoice details from the pricing page. Re-run `psql "$DATABASE_URL"
-f db/schema.sql` (every statement in it is idempotent) before the deploy that
carries it; until the column exists, registrations that reach the database
fail and fall through to the Ally panel and the notification email.

## B. Supabase dashboard — the platform's project

1. Authentication → Sign In / Providers → Email → **"Allow new users to sign
   up": OFF.** This is the actual gate. The frontend's `shouldCreateUser:
   false` is only a courtesy; no client code can override this switch.
2. Authentication → Email Templates → the OTP template must contain
   `{{ .Token }}` (a code, not a link). Already true if 8-digit codes arrive
   today.
3. Authentication → Settings → OTP expiry: 600 s (10 min) recommended. OTP
   length 8 (matches `OTP_DISPLAY_LENGTH` in `Login.jsx`).
4. Testers already present in `auth.users` are unaffected and keep signing in
   with their password.

## C. Platform frontend — goxlally.ai

Env on whichever host is live (see D):

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — as today
- `VITE_WAITLIST_URL` — optional; defaults to https://join.goxlally.ai
- `VITE_DEV_MOCK_OTP` — **must not be set** (and cannot take effect in a
  production build anyway; see the end)

Code to deploy (branch `claude/waitlist-gate` in ally-platform):

- `services/auth.js` — `shouldCreateUser: false`; an unapproved address gets
  "hasn't been approved … join the waitlist"
- `pages/guided/Login.jsx` — reads `#email=` from the invite link, "Join the
  waitlist" links
- `App.jsx` — the platform's own marketing landing is removed; `/` resumes a
  session if it can, then → `/app`, otherwise → `VITE_WAITLIST_URL`
  (join.goxlally.ai)

## D. Where the platform is actually served (checked 2026-09-03)

**Vercel.** `goxlally.ai` 308-redirects to `www.goxlally.ai`, which answers with
`Server: Vercel`; the live sign-in page renders the real email form (so the
Supabase env is present in that build) and `/api/v1/health` reaches the backend
through the `vercel.json` rewrite. The backend at `api.goxlally.ai` is the AWS
part. `.github/workflows/deploy-frontend.yml` still pushes every `main` push to
an S3 bucket with no Supabase env — that build is not what the domain serves,
so it can be ignored or removed.

Consequences: pushing `claude/waitlist-gate` gives a Vercel **preview
deployment** to test on. Preview builds only see variables scoped to
"Preview" in the Vercel project — check that `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` are set for Preview, not just Production, or the
preview's sign-in will be disabled.

## E. Backend — api.goxlally.ai

No change. `CORS_ORIGINS` does not need join.goxlally.ai: the landing site never
calls the API; it only creates the auth user in Supabase and links to the
platform.

## F. Smoke test in production, in this order

1. Register a test address on join.goxlally.ai → confirmation arrives; the
   notification arrives at `BETA_NOTIFY_EMAIL` with an Approve button.
2. Click Approve → confirm → "Approved". In Supabase → Authentication → Users
   the address now exists.
3. "You're in" arrives; its link opens goxlally.ai sign-in with the address
   filled in.
4. Send me a code → the 8-digit code arrives → set a password → onboarding.
5. Sign out. goxlally.ai/ → sign-in page. Email + password works.
6. Request a code for an address that never registered → "hasn't been
   approved … join the waitlist".
7. Open the Approve link again → "Already approved", with a Resend button.

## Local stand-in mode (what the flow was tested with)

With no `DATABASE_URL`, SMTP or Supabase variables and `NODE_ENV ≠ production`:

- registrations → `.dev/waitlist.json`; every email → `.dev/outbox.json`,
  browsable at `/dev/outbox` (404 in production)
- the Supabase step is skipped, with a warning on the Approved page
- on the platform, `VITE_DEV_MOCK_OTP=1` in `frontend/.env.local` mocks the
  code (`00000000`) with no backend. It is compiled out of production builds —
  verified by grepping `dist/` for every mock identifier after `vite build`
- start the landing dev server **from the project directory** (`npm run dev`);
  `.dev/` is created relative to the working directory
