# Viewpoint Arena

**Viewpoint Arena** is a self-hosted room for reviewing a 3D model together.
A small team opens the same model, points at parts, follows each other's view
and talks it through; the meeting is transcribed and turned into risk, action
and rationale cards on your own hardware.

It runs with Docker on one machine: one install script, no cloud accounts.

> **Status: 0.1.0 preview.** Accounts, variants and backups are new, so expect
> rough edges. See [CHANGELOG.md](CHANGELOG.md) for what is in it and its known
> limits.

---

## Install it yourself

Follow **[docs/INSTALL.md](docs/INSTALL.md)**: one installer (`install.sh`),
about 15 minutes. It sets up the app, the live room server, the database and
local meeting capture with Docker Compose.

| | Minimum | Comfortable |
|---|---|---|
| Memory | 16 GB | 32 GB |
| Processor | 4 cores | 8+ cores |
| Graphics card | not needed | an NVIDIA card with 8 GB+ for fast meeting capture |

Tested on Windows 11 with WSL2 and Docker Desktop; Linux works the same way.

---

## What it does

### Review a live 3D model
*   Import **GLB, glTF, OBJ, FBX, STL, STEP, IGES or BREP** files. STEP, IGES
    and BREP go through OpenCascade compiled to WebAssembly, in the browser.
*   Point at parts, pin comments to them, and see where everyone is looking.
*   **Sessions and variants.** Each meeting is a session on a review's main
    line. Explore a variant from any session, move parts with undo, then adopt
    it into the main line or drop it; the reasons are kept either way.

### Meeting capture on your own hardware
*   The browser records the meeting in short clips and sends them to the
    install. **Whisper** transcribes them and a local model through **Ollama**
    (`qwen2.5:7b` by default) turns them into cards:
    *   **⚠️ Risks:** failure points, interferences, material concerns.
    *   **🛡️ Rationale:** why a design decision was made.
    *   **✅ Actions:** tasks with an assignee and a due date.
*   Clicking a card opens its record: priority, status, assignees, mitigations.
*   An **action tracker** follows open actions across sessions and reviews,
    and each meeting gets minutes.
*   Nothing leaves the machine in a default install. OpenAI or Anthropic can be
    chosen instead in the admin console.

### Meet in the room
*   **Video calls** in the Boardroom view, with a bundled TURN relay.
*   **Lobby** with saved reviews, previews and a live 3D look inside each one.
*   **Sign-in options:** no accounts (optional front-door password), accounts
    on the install, or company single sign-on (Entra ID, Google, Keycloak).
    Hosts admit people into rooms.
*   **Admin console:** reviews, people, AI provider settings, label fields and
    an activity record.
*   Automatic daily **backups** with a restore script.
*   Connectors for **Onshape**, **Teamcenter** and **Microsoft
    Teams/SharePoint** notifications (bring your own accounts).

---

## Ways to look at the model

### 🔗 Lead and follow
*   **Leading:** Press the Lead button. Everyone in the room starts following
    your view, and a badge above the dock shows who is following. When the last
    follower leaves, you drop back to free view.
*   **Following:** Dragging the camera does not leave the follow. You can look
    around, and about two seconds after you let go your view eases back to the
    leader's. The pill at the top says so. Only **Free view** actually leaves.
*   **Free view** orbits the model itself, including right after you stop
    following someone.

### 🕷️ Split screen
*   The left half stays your own free view; the right half shows exactly what
    another person in the room is looking at, so you can check what a colleague
    means without losing your own place.
*   It opens on the first other participant; pick someone else from the name
    badge over the right half.

### 🧠 AI-guided focus
*   The camera drifts to frame the area most people are looking at. Drag to
    take over; it gently takes control back after a short delay. A slider
    overlay weights some people more than others.

### 🤖 Demo agents
*   Four scripted agents can be switched on with the **AGENTS** toggle in the
    room (bottom left) to demonstrate the view modes without other people.
    They are off by default. Their visual aids show what each one sees
    (view cones) and where it is looking. Click an agent to jump into its view.

---

## Controls

*   **Orbit:** Left Click + Drag
*   **Pan:** Right Click + Drag (or Shift + Left Click)
*   **Zoom:** Scroll Wheel

---

## Configuration

Viewpoint Arena uses a two-layer configuration system:

1. **`viewpoint.config.ts`** (primary interface) — declares which connector
   providers are active (PLM, capture, TURN, database, notifications, model
   import) and their non-secret settings (base URLs, model names, feature
   flags). See `viewpoint.config.example.ts` for a template.
2. **`.env`** (credential store) — holds the secret values that the config
   file references by environment-variable name. Copy `.env.example` as a
   starting point; it documents every variable, grouped by connector, with
   server-only vs. public labels.

The browser never imports the config file directly. It fetches the
non-secret subset at runtime from `GET /api/public-config`, so a single
built artifact works against any deployment's config.

**Hosts without a config file (Vercel, other serverless hosts).** The config
file is git-ignored, so a deploy from git does not have it. Put the same
settings in the `VIEWPOINT_CONFIG` environment variable instead, as JSON:

```bash
npm run config:json      # prints your viewpoint.config.ts as one line of JSON
```

Paste the output into `VIEWPOINT_CONFIG` in the host's environment settings,
next to the secrets it names. It holds no secrets itself (the config only
names the variables that do), and it goes through the same validation as the
file. When both exist, the variable wins and the server logs that once.
`GET /api/health` reports which one was used (`configSource`).

**Capping what cloud AI capture can spend.** With the OpenAI or Anthropic
capture options, every extraction is a paid API call. The app bounds each
single call (transcript size and answer length), and the self-hosted proxy
limits each address to 30 capture requests a minute, but nothing in the app
caps the total. Set that ceiling where it cannot be bypassed: a monthly budget
on the API key's project (OpenAI) or a spend limit on its workspace
(Anthropic). On Vercel, where the self-hosted proxy is absent, add a rate
limit rule for `/api/capture/` in the project's Firewall settings as well.

---

## Tech stack

*   **React 19**, **React Three Fiber (three.js)**, **Zustand**, **Tailwind CSS**
*   **PartyKit** for live rooms (presence, follow and admission)
*   **Supabase / Postgres** for reviews, accounts and records
*   **Whisper** and **Ollama** in a Python capture service
*   **occt-import-js** (OpenCascade, WebAssembly) for STEP, IGES and BREP
    import; see [THIRD_PARTY.md](THIRD_PARTY.md)

---

## Contributing, security and license

*   [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build and test it.
*   Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
*   Licensed under the [Apache License 2.0](LICENSE).
