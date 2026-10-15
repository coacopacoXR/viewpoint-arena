# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Model imports are no longer capped at 50 MB for mesh formats: every supported
  format now has the same 200 MB limit, which is what the server and the proxy
  already accepted. A STEP, IGES or BREP file over 100 MB warns that opening it
  in the browser will be slow, instead of saying nothing until the three-minute
  reader timeout.

## [0.1.0] - Preview

The first public release. It is a preview: accounts, variants and backups are
new, so expect rough edges.

### Added

- **Design reviews around a live 3D model.** Import GLB, glTF, OBJ, FBX, STL,
  STEP, IGES or BREP files; point at parts, follow the presenter's view, and
  see where everyone is looking.
- **Sessions and variants.** Each meeting is a session on a review's main line.
  Explore a variant from any session, move parts with undo, then adopt it into
  the main line or drop it; the reasons are kept either way.
- **Meeting capture on your own hardware.** Speech is transcribed with Whisper
  and turned into risk, action and rationale cards by a local model (Ollama,
  qwen2.5:7b by default). Cloud providers can be chosen in the admin console.
- **Action tracker** across sessions and reviews, and meeting minutes.
- **Video calls** in the room (Boardroom view), with a bundled TURN relay.
- **Lobby** with saved reviews, previews and a live 3D look inside each one.
- **Sign-in options:** no accounts (optional front-door password), accounts on
  the install, or company single sign-on (Entra ID, Google, Keycloak). Hosts
  admit people into rooms.
- **Admin console:** reviews, people, AI provider settings, label fields and an
  activity record.
- **One-script install with Docker** (`install.sh`), including a Tailscale
  option for a real certificate, and automatic daily backups with a restore
  script.
- Connectors for Onshape, Teamcenter and Microsoft Teams/SharePoint
  notifications (bring your own accounts).

### Known limits

- Video calls across different networks need a TURN relay with a public
  address; this path is not yet verified under Docker Desktop.
- The default certificate is self-signed (one browser warning per device).
- No speaker separation in transcripts; the built-in 7B model writes weak
  minutes compared with a cloud model.
