# Auth0 in CanItWork: identity is what lets the agents run in public

CanItWork is a team of AI agents. Every new prompt sets off an Interpreter, an Architect, a Validator loop, a Reviewer and a Red Team, and a failure brings in a Recovery Council. Those calls go to Gemini and Swarms and cost real money: a Swarms build or recovery is about $0.03–0.04, and a build makes several Gemini calls on top.

So the hard question for a public deploy isn't "can people log in?" It's **who is allowed to make our agents spend money, and how much?** Auth0 is how CanItWork answers that. Without it, the agents can't be safely put in front of the public at all.

## The problem

- **Anyone with the URL can drive the agents.** A public link plus API keys means every visitor, scraper and script spends the team's Gemini and Swarms credits.
- **Limiting by IP address doesn't work.**
  - It's easy to dodge: change networks, use a VPN, or rotate addresses.
  - It hurts the wrong people: everyone behind one shared network, such as a hackathon venue, a school or an office, shares one allowance, so one heavy user locks the whole room out.
- **Turning the AI off for anonymous visitors kills the product.** The point of CanItWork is that the agents design what you describe. A keyless demo can only replay templates.
- **Shared runs need a real identity.** "Share this run only with my teammate" means nothing unless the server knows, with proof, who is asking.

## What Auth0 does here

### 1. Signing in unlocks the agents (`REQUIRE_SIGN_IN=1`)

- With sign-in required, a guest's new build, chat or recovery is turned away *before anything is spent*.
- The refusal appears where the build would have been, with a **Sign in** button. Signing in goes through Auth0's Universal Login and comes back to the run that was open.
- Guests keep everything that costs nothing: the verified example designs rebuild from the cache with no model calls, and shared links replay in the browser. A visitor sees the product working before being asked for anything.
- `GUEST_LIMIT_PER_HOUR=N` gives guests N free AI builds an hour first, for a softer funnel.

### 2. Limits follow the person, not the network

- `RATE_LIMIT_PER_HOUR` counts a signed-in person by their Auth0 user ID (`sub`), not their IP address.
- Switching Wi-Fi or using a VPN doesn't reset an account's allowance.
- Ten people on one venue network each get their own.
- When someone hits the limit, the refusal says how long until they can build again.

### 3. Runs are private or shared by verified identity

- Signed-in people save runs to their account and choose who can open each one: anyone with the link, only themselves, or people they name by email.
- A run shared with an address opens only for an Auth0 account whose email is **verified**. Signing up with someone else's address unverified gets you nothing. A test covers exactly that attack.
- "My systems" lists a person's saved runs with their sharing settings, links and a delete button.

### 4. Live sessions show who did what

- In a live session, everyone sees each break, fix and switch flip as it happens.
- Signed-in people appear by their Auth0 name and picture; everyone else as "Guest 2", "Guest 3" and so on.
- When the Recovery Council's fix is applied, the room sees who applied it.

## Why it matters

- **Agents are the expensive part of an AI product, and identity is the throttle.** Every agent product that goes public hits this: the model bill grows with traffic it can't attribute. Tying agent spend to an authenticated identity is what makes a public AI app affordable to run.
- **It's enforced on the server, not hidden in the UI.** The browser sends its Auth0 access token with each agent request. The server verifies it against the tenant's published keys, or asks Auth0's `/userinfo` when no API is configured, before any model is called. A request with a missing or forged token is a guest, and the guest rules apply.
- **It keeps the front door open.** Examples and shared links stay free and anonymous, so sign-in is asked for at the moment it means something: when a visitor wants the agents to work for them.
- **It turns sharing into access control.** Verified email is the difference between "unlisted" and "only Alice can open this".
- **It can be switched off.** Without an Auth0 tenant, sign-in disappears and the app works exactly as before, so local development and keyless demos need no setup.

## How it works

```
browser ── Auth0 Universal Login ──▶ access token
   │
   └─ POST /api/build  (Authorization: Bearer <token>)
          │
          ▼
      admit()  apps/server/src/integrations/limit.ts
          ├─ token valid?        ─ yes ─▶ count against RATE_LIMIT_PER_HOUR for user:<sub>
          ├─ REQUIRE_SIGN_IN on? ─ yes ─▶ guest allowance left? else refuse with { signIn: true }
          └─ otherwise           ───────▶ count against RATE_LIMIT_PER_HOUR for the IP
          │
          ▼
      allowed ─▶ Interpreter ▶ Architect ▶ Validator ▶ Reviewer ▶ Red Team   (Gemini, Swarms)
      refused ─▶ the app shows why, with a Sign in button when signing in would help
```

| Piece | Where |
|---|---|
| Token checks: local verification against the tenant's keys, or Auth0 `/userinfo` when no API is set | `apps/server/src/auth.ts` |
| The gate in front of every request that spends credits | `apps/server/src/integrations/limit.ts` (`admit`), used by `limited()` in `apps/server/src/index.ts` |
| Saved runs, sharing by verified email, My systems | `apps/server/src/runs.ts`, `apps/web/src/ui/Account.tsx` |
| Live-session identity | `apps/server/src/rooms.ts` |
| Browser sign-in, lazy-loaded Auth0 SDK, token on agent requests | `apps/web/src/auth.ts`, `apps/web/src/actions.ts` |
| Tests | `apps/server/test/limit.test.ts` (gate), `apps/server/test/runs.test.ts` (sharing), `apps/server/test/rooms.test.ts` |

The tests sign their own tokens with a local key pair. They cover:
- a guest is refused with a sign-in offer, and a signed-in person gets through;
- a forged token counts as a guest;
- guests get their allowance, then are asked to sign in;
- an account keeps its count across addresses, while two accounts on one address don't share one;
- the gate turns itself off when no tenant is configured;
- a run shared by email opens only for a verified email.

## Set it up

1. In Auth0, create a **Single Page Application**. Add where the app runs, such as `http://localhost:5173`, to its allowed callback, logout and web origin URLs.
2. Optionally, create an **API**, and use its identifier as `AUTH0_AUDIENCE`. The server then checks tokens locally instead of asking Auth0 once per sign-in.
3. Set these in `.env` (the server re-reads it on every request):

```
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=...
AUTH0_AUDIENCE=            # optional
REQUIRE_SIGN_IN=1          # only signed-in people can make the agents spend credits
GUEST_LIMIT_PER_HOUR=      # optional: free AI builds a guest gets first
RATE_LIMIT_PER_HOUR=20     # per account when signed in, per address otherwise
```

No client secret is needed: the browser uses PKCE, and the domain and client ID are public.

## Show it in a demo (about 30 seconds)

1. Signed out, type a new prompt, such as "a tiny widget with three gears". It's refused with **Sign in**, and nothing was spent.
2. Click an example. It still builds instantly, because verified designs are free for everyone.
3. Sign in and send the same prompt. The agents run, and the trace shows each one working.
4. Share the run with "People I choose" and a teammate's email. Opening the link signed out, or as a different account, is refused.

> "Our agents cost money every time they think. Auth0 decides who gets to make them think."

## Next

Not built yet, but where Auth0 fits next as the agents do more:

- **Machine-to-machine clients for outside agents.** Another team's agent could call CanItWork's design pipeline with its own client credentials and its own quota.
- **Auth0 for AI Agents.**
  - **Token Vault** would let the agents act in a user's own accounts, such as pushing a design to their GitHub, without ever holding the tokens.
  - **Async authorization (CIBA)** would ask the user to approve an agent's high-impact action, such as applying a fix in a live session others are watching.
- **Quotas per plan.** Roles or app metadata on the Auth0 user could give a team or classroom a bigger allowance.
