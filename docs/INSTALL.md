# Installing Viewpoint Arena on your own computer

This guide sets up the whole app on one machine with Docker: the 3D review
rooms, live collaboration, saved reviews, the action tracker, video calls, and
(optionally) meeting capture that runs entirely on your own hardware, with no
cloud AI and no accounts anywhere.

It was written by walking through it on Windows 11 with WSL2 and Docker
Desktop. Linux works the same way from step 3 on. macOS should work the same
way too but has not been tested.

---

## 1. What you need

| | Minimum | Comfortable |
|---|---|---|
| Memory | 16 GB | 32 GB |
| Free disk | 10 GB | 20 GB with local meeting capture |
| Processor | 4 cores | 8+ cores |
| Graphics card | not needed | an NVIDIA card with 8 GB+ for fast meeting capture |

Local meeting capture works without a graphics card, just slowly: a few
minutes per meeting instead of about 20 seconds. Everything else in the app
does not use the graphics card at all.

---

## 2. One-time setup (Windows)

Skip to step 3 on Linux; you need Docker Engine with the Compose plugin
(`docker compose version` must work) and `git`, `openssl` and `curl`.

**a. Turn on WSL2 (the Linux layer Docker runs on).** Open **PowerShell as
Administrator** (right-click the Start button → Terminal (Admin)) and run:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart the computer when it asks. After the restart an "Ubuntu" window opens
and asks you to pick a Linux user name and password; pick anything and
remember the password.

**b. Install Docker Desktop** from <https://www.docker.com/products/docker-desktop/>
and start it. Then in Docker Desktop open **Settings → Resources → WSL
integration**, switch on **Ubuntu-24.04**, and press **Apply & restart**.

**c. Check it works.** Open **Ubuntu** from the Start menu (every command from
here on goes in that Ubuntu window, not in PowerShell) and run:

```bash
docker run --rm hello-world
```

You should see "Hello from Docker!".

**d. Only if you have an NVIDIA graphics card:** keep your normal Windows
NVIDIA driver up to date; nothing else is needed on Windows. Check that
Docker can see the card:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

It should print a table naming your card. If it fails, answer **no** to the
graphics card question in step 4; capture will still work, just more slowly.

---

## 3. Get the code

In the Ubuntu window:

```bash
git clone https://github.com/coacopacoXR/viewpoint-arena.git ~/viewpoint-arena
cd ~/viewpoint-arena
```

(One line on purpose: a command split with a backslash breaks when copying
adds a space after it.)

Keep it in your Linux home folder (`~`) as above, not under `/mnt/c/...`:
the Windows drive is several times slower for Docker builds.

---

## 4. Run the installer

```bash
./install.sh
```

It asks a few questions. Pressing **Enter** takes the suggested answer shown
in brackets, and every suggested answer works. The ones worth thinking about:

| Question | What to answer |
|---|---|
| How will people reach it | **Enter** (`self-signed`) to use this computer's name or network address; browsers show a certificate warning once per device. **`tailscale`** for a proper address like `https://viewpoint.tail1a2b3c.ts.net` with a real certificate: no warnings, and it works from home or another office too. See **[5b. A real address with Tailscale](#5b-a-real-address-with-tailscale)** first; the installer then asks for the machine name, your tailnet's name and an auth key, and skips the hostname question. |
| Who will open the app | **Enter** (`this-computer`) if only this computer will use it: the address is `https://localhost`. **`network`** to let a phone or colleagues on the same network join: the installer shows this computer's network address (e.g. `192.168.1.50`) and uses it. **`name`** only if your company network already has a name for this computer. Don't make up a name: the installer refuses one that no browser could find. |
| Meeting capture | **`local`** to record meetings and get cards from AI on your own hardware (downloads about 5 GB once). **Enter** (`mock`) for a quick look with simulated cards and no download. |
| Database | **Enter** (bundled). |
| TURN relay | **Enter** (bundled). |
| GPU compose override | **yes** only if the `nvidia-smi` check in step 2d worked. |

After the last question it shows your answers and asks **"Write these settings
and build now?"**. Press **Enter** to go ahead, or **n** to stop without
changing anything and start again. (**Ctrl+C** also stops it at any question.)

Then it builds and starts everything. The first run takes 5 to 15 minutes
(most of it is downloading; with `local` capture, add the AI model download).
It finishes with a box that says where to open it:

```
══════════════════════════════════════════════════════════════════
  Viewpoint Arena is running. Open it at:

      https://localhost/
  ...
```

If instead it stops with an error, see **Troubleshooting** below; every exit
explains what to change.

---

## 5. Open the app

