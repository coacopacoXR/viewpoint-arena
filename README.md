# Viewpoint Arena

**Viewpoint Arena** is a minimalist simulation environment designed to study and demonstrate collaborative dynamics in 3D design reviews. Unlike standard CAD tools, this system focuses on **social presence**, **attention tracking**, and **AI-driven insight extraction**.

It simulates a multi-user environment where AI agents act as collaborators, allowing the user to evaluate how different viewpoint configurations affect communication and decision-making.

---

## 1. Viewpoint Configurations
The core of the application is the ability to switch between different "lenses" to view the collaborative session.

### 🕷️ Hybrid Split-Screen
*   **What it is:** A dual-viewport mode. The left half stays your own free view; the right half shows exactly what another person in the room is looking at.
*   **Use Case:** Keep your own context while seeing what a colleague is referring to.
*   **How to use:** Toggle Split Screen. It opens on the first other participant; pick someone else from the name badge over the right half. AI agents are only offered when agents are switched on.

### 🧠 AI-Guided Focus
*   **What it is:** An autonomous camera mode driven by a "Center of Attention" algorithm.
*   **How it works:** The system calculates where all agents are looking in real-time. The camera automatically drifts to frame the area of highest collective interest.
*   **Interaction:** You can override this manually by dragging the mouse. When you release, the AI gently takes control back after a short delay.
*   **Customization:** Use the slider overlay to weight specific agents (e.g., prioritize the "Design Lead" over the "Observer").

### 🔗 Sync / Leader Mode
*   **What it is:** One person drives the camera; everyone else's view follows theirs.
*   **Leading:** Press the Lead button. Everyone in the room starts following your view, and a badge above the dock shows who is following. When the last follower leaves, you drop back to free view.
*   **Following:** Dragging the camera does not leave the follow. You can look around, and about two seconds after you let go your view eases back to the leader's. The pill at the top says so. Only **Free view** actually leaves.
*   **Free view** orbits the model itself, including right after you stop following someone.

---

## 2. The Intelligence Layer (Conversation & Insights)
The right-hand panel serves as the cognitive engine of the review, transforming raw movement and inspection into structured engineering data.

### 💬 Live Transcript
*   **Function:** Displays a real-time stream of simulated dialogue based on what agents are inspecting.
*   **Context-Aware:** If an agent is inspecting the "Filter Knob," the dialogue will specifically reference geometry issues or assembly concerns related to that part.

### ⚡ AI Insights Deck
*   **Function:** An analysis layer that listens to the transcript and automatically extracts high-value information.
*   **Categories:**
    *   **⚠️ Risks:** Potential failure points, interferences, or material concerns.
    *   **🛡️ Rationale:** Why a specific design decision was made (e.g., "stress reduction").
    *   **✅ Actions:** Tasks that need to be assigned (e.g., "Verify clearance").
*   **Card Interaction:** Clicking a card opens a detailed **Engineering Record**. This is an interactive form where you can review Priority, Status, Assignees, and Mitigations.
*   **Integration:** Cards feature simulated export buttons for **Knowledge Base**, **Meeting Notes**, and **PLM** linking.

---

## 3. Visual Analysis Tools

### 👁️ Visual Grounding Aids
*   **Frustums:** Wireframe cones showing exactly what an agent's camera sees.
*   **Gaze Rays:** Dashed lines indicating the exact center of their focus.
*   **Ghost Trails:** Path lines that show where an agent has been, helping users predict movement or understand inspection patterns.

---

## 4. Interaction & Controls

*   **Orbit:** Left Click + Drag
*   **Pan:** Right Click + Drag (or Shift + Left Click)
*   **Zoom:** Scroll Wheel
*   **Possess Agent:** Click directly on any agent avatar to instantly jump into their body (POV mode).
*   **Agent Styles:** Toggle between Abstract Boxes (Screens), Capsules, or Robots to test how avatar fidelity impacts spatial awareness.

---

## Install it yourself

To run the whole app on your own computer with Docker (reviews, live rooms,
video calls, and meeting capture on your own hardware, no cloud accounts),
follow **[docs/INSTALL.md](docs/INSTALL.md)**: one installer, about 15 minutes.

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

## Tech Stack

*   **React 19**
*   **React Three Fiber (Three.js)**
*   **Zustand** (State Management)
*   **Tailwind CSS**
*   **Lucide React** (Icons)
*   **occt-import-js** (OpenCascade, WebAssembly) — STEP, IGES and BREP import; see [THIRD_PARTY.md](THIRD_PARTY.md)