Go to **<https://localhost/>** in Chrome or Edge on the same computer (or
`https://<the address you typed>/` from another computer on your network).

You will see a certificate warning, because the installer made its own
certificate instead of buying one. Click **Advanced → Continue to localhost
(unsafe)**. This is expected and only needed once per browser. To get rid of
it, use Tailscale (next section).

---

## 5b. A real address with Tailscale

With this option the app gets an address like
`https://viewpoint.tail1a2b3c.ts.net` and a real certificate, so no device shows
a warning. It also works away from the office network: anyone on your tailnet
can join from home, and video calls go directly between their devices.

[Tailscale](https://tailscale.com) is a free (for small teams) private network
between your own devices. The catch: **everyone who opens the app needs the
Tailscale app**, signed in to your tailnet. For a team that already uses it, or
for a small group you invite, that is two minutes per person.

Before running the installer:

1. Create a Tailscale account at <https://login.tailscale.com> and install the
   Tailscale app on your own computer.
2. In the admin console, **DNS**: turn on **MagicDNS** and **HTTPS
   Certificates**. Note the **tailnet DNS name** at the top of that page; it
   looks like `tail1a2b3c.ts.net`.
3. **Settings → Keys → Generate auth key**. Leave "Ephemeral" off. Copy the key
   (it starts with `tskey-auth-`); it is only shown once.

Then run `./install.sh`, choose **`tailscale`** at the first question, and give
it a machine name (Enter for `viewpoint`), the tailnet DNS name and the key. The
installer adds a small `tailscale` container that joins your tailnet under that
name, gets the certificate, renews it by itself, and passes the traffic to the
app. Nothing is opened to the internet.

Open `https://viewpoint.<your tailnet>.ts.net/` on any device with Tailscale.
The very first visit can take up to a minute while the certificate is fetched.

To let someone in: invite them to your tailnet from the admin console
(**Users → Invite**), or share just this one machine with them (**Machines →
viewpoint → Share**). They install the Tailscale app and sign in.

If the container shows "auth key expired" in `docker compose logs tailscale`,
generate a new key, re-run `./install.sh` and paste it. Once the machine has
joined, the key is no longer used.

---

## 6. Try each feature

**A design review (the database).**
In the lobby, type your name under **Your name**. Press **+ New design
review**, give it a name (e.g. "Hinge test") and press **Create**. The review
room opens in **edit mode**, with a yellow bar at the top. Press **Import a
model** to open your own file, or **Try a sample → Synth assembly**. Then press
**Done** (right end of the yellow bar) to start the meeting. The Share, People
and Boardroom buttons only appear after Done.

Press **← Lobby** (top left): your review is listed with a picture of its
model. Reload the page; it is still there.

**Live collaboration.**
In the room, press **Share**. It opens on a QR code for phones; the **Copy
link** tab has the link. Paste the link into a private/incognito window (or a
browser on another computer), type a different name and join. That window
says **"Waiting for the host to let you in."** In the host window, a **Waiting
to join** box appears: press **Admit**. Press **People** to see each other
listed.

**Video call.**
In the host window press **Boardroom** (a monitor icon when the window is
narrow). After a short countdown, both windows switch to the call view; allow
camera and microphone when the browser asks. Press **3D Arena** to go back.

**Meeting capture** (only with `local` capture).
In the host window, on the right, find the **Live transcript** panel and press
**Record**. Unmute your microphone (the red microphone button at the bottom),
then talk for half a minute about the design, for example: "Maria will
increase the clearance to one millimetre and send the model to the supplier by
Friday. The main risk is thermal expansion rubbing the headband." Your words
appear in the transcript, about 10 seconds behind. Press **Stop**, then
**Generate cards**. After a wait (about a minute with a graphics card, several
minutes without) the panel says **"3 insights added"** (or however many) and
the cards appear under **Detected insights** as risks,
actions and rationale that you can approve, reject or edit. Wait until
"Generating cards…" is gone before you end the meeting.

**Tracker.**
Press the red power button at the bottom (**End Session**): the meeting
summary opens and the meeting's cards are sent to the tracker. Press **Open
Tracker →** there, or **Tracker** in the lobby, to see every ended meeting and
its cards across reviews. (The tracker stays empty until a meeting with at
least one card has ended.)

**Health check.** `https://localhost/api/health` shows, for each part of the
system, whether it is working.

---

## 6b. Running it on a server, for a team

Nothing is installed on anyone's laptop. The machine running Docker does all
the work; everyone else just opens it in a browser:

- the browsers record audio and send short clips to that machine;
- **transcription (Whisper) and the AI extraction (qwen2.5:7b) run there**,
  on its CPU and GPU;
- the text, the cards and the database live there too.

So put it on the beefiest machine available, not on the laptop of whoever
chairs the meeting. On that machine: install Docker, follow steps 3 and 4,
and answer its **network address** (or DNS name) at the hostname question.
Everyone opens `https://<that address>/`. A GPU in the server speeds up
extraction for everybody; laptops only record and display.

What the server needs open to the people using it: **443** (the app),
**8443** (live rooms) and, if calls cross networks, **3478** plus the relay
range for TURN. What it does NOT need: any inbound connection to the
participants' machines.

Nothing leaves that machine in a default install. Audio clips, transcripts,
cards and the database all stay on it; data only goes outside if you choose a
cloud option during install (OpenAI/Anthropic extraction, Cloudflare TURN, a
Teams webhook).

One current limit: only the host's browser records, mixing their microphone
with the call audio, so remote voices arrive through the call rather than
from each person's own microphone.

---

## 7. Everyday commands

Run these in the Ubuntu window from `~/viewpoint-arena`:

| To | Run |
|---|---|
| See what is running | `docker compose ps` |
| Stop everything (keeps all your data) | `docker compose stop` |
| Start it again | `docker compose up -d` |
| Read a part's log | `docker compose logs --tail 50 <name>`, e.g. `capture-service`, `api`, `db` |
| Change a setting | `./install.sh` again (see below) |

Docker Desktop must be running for any of these. It starts with Windows by
default; the app comes back on its own when Docker does.

**Changing settings.** Run `./install.sh` again and answer differently, e.g.
`local` instead of `mock` for capture. It is safe to repeat: your saved
reviews, the database password and the downloaded AI model are kept, and the
old settings files are backed up next to the new ones
(`.env.backup.<date>`).

---

## 7b. Backups and restore

The install backs itself up. The `db-backup` service writes, every 24 hours and
once when it starts:

- `db-YYYYMMDD-HHMMSS.sql.gz`: the whole database (reviews, meetings, cards,
  accounts);
- `models-YYYYMMDD-HHMMSS.tar.gz`: the imported 3D model files.

They go into the `db-backups` Docker volume, and the newest 14 of each are kept.
Change that in `.env`: `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`, and
`BACKUP_MODELS=false` to skip the model files. Then run `docker compose up -d`.

**Check it is working:** `docker compose logs db-backup` prints one
`backup ok: …` line per file. The admin console's health, and
`https://<your-address>/api/health`, report `backup: ok` while the newest backup
is recent.

**Copy them off the machine.** A backup on the same disk does not survive the
disk. For example, copy them to the current folder:

```bash
docker compose run --rm --no-deps -v "$PWD":/out --entrypoint sh db-backup -c 'cp /backups/* /out/'
```

**Restore** (this replaces the current database with the backup's):

```bash
docker compose run --rm --no-deps --entrypoint sh db-backup -c 'ls -1 /backups'   # pick one
deploy/backup/restore.sh db-20260926-020000.sql.gz --yes
```

## 8. Reset or remove

| To | Run |
|---|---|
| Remove the app but keep your data | `docker compose down` |
| **Delete everything, including all saved reviews and the AI model** | `docker compose down -v` |
| Also free the disk space used by the downloaded images | `docker system prune -a` (removes ALL unused Docker images on this computer, not only this app's) |

After `down -v`, `./install.sh` starts again from a clean slate.

---

## 9. Troubleshooting

| What you see | What it means and what to do |
|---|---|
| Installer exits with **"A port the stack needs is already in use"** (exit 5) | Another program uses port 80, 443 or 8443 (often IIS, Skype, or another web server). Stop that program, or set `HTTP_PORT` / `HTTPS_PORT` / `WSS_PORT` in `.env` to free numbers and run `./install.sh` again. |
| Installer ends with **"The stack did not answer"** (exit 4) | Something failed to start. `docker compose ps` shows which part is not "healthy"; `docker compose logs <name>` says why. |
| **"Permission denied"** on `./install.sh` | Run `chmod +x install.sh` once. |
| Browser says **"This site can't be reached"** | Docker Desktop is not running, or the stack is stopped: `docker compose up -d`. |
| Meeting capture says **"returned 504 (capture_upstream_timeout)"** | The AI model took longer than 10 minutes. Usually the graphics card is too small or busy: on a laptop, the screen and open apps share its memory. Close heavy apps (browsers with many tabs, games, video editors) and try again, or use a smaller model (`CAPTURE_OLLAMA_MODEL` in `.env`, then `docker compose up -d`). |
| Capture says **"transcriber_unavailable"** | `docker compose logs capture-service` names the cause. The first recording downloads the speech model (~150 MB), so the computer needs internet that first time. |
| Colleagues on the network cannot join | Use this computer's network address as the hostname (step 4), not `localhost`, and allow ports 443 and 8443 through the Windows firewall. |
| A video call connects only on the same network | See **Known limits** below. |

---

## 10. Known limits

- **Same network only.** A phone or colleague must be on the same local
  network as this machine. The share link (SHARE → QR / Copy Link) contains
  the hostname you gave the installer; if that is `localhost`, only this
  computer can open it. Re-run `./install.sh` and enter the machine's network
  address (e.g. `192.168.1.50`) to fix it. For access from other networks,
  use the `tailscale` choice (section 5b): everyone on your tailnet can join,
  wherever they are.
- **One certificate warning per device**, with the default `self-signed`
  choice. Every browser and every phone that opens the app for the first time
  shows a certificate warning that must be clicked through once. The
  `tailscale` choice (section 5b) removes it, and so does mounting your own
  certificate (`own`). A company-domain option with Let's Encrypt is planned.
- **Video calls across the internet.** Two people on the same network, or on
  the same computer, connect directly, and that is tested. For people on
  different networks the call relays through the bundled TURN server, and
  that path has **not** been verified under Docker Desktop, whose network
  forwarding gets in the way. For calls between offices, run the stack on a
  Linux server with a public address and set `TURN_EXTERNAL_IP` in `.env` to
  it, or choose the Cloudflare TURN option in the installer.
- **The graphics card on a laptop** also drives the screen, so open apps
  leave less room for the AI model and capture gets slower (see
  Troubleshooting).
- **Onshape, Teamcenter and Microsoft Teams** connections need your own
  accounts and keys; the installer asks for them if you pick those options.
- **Sign-in is your choice.** `./install.sh` asks "How do people sign in?":
  1. **No accounts** (the default). Names are typed in the lobby. Access is
     the three things listed below.
  2. **Accounts on this install**: email and password. You choose whether
     anyone can create an account or only people you add. There is no mail
     server in the stack, so accounts are confirmed at once and there is no
     "forgot password" email yet.
  3. **Company single sign-on**: Microsoft Entra ID, Google or Keycloak (any
     OpenID Connect provider through Keycloak's settings). Register the app
     with your provider using the redirect address
     `https://<your address>/auth/v1/callback`. SAML (Okta, ADFS) is planned.

  With 2 or 3, signing in replaces the front-door password. The name people
  see in a room comes from the account and is checked by the room server, so
  it cannot be faked. Each person gets a **Your reviews** list in the lobby
  showing the reviews they hosted or joined. You can also let people without
  an account join a room as a **guest**: they knock like anyone else, show as
  "Name (guest)", and can only enter the room they were invited to. Under the
  hood this is Supabase's sign-in service (GoTrue), which runs only when 2 or
  3 is chosen.

  **Without accounts**, access is three separate things, and it is worth
  knowing which one does what:
  - **The front-door password** (asked by `./install.sh`, stored as a hash in
    `ACCESS_PASSWORD_HASH`). Optional and empty by default, which leaves the
    app open exactly as before. It is one password for everyone, not
    per-person accounts: anyone with it gets in, and the app cannot tell one
    person from another. Names in a meeting are self-asserted. A deployment
    that needs real identity should sit behind its own SSO proxy.
  - **The room door.** By default someone opening a room link waits until the
    host admits them ("Maria wants to join — Admit / Decline"). The host can
    switch a link to *Anyone with the link* from the invite popup. Until
    someone is admitted the server sends them nothing about the room — not
    the model, not the comments, not the transcript. A room with nobody left
    in it admits the next person to knock, so an empty room never locks
    itself, and reloading the page does not put you back in the queue.
  - **The admin passphrase** (also `./install.sh`, `ADMIN_PASSPHRASE_HASH`).
    Optional. When set, `/admin` manages every review on the install — show
    or hide it in the lobby, delete it — and the label fields. When it is not
    set, `/admin` is closed rather than open. Changing either password means
    re-running `./install.sh`; there is no button for it, because rotating a
    secret means rewriting `.env` and restarting the API container.
  - **Activity.** The admin screen also lists who admitted whom, who was
    refused, and who changed a link's join policy — grants only, nothing
    about what was said or shown in a meeting. It is a record of what the app
    did, not a tamper-proof ledger, and the names in it are self-asserted.
- **A review can be hidden from the lobby.** On the curate page, *Link only*
  keeps a review out of Saved Reviews while its link keeps working — useful
  when a deployment is shared by several teams.
